/**
 * Is the converted voice still following the original?
 *
 * The safety mixer's watchdog. The original (mic) is known at once; the
 * converted voice comes back from the cloud D ms later (D about 250-450 ms).
 * Each 10 ms frame of the user's speech is expected in the converted stream
 * around D later; when a run of the user's speech (`missingMs`, counted in
 * speech only: shared pauses never count) found no converted voice where it
 * was due, the converter has stalled and the mixer must fall back to the
 * original, replayed from where the converted voice stopped
 * (`stallStartSample`), so no word is lost. It also flags output that must
 * never reach the meeting: NaN/Inf samples, or a sudden +20 dB burst.
 *
 * Pure (no DOM, no Web Audio, no timers) and allocation-free per block: it
 * runs inside the AudioWorklet and in Node tests. Time is counted in samples
 * pushed. Content time (original) and arrival time (converted) share one
 * clock: frame k of the original was spoken at the moment frame k of the
 * converted arrived.
 *
 * Decision rules, per frame j of the original (spoken at content time j):
 * - It is decided only once the whole span of converted frames where it is
 *   due, [j + D - tol, j + D + tol], has arrived. The span absorbs an error
 *   of up to tolMs in D and short holes in the converted stream (a clock
 *   crossing that drops a block): its loudest frame is what counts.
 * - It is a decided speech frame when the Vad says speech and its level is
 *   within `speechRangeDb` of the user's recent speech peak. Quieter frames
 *   (breaths, the Vad's hangover in a pause, soft syllable edges) carry no
 *   evidence: the converter may drop a breath, and a converted whisper
 *   cannot be told from noise. They never start a miss run or reset one.
 *   Only a syllable edge next to a decided frame (down to `edgeRangeDb`)
 *   adds to a run already going, when nothing voice-level came back for it.
 * - It is matched when the loudest converted frame of its span is at least
 *   orig + offsetDb - dropDb AND voice-level: within `voiceRangeDb` of the
 *   converted speech peak (the user's speech peak + offsetDb). The second
 *   test keeps the noise that a stalled stream decays into (packet-loss
 *   concealment, comfort noise at -50 dBFS) from passing for speech.
 * - When a run of misses starts, the ±tol span and a fading concealment
 *   tail have usually "matched" the first frames after the real stop. So the
 *   detector looks back for the last converted frames that really carried
 *   the voice (two in a row, each within `aliveDb` of its own loud original
 *   frame) and counts the matched speech after them as missing too (at most
 *   tolMs + concealMs of it, so one false miss in healthy speech stays far
 *   from a stall). That point, in content time, is `stallStartSample`; it
 *   errs early, so a replay repeats a little rather than losing a word.
 *   A concealment tail that keeps the voice's level and shape for a few
 *   frames can still make it up to a few tens of ms late.
 */

import { SILENCE_DB, frameDb } from "./vad.js";

const UNDECIDED = 0;
const MATCHED = 1;
const MISSING = 2;

/** Level tolerance of the +jumpDb test: frame levels jitter by a fraction of a dB, a +20 dB copy must count as +20. */
const JUMP_SLACK_DB = 1;

/** Before the user has spoken, converted output louder than this + jumpDb is a jump. */
const JUMP_QUIET_DB = -50;

/** Largest per-frame step of the offset estimate (dB): one odd frame cannot drag it. */
const OFFSET_STEP_DB = 6;

