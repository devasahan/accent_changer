/**
 * How late the converted voice comes back, followed through a whole call.
 *
 * Runs on the main thread. The safety mixer sends loudness envelopes (dB, one
 * frame every `hopMs`) of the original (mic) and of the converted voice side
 * by side: frame n of both was heard at the same moment, so the converted
 * copy of original frame n arrives at frame n + D / hopMs. Every few seconds
 * the tracker compares the most recent audio of both with
 * estimateDelayFromEnvelopes and keeps D, the delay the mixer and its stall
 * detector work with, plus the history behind the lip-sync delay.
 *
 * Until it has a delay it searches the whole range over the last `windowSec`.
 * Once it has one it compares only the last `trackSec`, mostly in a narrow
 * window around D, which is cheaper: a jitter buffer that grows or drains
 * moves the delay by tens of ms a second, and in a longer window the speech
 * at the old delay outvotes the new one for many seconds. The stall detector
 * expects the converted voice within ±40 ms of D, so D must neither jump on
 * one odd window nor wander:
 * - A narrow-window result is taken only when it looks like the same peak as
 *   before. One at the window's edge (a slope, not a peak), untrusted,
 *   scoring far below the recent estimates (the delay jumped and the window
 *   now holds a look-alike), or moving D more than SPARSE_MOVE_MS in a window
 *   with little speech (see SPARSE_SHARE) is checked at once with a
 *   whole-range search. Taking such results instead walks D, window by
 *   window, to a delay that is neither the old one nor the new one.
 * - A whole-range result near D that scores far below the recent estimates
 *   may confirm D but not move it: while the engine sends something
 *   unrelated, the best match near D is a look-alike.
 * - D moves farther than the narrow window only when three whole-range
 *   searches in a row agree on the new delay: two windows in a row share
 *   half their audio, so two of them can agree on the same look-alike when
 *   the engine sends something unrelated. Two are enough when the narrow
 *   window's best match had slid to its edge, toward a new peak that scores
 *   like the recent ones: the delay drifted out of the window.
 * - After three untrusted estimates in a row it searches only the whole range
 *   until a trusted one comes.
 * After a reconnect or a stall, relock() makes D follow every trusted
 * whole-range estimate until three in a row agree.
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

/** Original frames within this much of the window's loudest one count as speech (vowels, not the pauses' noise). */
const SPEECH_RANGE_DB = 30;

/**
 * A window with speech in less than this share of its frames holds little
 * speech: the first estimate after the user listened for a while sees a
 * short block of speech against silence, and that block lifts the score of
 * every lag near it. A side lobe then scores like the real peak, so a
 * narrow-window result from such a window that moves D more than
 * SPARSE_MOVE_MS is checked with a whole-range search. Smaller moves (a
 * jitter buffer adapting by 10 ms) are taken as usual: even a wrong one keeps
 * D well inside the stall detector's ±40 ms.
 */
const SPARSE_SHARE = 1 / 3;
const SPARSE_MOVE_MS = 20;

/** A dB value as the window stores it. */
function clean(v) {
  return v > SILENCE_DB && v < Infinity ? v : SILENCE_DB;
}

/**
 * Follows D, the delay of the converted voice behind the original, from
 * envelope frames pushed as they arrive. Call update() after each push; give
 * the mixer delayMs whenever it changes. Call relock() after the engine
 * reconnects or the mixer reports a stall, when the delay may have jumped or
 * may still be settling.
 */
