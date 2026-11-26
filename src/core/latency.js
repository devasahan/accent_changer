/**
 * How late the converted voice comes back, followed through a whole call.
 *
 * Runs on the main thread. The safety mixer sends loudness envelopes (dB, one
 * frame every `hopMs`) of the original (mic) and of the converted voice side
 * by side: frame n of both was heard at the same moment, so the converted
 * copy of original frame n arrives at frame n + D / hopMs. Every few seconds
 * the tracker compares the last `windowSec` of both with
 * estimateDelayFromEnvelopes and keeps D, the delay the mixer and its stall
 * detector work with, plus the history behind the lip-sync delay.
 *
 * Until it has a delay it searches the whole range; then only a narrow window
 * around D, which is cheaper. The stall detector expects the converted voice
 * within ±40 ms of D, so D must neither jump on one odd window nor wander:
 * - A narrow-window result is taken only when it looks like the same peak as
 *   before. One at the window's edge (a slope, not a peak), untrusted, or
 *   scoring far below the recent estimates (the delay jumped and the window
 *   now holds a look-alike) is checked at once with a whole-range search.
 *   Taking such results instead walks D, window by window, to a delay that
 *   is neither the old one nor the new one.
 * - D moves farther than the narrow window only when three whole-range
 *   searches in a row agree on the new delay. Two are not enough: windows
 *   3 s apart share 9 s of audio, so two of them often agree on the same
 *   look-alike when the engine sends something unrelated.
 * - After three untrusted estimates in a row it searches only the whole range
 *   until a trusted one comes.
 * After a reconnect, relock() finds a new delay within one estimate instead.
 *
 * Pure: no clock and no timers. Time is the number of frames pushed.
 */

import { estimateDelayFromEnvelopes, median, percentile } from "./delay-estimate.js";

/** Level of digital silence in envelopeDb; lower levels and non-numbers (a NaN from a bad block) count as this. */
const SILENCE_DB = -120;

/**
 * New frames are worth measuring only when the original has sound in them: a
 * frame above SOUND_MIN_DB and SOUND_RANGE_DB above the quietest frame of the
 * window (the bar hasSignal sets for a whole recording). While the user
 * listens to the interviewer the window still holds speech that was measured
 * already; measuring it again adds nothing and costs a few ms each time. The
 * converted window must pass the same bar as a whole (its loudest and
 * quietest frames, so it never refuses what hasSignal would accept), else
 * there is nothing to compare: the engine is silent.
 */
const SOUND_MIN_DB = -70;
const SOUND_RANGE_DB = 15;

/** Recent accepted scores that set what "far below the recent estimates" means. */
const SCORES_KEPT = 5;

/** A dB value as the window stores it. */
function clean(v) {
  return v > SILENCE_DB && v < Infinity ? v : SILENCE_DB;
}

/**
 * Follows D, the delay of the converted voice behind the original, from
 * envelope frames pushed as they arrive. Call update() after each push; give
 * the mixer delayMs whenever it changes. Call relock() after the engine
 * reconnects (or the mixer reports a stall), when the delay may have jumped.
 */