export class StallDetector {
  /**
   * @param {object} [options]
   * @param {number} [options.sampleRate=48000]
   * @param {number} [options.frameMs=10] frame length
   * @param {number} [options.tolMs=40] each original frame is looked for this far either side of D
   * @param {number} [options.missingMs=350] missing original speech that makes a stall
   * @param {number} [options.dropDb=18] converted may be this much quieter than expected and still match
   * @param {number} [options.historyMs=2500] frame history kept; a D longer than about historyMs - lookBackMs - 3 tolMs counts as unknown
   * @param {number} [options.jumpDb=20] a burst this far above the expected level ...
   * @param {number} [options.jumpMs=20] ... for this long is bad output
   * @param {number} [options.speechRangeDb=14] decided speech frames are within this of the speech peak
   * @param {number} [options.edgeRangeDb=20] quieter frames next to them, down to this, count as speech in a miss run
   * @param {number} [options.voiceRangeDb=20] converted audio within this of the converted speech peak (the user's peak + offsetDb) is voice.
   *   Until the offset is learned it is 0, so a converted voice more than about this much under the mic counts as missing: the mixer stays on the user's voice
   * @param {number} [options.aliveDb=6] stall-start look-back: a converted frame within this of its own expected level still carried the voice
   * @param {number} [options.lookBackMs=500] the look-back searches this far back (pauses included)
   * @param {number} [options.concealMs=100] at most tolMs + this of earlier matched speech is turned into missing speech
   * @param {number} [options.healthResetMs=30] a miss run this long resets healthyMs
   * @param {number} [options.offsetTauMs=2000] time constant of the level-offset estimate, in matched speech
   * @param {number} [options.maxOffsetDb=12] the offset estimate is clamped to ±this
   * @param {number} [options.peakHoldMs=2000] the speech peak holds this long (in speech time) ...
   * @param {number} [options.peakDecayDbPerSec=3] ... then sinks this fast
   * @param {number} [options.quietRefDb=10] jump test: the reference level never goes below the converted speech peak minus this
   * @param {number} [options.maxDelayMs=1000] jump test with D unknown: the original's loudest frame in this span is the reference
   */
  constructor({
    sampleRate = 48000,
    frameMs = 10,
    tolMs = 40,
    missingMs = 350,
    dropDb = 18,
    historyMs = 2500,
    jumpDb = 20,
    jumpMs = 20,
    speechRangeDb = 14,
    edgeRangeDb = 20,
    voiceRangeDb = 20,
    aliveDb = 6,
    lookBackMs = 500,
    concealMs = 100,
    healthResetMs = 30,
    offsetTauMs = 2000,
    maxOffsetDb = 12,
    peakHoldMs = 2000,
    peakDecayDbPerSec = 3,
    quietRefDb = 10,
    maxDelayMs = 1000,
  } = {}) {
    this.sampleRate = sampleRate;
    this.frameLen = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
    this.frameMs = (this.frameLen * 1000) / sampleRate;
    const frames = (ms) => Math.max(0, Math.round(ms / this.frameMs));
    this.tol = frames(tolMs);
    this.missingFrames = Math.max(1, Math.ceil(missingMs / this.frameMs - 1e-9));
    this.dropDb = dropDb;
    this.jumpDb = jumpDb;
    this.jumpFrames = Math.max(1, Math.ceil(jumpMs / this.frameMs - 1e-9));
    this.speechRangeDb = speechRangeDb;
    this.edgeRangeDb = edgeRangeDb;
    this.voiceRangeDb = voiceRangeDb;
    this.aliveDb = aliveDb;
    this.backFrames = Math.max(this.tol + 1, frames(lookBackMs));
    this.recreditMax = this.tol + frames(concealMs);
    this.healthResetFrames = Math.max(1, Math.ceil(healthResetMs / this.frameMs - 1e-9));
    this.offsetAlpha = Math.min(1, this.frameMs / Math.max(this.frameMs, offsetTauMs));
    this.maxOffsetDb = maxOffsetDb;
    this.peakHoldFrames = frames(peakHoldMs);
    this.peakDecayDb = (peakDecayDbPerSec * this.frameMs) / 1000;
    this.quietRefDb = quietRefDb;
    this.searchFrames = frames(maxDelayMs);

    this.cap = Math.max(frames(historyMs), 4 * this.tol + this.backFrames + 8);
    this._orig = new Float32Array(this.cap); // original level by content frame
    this._conv = new Float32Array(this.cap); // converted level by arrival frame
    this._speech = new Uint8Array(this.cap); // the Vad's speech flag by content frame
    this._state = new Uint8Array(this.cap); // decision by content frame

    this._origSum = 0;
    this._convSum = 0;
    this._speechCount = 0;
    this._fill = 0;
    this._frames = 0; // complete frames
    this._next = 0; // next content frame to decide
    this._ds = 0; // D in samples
    this._offset = 0;
    this._learned = 0; // matched frames the offset has learned from
    this._peak = -Infinity; // the original's recent speech peak (dB)
    this._peakHold = 0;
    this.reset();
  }

