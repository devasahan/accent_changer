/**
 * Is the user speaking? A speech detector for the original (mic) signal.
 *
 * Pure (no DOM, no Web Audio, no timers): it runs unchanged inside the safety
 * mixer's AudioWorklet and in the Node tests. Time is the number of samples
 * pushed, so the caller decides what "now" is.
 *
 * The signal is cut into short frames (10 ms). A frame is speech when it is
 * clearly above the room's noise floor and within `peakRangeDb` of the
 * speaker's recent peak: vowels come close to full level, while breaths, lip
 * smacks and keyboard noise stay far below it. The peak follows the voice,
 * not the loudest sound (SpeechPeak): a cough or a mic bump does not make
 * the next sentence "too quiet" to be speech. `speaking` needs `attackMs` of
 * speech frames in a row to switch on (a click is not speech) and stays on
 * for `hangMs` after the last one (the gaps between words belong to the
 * sentence).
 */

/** Level of an all-zero frame; every level is at least this. */
export const SILENCE_DB = -120;

/** The noise floor never goes below this. */
const FLOOR_MIN_DB = -100;

/**
 * Mean square below which a frame is digital silence (a muted or not yet
 * started mic, a dropout), not a quiet room: it says nothing about the
 * room's noise, so it leaves the floor alone.
 */
const DIGITAL_SILENCE = 1e-14;

/** Level in dB of a frame of `n` samples whose squares add up to `sumSquares` (the same formula as envelopeDb). */
export function frameDb(sumSquares, n) {
  return Math.max(SILENCE_DB, 10 * Math.log10(sumSquares / n + 1e-12));
}

/**
 * Levels (dB) of consecutive, non-overlapping `frameMs` frames of `samples`;
 * a partial frame at the end is left out. The Vad sees exactly these levels.
 */
export function frameLevelsDb(samples, sampleRate, frameMs = 10) {
  const len = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const frames = Math.floor(samples.length / len);
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * len, end = i + len; i < end; i++) sum += samples[i] * samples[i];
    out[f] = frameDb(sum, len);
  }
  return out;
}

/** SpeechPeak's histogram: levels from SILENCE_DB to PEAK_TOP_DB in steps of PEAK_BIN_DB. */
const PEAK_BIN_DB = 0.25;
const PEAK_TOP_DB = 20;
const PEAK_BINS = Math.round((PEAK_TOP_DB - SILENCE_DB) / PEAK_BIN_DB) + 1;

/**
 * The level of the user's loud speech, for "within N dB of the speech peak"
 * tests that one loud sound must not throw off.
 *
 * It is the loudest speech frame heard lately (it jumps up, holds, then sinks
 * slowly; time passes only for the frames it is given, so a long silence
 * leaves it alone), but never more than `capDb` above the level that the
 * loudest fifth (1 - `quantile`) of the last `windowMs` of speech frames
 * reach. A cough, a click, a plosive pop or one shouted word is a few percent
 * of that window: it cannot lift the peak far above the voice, so the voice's
 * own frames stay inside every range measured from the peak. A voice that
 * really gets louder lifts the reference once it fills a fifth of the window;
 * a voice that gets quieter brings the peak down by the hold and the decay.
 *
 * Allocation-free: a ring of the window's levels (as histogram bins) and the
 * histogram.
 */
export class SpeechPeak {
  /**
   * @param {object} [options]
   * @param {number} [options.frameMs=10] time per frame given to push()
   * @param {number} [options.holdMs=2000] the loudest frame holds this long (in frames given) ...
   * @param {number} [options.decayDbPerSec=3] ... then sinks this fast
   * @param {number} [options.windowMs=2500] speech frames the reference level is taken over
   * @param {number} [options.quantile=0.8] the reference: the level this share of the window stays under
   * @param {number} [options.capDb=4] the peak is at most this far above the reference (the loudest
   *   frames of real speech are typically 4-6 dB over it, so it holds the voice's own peak)
   */
  constructor({ frameMs = 10, holdMs = 2000, decayDbPerSec = 3, windowMs = 2500, quantile = 0.8, capDb = 4 } = {}) {
    this.holdFrames = Math.max(0, Math.round(holdMs / frameMs));
    this.decayDb = (decayDbPerSec * frameMs) / 1000;
    this.capDb = capDb;
    this._share = Math.min(1, Math.max(0, 1 - quantile)); // the loudest share of the window that sets the reference
    this._ring = new Uint16Array(Math.max(1, Math.round(windowMs / frameMs)));
    this._hist = new Uint16Array(PEAK_BINS);
    this.reset();
  }