export class LatencyTracker {
  /**
   * @param {object} [options]
   * @param {number} [options.hopMs=5] spacing of the envelope frames pushed
   * @param {number} [options.windowSec=12] each estimate compares this much of the most recent audio
   * @param {number} [options.everySec=3] an estimate runs once this much new audio has arrived
   * @param {number[]} [options.fullSearch=[-100, 1500]] delays (ms) the whole-range search covers
   * @param {number} [options.localSearchMs=60] once locked, the search covers only this much either side of D
   * @param {number} [options.minScore=0.3] estimates with a lower correlation score are not trusted
   * @param {number} [options.lowScoreLimit=3] untrusted estimates in a row before only the whole range is searched
   * @param {number} [options.dropRatio=0.75] a narrow-window score below this share of the recent ones is checked with a whole-range search
   * @param {number} [options.confirmMs=10] D moves beyond the narrow window only when whole-range estimates in a row agree this closely ...
   * @param {number} [options.confirmRuns=3] ... this many of them
   * @param {number} [options.maxHistory=1200] accepted estimates kept (an hour of talking at one every 3 s)
   * @param {Function} [options.estimate] the search: estimateDelayFromEnvelopes (tests pass a stand-in)
   */
  constructor({
    hopMs = 5,
    windowSec = 12,
    everySec = 3,
    fullSearch = [-100, 1500],
    localSearchMs = 60,
    minScore = 0.3,
    lowScoreLimit = 3,
    dropRatio = 0.75,
    confirmMs = 10,
    confirmRuns = 3,
    maxHistory = 1200,
    estimate = estimateDelayFromEnvelopes,
  } = {}) {
    if (!(hopMs > 0)) throw new RangeError(`hopMs must be positive, got ${hopMs}`);
    if (!(fullSearch[0] < fullSearch[1])) throw new RangeError(`fullSearch must be [min, max], got ${fullSearch}`);
    this.hopMs = hopMs;
    this.windowFrames = Math.max(2, Math.round((windowSec * 1000) / hopMs));
    this.everyFrames = Math.max(1, Math.round((everySec * 1000) / hopMs));
    this.fullSearch = [fullSearch[0], fullSearch[1]];
    this.localSearchMs = localSearchMs;
    this.minScore = minScore;
    this.lowScoreLimit = lowScoreLimit;
    this.dropRatio = dropRatio;
    this.confirmMs = confirmMs;
    this.confirmRuns = confirmRuns;
    this.maxHistory = maxHistory;
    this._estimate = estimate;
    // Ring buffers of the last windowFrames frames, and the window unrolled in time order for the search.
    this._orig = new Float32Array(this.windowFrames);
    this._conv = new Float32Array(this.windowFrames);
    this._a = new Float32Array(this.windowFrames);
    this._b = new Float32Array(this.windowFrames);
    this.reset();
  }

  /** Forget everything (a new call): no delay, no history. */
  reset() {
    this._write = 0; // next ring slot
    this._count = 0; // frames in the window
    this._frames = 0; // frames pushed in all (stream time)
    this._pending = 0; // frames pushed since the last estimate ran
    this._delay = null;
    this._history = [];
    this.relock();
  }

  /**
   * Look for the delay afresh, as at the start of a call: for after a
   * reconnect, when the delay may have jumped. The envelopes so far are
   * dropped, the next estimates search the whole range and the first trusted
   * one is taken at once. delayMs keeps its old value until then (the mixer
   * goes on with the best delay known), and the history stays.
   */
  relock() {
    this._count = 0;
    this._pending = 0;
    this._locked = false;
    this._low = 0; // untrusted estimates in a row while locked
    this._candidate = null; // { ms, runs }: a far delay whole-range searches found, waiting for confirmRuns in a row
    this._scores = []; // scores of the last accepted estimates at this delay
  }

  /**
   * Append envelope frames (dB, hopMs apart): the original's and the
   * converted voice's for the same moments, so the same number of each
   * (Float32Arrays or plain arrays). Values below -120 dB, NaN and infinities
   * count as digital silence.
   */
  push(origDb, convDb) {
    const n = origDb.length;
    if (convDb.length !== n) {
      // Dropping frames from one side only would shift the two apart for good: refuse instead.
      throw new RangeError(`push: ${n} original frames but ${convDb.length} converted frames`);
    }
    const cap = this.windowFrames;
    let w = this._write;
    for (let i = Math.max(0, n - cap); i < n; i++) {
      this._orig[w] = clean(origDb[i]);
      this._conv[w] = clean(convDb[i]);
      if (++w === cap) w = 0;
    }
    this._write = w;
    this._count = Math.min(cap, this._count + n);
    this._frames += n;
    this._pending += n;
  }

  /**
   * Run an estimate if everySec of new frames arrived since the last one and
   * the original had sound in them. Returns null when nothing ran or there
   * was nothing to compare (no speech-like signal on one side), else
   * { ms, score, method, accepted }: the delay found (whole ms), its
   * correlation score, the search that found it ("full" or "local") and
   * whether it was taken as D. A result with accepted false left D as it
   * was: give the mixer delayMs, not ms.
   */
  update() {
    if (this._pending < this.everyFrames) return null;
    const n = this._count;
    const fresh = Math.min(this._pending, n);
    this._pending = 0;

    // Unroll the ring into time order, noting the levels the sound checks need.
    const cap = this.windowFrames;
    const a = this._a;
    const b = this._b;
    let r = (this._write - n + cap) % cap;
    let floor = Infinity;
    let freshPeak = -Infinity;
    let convMin = Infinity;
    let convMax = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = this._orig[r];
      const y = this._conv[r];
      a[i] = x;
      b[i] = y;
      if (x < floor) floor = x;
      if (i >= n - fresh && x > freshPeak) freshPeak = x;
      if (y < convMin) convMin = y;
      if (y > convMax) convMax = y;
      if (++r === cap) r = 0;
    }
    if (!(freshPeak > SOUND_MIN_DB && freshPeak - floor > SOUND_RANGE_DB)) return null;
    if (!(convMax > SOUND_MIN_DB && convMax - convMin > SOUND_RANGE_DB)) return null;
    const orig = a.subarray(0, n);
    const conv = b.subarray(0, n);