  /** Clear the stall and bad-output flags and the counters. The learned offset, the speech peak and the history stay. */
  reset() {
    this._stalled = false;
    this._stallStart = null;
    this._bad = false;
    this._jumpRun = 0;
    this._missRun = 0;
    this._runStart = 0;
    this._healthy = 0;
    this._following = false;
  }

  /**
   * One block. `orig`: the mic (content time = now); `conv`: the converted
   * voice (arrival time = now); same length. `delayMs`: the current D, null
   * when unknown. `speech`: the Vad's state for the original (one boolean
   * per block).
   */
  push(orig, conv, delayMs, speech) {
    const len = this.frameLen;
    const n = Math.min(orig.length, conv.length);
    let os = this._origSum;
    let cs = this._convSum;
    let sp = this._speechCount;
    let fill = this._fill;
    for (let i = 0; i < n; i++) {
      const o = orig[i];
      const c = conv[i];
      os += o * o;
      if (c - c === 0) cs += c * c;
      else this._bad = true; // NaN or ±Infinity: never let it near the meeting
      if (speech) sp++;
      if (++fill === len) {
        this._frame(os, cs, sp, delayMs);
        os = 0;
        cs = 0;
        sp = 0;
        fill = 0;
      }
    }
    this._origSum = os;
    this._convSum = cs;
    this._speechCount = sp;
    this._fill = fill;
  }

  _frame(origSum, convSum, speechCount, delayMs) {
    const k = this._frames++;
    const slot = k % this.cap;
    const o = frameDb(origSum < Infinity ? origSum : 0, this.frameLen);
    this._orig[slot] = o;
    this._conv[slot] = frameDb(convSum < Infinity ? convSum : 0, this.frameLen);
    const speech = speechCount * 2 >= this.frameLen;
    this._speech[slot] = speech ? 1 : 0;
    this._state[slot] = UNDECIDED;
    if (speech) this._trackPeak(o);

    const d = this._delayFrames(delayMs);
    this._checkJump(k, d);
    if (d < 0) {
      // Not converting: nothing is due, and when D becomes known the frames from before are not judged.
      this._next = k + 1;
      return;
    }
    const oldest = k - this.cap + 2 * this.tol + this.backFrames + 2; // everything a decision reads is still in the history
    if (this._next < oldest) this._next = oldest;
    while (this._next + d + this.tol <= k) this._decide(this._next++, d);
  }

  /** D in frames, or -1 when unknown or too long for the history. */
  _delayFrames(delayMs) {
    if (delayMs == null || !Number.isFinite(delayMs)) return -1;
    const d = Math.max(0, Math.round(delayMs / this.frameMs));
    if (d + 3 * this.tol + this.backFrames + 4 >= this.cap) return -1;
    this._ds = Math.max(0, Math.round((delayMs * this.sampleRate) / 1000));
    return d;
  }

  _trackPeak(level) {
    if (level > this._peak) {
      this._peak = level;
      this._peakHold = this.peakHoldFrames;
    } else if (this._peakHold > 0) {
      this._peakHold--;
    } else if (this._peak - this.peakDecayDb > level) {
      this._peak -= this.peakDecayDb;
    }
  }