  /** Forget everything: no speech heard. */
  reset() {
    this._hist.fill(0);
    this._n = 0; // levels in the window
    this._w = 0; // next ring slot
    this._max = -Infinity; // the loudest recent speech frame (held, then sinking)
    this._hold = 0;
    this._ref = Infinity; // the reference level (none until the first speech frame)
    this._db = -Infinity;
  }

  /**
   * One frame for which time passes: its level (dB), and whether it is speech
   * (only speech raises the peak and joins the window; any frame given lets
   * the hold run down and the peak sink toward it).
   * @param {number} level
   * @param {boolean} speech
   */
  push(level, speech) {
    if (speech && level > this._max) {
      this._max = level;
      this._hold = this.holdFrames;
    } else if (this._hold > 0) {
      this._hold--;
    } else if (this._max - this.decayDb > level) {
      this._max -= this.decayDb;
    }
    if (speech) this._add(level);
    const capped = this._ref + this.capDb;
    this._db = this._max < capped ? this._max : capped;
  }

  /** The speech peak (dB; -Infinity before any speech). */
  get db() {
    return this._db;
  }

  _add(level) {
    let b = Math.round((level - SILENCE_DB) / PEAK_BIN_DB);
    if (b < 0) b = 0;
    else if (b >= PEAK_BINS) b = PEAK_BINS - 1;
    const ring = this._ring;
    if (this._n === ring.length) this._hist[ring[this._w]]--;
    else this._n++;
    ring[this._w] = b;
    if (++this._w === ring.length) this._w = 0;
    this._hist[b]++;
    // The reference: walking down from the top, the bin where the loudest share of the window is reached.
    const want = Math.max(1, Math.ceil(this._share * this._n - 1e-9));
    let seen = 0;
    let k = PEAK_BINS - 1;
    for (; k > 0; k--) {
      seen += this._hist[k];
      if (seen >= want) break;
    }
    this._ref = SILENCE_DB + k * PEAK_BIN_DB;
  }
}

/**
 * Speech detector with an adaptive noise floor, a speech-peak tracker, attack
 * and hangover. Push the mic signal in blocks of any length; the state
 * changes once per complete frame.
 */
export class Vad {
  /**
   * @param {object} [options]
   * @param {number} [options.sampleRate=48000]
   * @param {number} [options.frameMs=10] frame length
   * @param {number} [options.marginDb=12] speech must be this far above the noise floor
   * @param {number} [options.minDb=-55] ... and above this level, however quiet the room
   * @param {number} [options.attackMs=30] speech frames in a row needed to switch `speaking` on
   * @param {number} [options.hangMs=300] `speaking` stays on this long after the last speech frame
   * @param {number} [options.peakRangeDb=25] speech frames are within this of the recent speech peak
   * @param {number} [options.peakHoldMs=2000] the peak holds this long (counted in frames above the threshold) ...
   * @param {number} [options.peakDecayDbPerSec=3] ... then sinks this fast while there is sound
   * @param {number} [options.peakWindowMs=2500] ... and is at most peakCapDb above the level the loudest fifth
   *   of this much recent speech reaches (a cough or a click cannot lift it: see SpeechPeak)
   * @param {number} [options.peakCapDb=4]
   * @param {number} [options.floorRiseDbPerSec=3] the noise floor rises this fast (it falls at once)
   */
  constructor({
    sampleRate = 48000,
    frameMs = 10,
    marginDb = 12,
    minDb = -55,
    attackMs = 30,
    hangMs = 300,
    peakRangeDb = 25,
    peakHoldMs = 2000,
    peakDecayDbPerSec = 3,
    peakWindowMs = 2500,
    peakCapDb = 4,
    floorRiseDbPerSec = 3,
  } = {}) {
    this.sampleRate = sampleRate;
    this.frameLen = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
    this.frameMs = (this.frameLen * 1000) / sampleRate;
    this.marginDb = marginDb;
    this.minDb = minDb;
    this.attackFrames = Math.max(1, Math.ceil(attackMs / this.frameMs - 1e-9));
    this.hangSamples = Math.round((hangMs * sampleRate) / 1000);
    this.peakRangeDb = peakRangeDb;
    this._peak = new SpeechPeak({
      frameMs: this.frameMs,
      holdMs: peakHoldMs,
      decayDbPerSec: peakDecayDbPerSec,
      windowMs: peakWindowMs,
      capDb: peakCapDb,
    });
    this.floorRiseDb = (floorRiseDbPerSec * this.frameMs) / 1000;
    this.reset();
  }