export class LatencyTracker {
  /**
   * @param {object} [options]
   * @param {number} [options.hopMs=5] spacing of the envelope frames pushed
   * @param {number} [options.windowSec=12] until the first lock, each estimate compares this much of the most recent audio
   * @param {number} [options.trackSec=6] once a delay is known (and after relock()), this much: D follows a delay that moves
   * @param {number} [options.everySec=3] an estimate runs once this much new audio has arrived
   * @param {number[]} [options.fullSearch=[-100, 1500]] delays (ms) the whole-range search covers
   * @param {number} [options.localSearchMs=60] once locked, the search covers only this much either side of D
   * @param {number} [options.minScore=0.3] estimates with a lower correlation score are not trusted
   * @param {number} [options.lowScoreLimit=3] untrusted estimates in a row before only the whole range is searched
   * @param {number} [options.dropRatio=0.75] a score below this share of the recent ones is far below them (checked, or not trusted to move D)
   * @param {number} [options.confirmMs=10] D moves beyond the narrow window only when whole-range estimates in a row agree this closely ...
   * @param {number} [options.confirmRuns=3] ... this many of them (also what relocks D after relock())
   * @param {number} [options.driftRuns=2] ... or this many when the delay drifted out of the narrow window
   * @param {number} [options.maxHistory=1200] accepted estimates kept (an hour of talking at one every 3 s)
   * @param {Function} [options.estimate] the search: estimateDelayFromEnvelopes (tests pass a stand-in)
   */
  constructor({
    hopMs = 5,
    windowSec = 12,
    trackSec = 6,
    everySec = 3,
    fullSearch = [-100, 1500],
    localSearchMs = 60,
    minScore = 0.3,
    lowScoreLimit = 3,
    dropRatio = 0.75,
    confirmMs = 10,
    confirmRuns = 3,
    driftRuns = 2,
    maxHistory = 1200,
    estimate = estimateDelayFromEnvelopes,
  } = {}) {
    if (!(hopMs > 0)) throw new RangeError(`hopMs must be positive, got ${hopMs}`);
    if (!(trackSec > 0)) throw new RangeError(`trackSec must be positive, got ${trackSec}`);
    if (!(fullSearch[0] < fullSearch[1])) throw new RangeError(`fullSearch must be [min, max], got ${fullSearch}`);
    this.hopMs = hopMs;
    this.windowFrames = Math.max(2, Math.round((windowSec * 1000) / hopMs));
    this.trackFrames = Math.max(2, Math.min(this.windowFrames, Math.round((trackSec * 1000) / hopMs)));
    this.everyFrames = Math.max(1, Math.round((everySec * 1000) / hopMs));
    this.fullSearch = [fullSearch[0], fullSearch[1]];
    this.localSearchMs = localSearchMs;
    this.minScore = minScore;
    this.lowScoreLimit = lowScoreLimit;
    this.dropRatio = dropRatio;
    this.confirmMs = confirmMs;
    this.confirmRuns = confirmRuns;
    this.driftRuns = driftRuns;
    this.maxHistory = maxHistory;
    this._estimate = estimate;
    // Ring buffers of the last windowFrames frames, and the part searched unrolled in time order.
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
   * Look for the delay afresh: for after a reconnect or a stall, when the
   * delay may have jumped, or may still be moving (a jitter buffer draining
   * the audio it held during a stall). The envelopes so far are dropped and
   * the next estimates search the whole range. delayMs keeps its old value
   * until the first trusted estimate; from then on D follows every trusted
   * estimate (every everySec while the delay settles) and locks again once
   * confirmRuns of them in a row agree within confirmMs. Taking the first
   * one for good would lock D on a passing value halfway through the drain.
   * The history stays. Before any delay is known (a new call), the first
   * trusted estimate locks at once.
   */
  relock() {
    this._count = 0;
    this._pending = 0;
    this._locked = false;
    this._following = this._delay !== null; // after relock(): D follows the estimates until they agree
    this._run = null; // { ms, runs }: trusted estimates in a row that agree, while following
    this._low = 0; // untrusted estimates in a row while locked
    this._candidate = null; // { ms, runs, needs }: a far delay whole-range searches found, waiting for `needs` in a row
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
    // Before the first lock the whole window; once a delay is known only the most recent part.
    const known = this._locked || this._following;
    const n = Math.min(this._count, known ? this.trackFrames : this.windowFrames);
    const freshFrom = n - Math.min(this._pending, n);
    this._pending = 0;

    // Unroll the ring into time order, noting the levels the sound checks need.
    const cap = this.windowFrames;
    const a = this._a;
    const b = this._b;
    let r = (this._write - n + cap) % cap;
    let floor = Infinity;
    let peak = -Infinity;
    let freshPeak = -Infinity;
    let convMin = Infinity;
    let convMax = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = this._orig[r];
      const y = this._conv[r];
      a[i] = x;
      b[i] = y;
      if (x < floor) floor = x;
      if (x > peak) peak = x;
      if (i >= freshFrom && x > freshPeak) freshPeak = x;
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
    let narrow = null;
    if (this._locked && this._candidate === null && this._low < this.lowScoreLimit) {
      narrow = this._search(orig, conv, this._delay - this.localSearchMs, this._delay + this.localSearchMs);
      if (narrow === null) return null;
      est = narrow;
      // The whole range holds the narrow window, so its best match decides: the same peak, or one elsewhere.
      method = this._suspect(narrow, orig, peak) ? "full" : "local";
    }
    if (method === "full") {
      est = this._search(orig, conv, this.fullSearch[0], this.fullSearch[1]);
      if (est === null) return null;
    }

    const accepted = this._decide(est, narrow);
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

  /** True when `score` is far below the recent accepted ones (never before there are any). */
  _weak(score) {
    return this._scores.length > 0 && score < this.dropRatio * median(this._scores);
  }

  /** A narrow-window result that may not be the peak D was following. `orig`: the window searched, `peak`: its loudest frame. */
  _suspect(est, orig, peak) {
    if (est.edge || !(est.score >= this.minScore)) return true;
    if (Math.abs(est.ms - this._delay) > SPARSE_MOVE_MS) {
      let speech = 0;
      for (let i = 0; i < orig.length; i++) if (orig[i] > peak - SPEECH_RANGE_DB && orig[i] > SOUND_MIN_DB) speech++;
      if (speech < SPARSE_SHARE * orig.length) return true;
    }
    return this._weak(est.score);
  }

  /**
   * Whether an estimate becomes D. `narrow`: this update's narrow-window
   * result, if that search ran (est is the whole-range result when it was
   * suspect).
   */
  _decide(est, narrow) {
    if (!(est.score >= this.minScore) || est.edge) {
      if (this._locked) this._low++;
      this._candidate = null; // confirmation needs trusted estimates in a row
      this._run = null; // and so does a lock while following
      return false;
    }
    if (!this._locked) return true; // _accept decides whether it locks
    const move = Math.abs(est.ms - this._delay);
    if (move <= this.localSearchMs) {
      // The same peak as D. A weak one may confirm D, not move it: while the
      // engine sends something unrelated, the best match near D is a
      // look-alike, and taking it would walk D off by up to localSearchMs.
      if (move <= this.confirmMs || !this._weak(est.score)) return true;
      this._low++;
      this._candidate = null;
      return false;
    }
    if (this._candidate !== null && Math.abs(est.ms - this._candidate.ms) <= this.confirmMs) {
      this._candidate.ms = est.ms;
      if (++this._candidate.runs < this._candidate.needs) return false;
      this._scores = []; // a new delay: the old scores say nothing about it
      return true;
    }
    // A new far delay. When the narrow window's best match was at its edge on
    // the same side, the correlation rose toward it: the delay drifted out of
    // the window (a jitter buffer growing or draining) rather than an old peak
    // fading next to a look-alike. If the new peak also scores like the
    // recent matches, fewer whole-range estimates need to agree.
    const side = Math.sign(est.ms - this._delay);
    const drift =
      narrow !== null && narrow.edge && narrow.score >= this.minScore && Math.sign(narrow.ms - this._delay) === side && !this._weak(est.score);
    this._candidate = { ms: est.ms, runs: 1, needs: drift ? Math.min(this.driftRuns, this.confirmRuns) : this.confirmRuns };
    return false;
  }

  _accept(est) {
    this._delay = est.ms;
    this._low = 0;
    this._candidate = null;
    if (!this._locked) {
      // A new call locks at its first trusted estimate. After relock() D
      // follows each one and locks once confirmRuns in a row agree.
      const agree = this._run !== null && Math.abs(est.ms - this._run.ms) <= this.confirmMs;
      this._run = { ms: est.ms, runs: agree ? this._run.runs + 1 : 1 };
      if (!this._following || this._run.runs >= this.confirmRuns) {
        this._locked = true;
        this._following = false;
        this._run = null;
      }
    }
    if (this._locked) {
      this._scores.push(est.score);
      if (this._scores.length > SCORES_KEPT) this._scores.shift();
    }
    // settling: taken while D followed a delay that had not settled yet (a jitter buffer draining).
    const settling = !this._locked;
    this._history.push(Object.freeze({ atSec: (this._frames * this.hopMs) / 1000, ms: est.ms, score: est.score, settling }));
    if (this._history.length > this.maxHistory) this._history.shift();
  }

  /** Current D in ms (whole ms), null until the first lock. */
  get delayMs() {
    return this._delay;
  }

  /** True while D is followed with the narrow search (false before the first lock, and after relock() until estimates agree). */
  get locked() {
    return this._locked;
  }

  /**
   * Accepted estimates, oldest first: [{ atSec (stream time of the estimate),
   * ms, score, settling }]. `settling`: taken after relock() while the delay
   * was still settling (D followed it, but it was not locked). A copy.
   */
  get history() {
    return this._history.slice();
  }

  /**
   * Total delay L for lip-sync mode: the 95th percentile of the accepted
   * delays plus `marginMs`, rounded up to a whole ms, capped at `maxMs` and
   * never below 0. Null with fewer than 5 such estimates. The passing values
   * D followed while a jitter buffer drained after a stall are left out: the
   * converted voice was not on air then, and they would hold every later
   * word back for nothing.
   */
  lipSyncTotalMs({ marginMs = 30, maxMs = 800 } = {}) {
    const settled = this._history.filter((h) => !h.settling);
    if (settled.length < 5) return null;
    const p95 = percentile(settled.map((h) => h.ms), 95);
    // The epsilon keeps float noise in the interpolation (342.00000000000006) from adding a whole ms.
    return Math.min(maxMs, Math.max(0, Math.ceil(p95 + marginMs - 1e-6)));
  }
}