  _decide(j, d) {
    const cap = this.cap;
    const slot = j % cap;
    if (!this._speech[slot]) return; // a pause: neither counts nor resets
    const o = this._orig[slot];
    const peak = this._peak;
    if (!(peak > SILENCE_DB)) return;
    const loud = peak - this.speechRangeDb;
    if (o < loud) {
      // Too quiet to show that the converted voice is there. But the edge of a syllable is
      // speech time all the same: while a miss run is going and nothing voice-level came
      // back around it, it adds to the run (it never starts one, so a breath the converter
      // leaves out cannot make a stall).
      if (
        this._missRun > 0 &&
        o >= peak - this.edgeRangeDb &&
        ((j > 0 && this._orig[(j - 1) % cap] >= loud) || (j + 1 < this._frames && this._orig[(j + 1) % cap] >= loud)) &&
        this._dueMax(j, d) < peak + this._offset - this.voiceRangeDb
      ) {
        this._state[slot] = MISSING;
        this._addMiss();
      }
      return;
    }
    const cmax = this._dueMax(j, d);
    const voiceFloor = peak + this._offset - this.voiceRangeDb;
    if (cmax >= o + this._offset - this.dropDb && cmax >= voiceFloor) {
      this._state[slot] = MATCHED;
      this._matched(j, cmax);
    } else {
      this._state[slot] = MISSING;
      this._missing(j, d);
    }
  }

  /** Loudest converted frame of the span where original frame j is due. */
  _dueMax(j, d) {
    let cmax = SILENCE_DB;
    for (let k = Math.max(0, j + d - this.tol), end = j + d + this.tol; k <= end; k++) {
      const c = this._conv[k % this.cap];
      if (c > cmax) cmax = c;
    }
    return cmax;
  }

  _matched(j, cmax) {
    // Level offset: the loudest converted frame of the span against the loudest original frame around j.
    let omax = SILENCE_DB;
    for (let i = Math.max(0, j - this.tol), end = j + this.tol; i <= end; i++) {
      const v = this._orig[i % this.cap];
      if (v > omax) omax = v;
    }
    // EMA with a running-mean start, so the first second of speech already gives a usable offset.
    const alpha = Math.max(this.offsetAlpha, 1 / ++this._learned);
    const step = Math.max(-OFFSET_STEP_DB, Math.min(OFFSET_STEP_DB, cmax - omax - this._offset));
    const next = this._offset + alpha * step;
    this._offset = Math.max(-this.maxOffsetDb, Math.min(this.maxOffsetDb, next));
    this._healthy++;
    this._following = true;
    this._missRun = 0;
  }

  _missing(j0, d) {
    this._following = false;
    if (this._missRun === 0) {
      // A new run. Its first frames may have been matched by the span reaching back to
      // before the stop, or by a concealment tail: find where the voice really stopped.
      // At most recreditMax of them are taken back, the latest first, so that a single
      // false miss in healthy speech can never come near a stall.
      const k = this._lastAlive(j0, d);
      const len = this.frameLen;
      this._runStart = Math.max(0, k * len - this._ds); // the start of that frame: errs early
      let run = 1;
      // Speech after that frame (it carried the voice, at least in part) was missing.
      const from = Math.max(Math.ceil(((k + 1) * len - this._ds) / len), j0 - this.backFrames, 0);
      for (let j = j0 - 1, left = this.recreditMax; j >= from && left > 0; j--) {
        const slot = j % this.cap;
        if (this._state[slot] === MATCHED) {
          this._state[slot] = MISSING;
          run++;
          left--;
          if (this._healthy > 0) this._healthy--;
        }
      }
      this._missRun = run - 1;
    }
    this._addMiss();
  }

  _addMiss() {
    this._missRun++;
    if (this._missRun >= this.healthResetFrames) this._healthy = 0;
    if (!this._stalled && this._missRun >= this.missingFrames) {
      this._stalled = true;
      this._stallStart = this._runStart;
    }
  }