  /** Forget everything: as if newly made. */
  reset() {
    this._sum = 0;
    this._fill = 0;
    this._pos = 0; // samples pushed
    this._frames = 0; // complete frames
    this._level = SILENCE_DB;
    this._floor = FLOOR_MIN_DB;
    this._floorSet = false;
    this._peak.reset(); // no speech heard yet
    this._run = 0; // speech frames in a row
    this._speaking = false;
    this._lastSpeechEnd = -1; // sample index just after the last speech frame; -1 = never
  }

  /** Feed the next samples of the mic signal (Float32Array, any length). */
  push(samples) {
    const len = this.frameLen;
    let sum = this._sum;
    let fill = this._fill;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      sum += x * x;
      if (++fill === len) {
        this._frame(sum);
        sum = 0;
        fill = 0;
      }
    }
    this._sum = sum;
    this._fill = fill;
    this._pos += samples.length;
  }

  _frame(sum) {
    // A NaN or infinite sample must not poison the floor and peak for good: treat the frame as a dropout.
    if (!(sum < Infinity)) sum = 0;
    const meanSquare = sum / this.frameLen;
    const level = frameDb(sum, this.frameLen);
    this._level = level;
    const frameEnd = ++this._frames * this.frameLen;

    // Noise floor: starts at the first sound heard (a floor that started at -100 would take
    // 15 s to climb to a -45 dB room) but no higher than minDb (when that first sound is
    // already the voice, a floor at speech level would hide the first sentence); then it
    // falls at once and rises slowly, through speech too.
    if (meanSquare > DIGITAL_SILENCE) {
      if (!this._floorSet) {
        this._floor = Math.max(FLOOR_MIN_DB, Math.min(level, this.minDb));
        this._floorSet = true;
      } else if (level < this._floor) {
        this._floor = Math.max(FLOOR_MIN_DB, level);
      } else {
        this._floor = Math.min(level, this._floor + this.floorRiseDb);
      }
    }

    const threshold = Math.max(this._floor + this.marginDb, this.minDb);
    const loud = level > threshold;
    const speech = loud && level >= this._peak.db - this.peakRangeDb; // any loud frame before the first speech

    // Speech peak: jumps up with louder speech, holds, then sinks slowly, never far above the
    // voice's usual level (a cough must not make the next words "too quiet"). Time only passes
    // for it while there is sound, so a long silence (listening to the interviewer) does not
    // lower it and let the next breath pass as speech; and a voice that got much quieter
    // still brings it down in the end.
    if (loud) this._peak.push(level, speech);

    if (speech) {
      this._run++;
      if (this._speaking || this._run >= this.attackFrames) {
        this._speaking = true;
        this._lastSpeechEnd = frameEnd;
      }
    } else {
      this._run = 0;
      if (this._speaking && frameEnd - this._lastSpeechEnd >= this.hangSamples) this._speaking = false;
    }
  }

  /** True while the user speaks (attack and hangover included). */
  get speaking() {
    return this._speaking;
  }

  /** Level of the last complete frame, dBFS (>= -120). */
  get levelDb() {
    return this._level;
  }

  /** Adaptive noise floor, dBFS (>= -100; -100 until the first non-silent frame). */
  get floorDb() {
    return this._floor;
  }

  /** Recent speech peak, dBFS (-Infinity before any speech). */
  get peakDb() {
    return this._peak.db;
  }

  /** Current speech threshold: max(floor + marginDb, minDb). */
  get thresholdDb() {
    return Math.max(this._floor + this.marginDb, this.minDb);
  }

  /**
   * Time since the last speech frame ended, in ms: 0 while `speaking` (the
   * hangover included, so it reads at least hangMs once speaking stops),
   * Infinity before any speech.
   */
  get pauseMs() {
    if (this._speaking) return 0;
    if (this._lastSpeechEnd < 0) return Infinity;
    return ((this._pos - this._lastSpeechEnd) * 1000) / this.sampleRate;
  }
}