    let method = "full";
    let est = null;
    if (this._locked && this._candidate === null && this._low < this.lowScoreLimit) {
      est = this._search(orig, conv, this._delay - this.localSearchMs, this._delay + this.localSearchMs);
      if (est === null) return null;
      // The whole range holds the narrow window, so its best match decides: the same peak, or one elsewhere.
      method = this._suspect(est) ? "full" : "local";
    }
    if (method === "full") {
      est = this._search(orig, conv, this.fullSearch[0], this.fullSearch[1]);
      if (est === null) return null;
    }

    let accepted = false;
    if (!(est.score >= this.minScore) || est.edge) {
      if (this._locked) this._low++;
      this._candidate = null; // confirmation needs trusted estimates in a row
    } else if (!this._locked || Math.abs(est.ms - this._delay) <= this.localSearchMs) {
      accepted = true;
    } else if (this._candidate !== null && Math.abs(est.ms - this._candidate.ms) <= this.confirmMs) {
      this._candidate.ms = est.ms;
      if (++this._candidate.runs >= this.confirmRuns) {
        this._scores = []; // a new delay: the old scores say nothing about it
        accepted = true;
      }
    } else {
      this._candidate = { ms: est.ms, runs: 1 };
    }
    if (accepted) this._accept(est);
    return { ms: est.ms, score: est.score, method, accepted };
  }

  /** One estimate over [loMs, hiMs]: { ms, score, edge }, edge when the best match is at (or past) either end. */
  _search(orig, conv, loMs, hiMs) {
    const est = this._estimate(orig, conv, this.hopMs, { minLagMs: loMs, maxLagMs: hiMs });
    if (!est) return null;
    const hop = this.hopMs;
    const lo = Math.round(loMs / hop) * hop; // the search steps in whole frames
    const hi = Math.round(hiMs / hop) * hop;
    return {
      ms: Math.round(est.lagMs) + 0, // + 0 turns -0 into 0
      score: est.score,
      edge: est.lagMs < lo + hop || est.lagMs > hi - hop,
    };
  }

  /** A narrow-window result that may not be the peak D was following. */
  _suspect(est) {
    if (est.edge || !(est.score >= this.minScore)) return true;
    return this._scores.length > 0 && est.score < this.dropRatio * median(this._scores);
  }

  _accept(est) {
    this._delay = est.ms;
    this._locked = true;
    this._low = 0;
    this._candidate = null;
    this._scores.push(est.score);
    if (this._scores.length > SCORES_KEPT) this._scores.shift();
    this._history.push(Object.freeze({ atSec: (this._frames * this.hopMs) / 1000, ms: est.ms, score: est.score }));
    if (this._history.length > this.maxHistory) this._history.shift();
  }

  /** Current D in ms (whole ms), null until the first lock. */
  get delayMs() {
    return this._delay;
  }

  /** True while D is followed with the narrow search (false before the first lock and after relock()). */
  get locked() {
    return this._locked;
  }

  /** Accepted estimates, oldest first: [{ atSec (stream time of the estimate), ms, score }]. A copy. */
  get history() {
    return this._history.slice();
  }

  /**
   * Total delay L for lip-sync mode: the 95th percentile of the accepted
   * delays plus `marginMs`, rounded up to a whole ms, capped at `maxMs` and
   * never below 0. Null with fewer than 5 accepted estimates.
   */
  lipSyncTotalMs({ marginMs = 30, maxMs = 800 } = {}) {
    if (this._history.length < 5) return null;
    const p95 = percentile(this._history.map((h) => h.ms), 95);
    // The epsilon keeps float noise in the interpolation (342.00000000000006) from adding a whole ms.
    return Math.min(maxMs, Math.max(0, Math.ceil(p95 + marginMs - 1e-6)));
  }
}