  /**
   * The last converted frame (arrival index) that still carried the voice
   * before the span of j0, the first missing frame of a run: where the
   * converted voice stopped. Searched back up to lookBackMs, pauses included;
   * when nothing in reach carried it, the far end of the search.
   */
  _lastAlive(j0, d) {
    const hi = j0 + d - this.tol - 1;
    const lo = Math.max(0, hi - this.backFrames + 1, this._frames - this.cap + d + 1);
    // Two alive frames in a row: a concealment tail can cross the original's own decay for one frame.
    let k = hi;
    while (k > lo && !(this._alive(k, d) && this._alive(k - 1, d))) k--;
    return k;
  }

  /**
   * Did converted frame k carry the voice of its original frame (k - d)?
   * Only a loud original frame can show it: next to a quiet one (a
   * syllable's tail, a pause) a concealment tail or noise looks as
   * plausible as the voice. Then the converted frame must be voice-level
   * and within aliveDb of the original frame plus the offset.
   */
  _alive(k, d) {
    const j = k - d;
    if (j < 0) return false;
    const o = this._orig[j % this.cap];
    const peak = this._peak;
    if (o < peak - this.speechRangeDb) return false;
    const c = this._conv[k % this.cap];
    return c >= peak + this._offset - this.voiceRangeDb && c >= o + this._offset - this.aliveDb;
  }

  /**
   * +jumpDb test for the newest converted frame k: against the original
   * frame it carries (k - d) plus the offset, but never against less than the
   * converted speech peak minus quietRefDb. That floor keeps a converted
   * syllable that arrives a little earlier or later than D (or speech while
   * the original is silent) from counting as a burst: only output far louder
   * than the user's own loudest speech does.
   */
  _checkJump(k, d) {
    let ref;
    if (d >= 0) {
      ref = k - d >= 0 ? this._orig[(k - d) % this.cap] : SILENCE_DB;
    } else {
      ref = SILENCE_DB; // D unknown: the loudest original frame it could carry
      for (let i = Math.max(0, k - this.searchFrames, k - this.cap + 1); i <= k; i++) {
        const v = this._orig[i % this.cap];
        if (v > ref) ref = v;
      }
    }
    ref += this._offset;
    const quiet = this._peak > SILENCE_DB ? this._peak + this._offset - this.quietRefDb : JUMP_QUIET_DB;
    if (ref < quiet) ref = quiet;
    if (this._conv[k % this.cap] >= ref + this.jumpDb - JUMP_SLACK_DB) {
      this._jumpRun++;
      if (this._jumpRun >= this.jumpFrames && !this._stalled) this._bad = true;
    } else {
      this._jumpRun = 0;
    }
  }

  /** True once a stall was detected; sticky until reset(). */
  get stalled() {
    return this._stalled;
  }

  /** Content-time sample index (the original's sample count) where the converted voice stopped; null if not stalled. */
  get stallStartSample() {
    return this._stalled ? this._stallStart : null;
  }

  /** True if the converted stream had NaN/Inf, or a burst of >= jumpDb for >= jumpMs while not stalled; sticky until reset(). */
  get badOutput() {
    return this._bad;
  }

  /** True when the most recent decided original speech frame was matched by converted audio. */
  get following() {
    return this._following;
  }

  /** Ms of original speech matched by converted audio since the last miss run (>= healthResetMs) or reset(). */
  get healthyMs() {
    return this._healthy * this.frameMs;
  }

  /** Ms of original speech missing in the current miss run (0 while following). */
  get missMs() {
    return this._missRun * this.frameMs;
  }

  /** Learned level offset, converted minus original, over matched speech (dB, ±maxOffsetDb). */
  get offsetDb() {
    return this._offset;
  }

  /** The original's recent speech peak that decided speech frames are measured against (dB; -Infinity before any speech). */
  get speechPeakDb() {
    return this._peak;
  }
}
