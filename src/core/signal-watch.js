/**
 * Streaming analysers for the audio worklets: levels, runs of digital
 * silence, loudness envelopes, and a detector for the clicks, skips and gaps
 * of a test tone that crossed from one audio clock to another.
 *
 * They run on the audio thread, 128 samples at a time, for an hour or more,
 * so they keep running sums only: no memory grows with time and nothing is
 * allocated per sample (results are built when they are taken). Every
 * push(samples) takes any length.
 *
 * Pure and dependency-free (this module is loaded inside AudioWorklets): no
 * imports, no DOM, no clock. Time is the number of samples pushed.
 */

/** 48000 × 11 / 512: exactly 11 cycles per 512-sample block at 48 kHz. */
export const TONE_HZ = 1031.25;

const FLOOR_DB = -120;

/** A sample as a number the sums can use: NaN and ±Infinity count as 0. */
const finite = (x) => (x - x === 0 ? x : 0);

const toDb = (meanSquare) => Math.max(FLOOR_DB, 10 * Math.log10(meanSquare + 1e-12));

/** Wrap an angle into (−π, π]. */
function wrap(a) {
  let r = (a + Math.PI) % (2 * Math.PI);
  if (r <= 0) r += 2 * Math.PI;
  return r - Math.PI;
}

const round = (x, digits) => {
  const k = 10 ** digits;
  return Math.round(x * k) / k;
};

/** RMS and peak level over consecutive windows (100 ms at 48 kHz by default). */
export class LevelWindow {
  /** @param {{frames?: number}} [options] window length in samples */
  constructor({ frames = 4800 } = {}) {
    this._frames = Math.max(1, Math.round(frames));
    this._n = 0;
    this._sum = 0;
    this._peak = 0;
    this._rmsDb = FLOOR_DB;
    this._peakDb = FLOOR_DB;
  }

  /**
   * @param {ArrayLike<number>} samples
   * @returns {boolean} true when at least one window completed during this push
   */
  push(samples) {
    let done = false;
    for (let i = 0; i < samples.length; i++) {
      const x = finite(samples[i]);
      this._sum += x * x;
      const a = x < 0 ? -x : x;
      if (a > this._peak) this._peak = a;
      if (++this._n === this._frames) {
        this._rmsDb = toDb(this._sum / this._frames);
        this._peakDb = toDb(this._peak * this._peak);
        this._n = 0;
        this._sum = 0;
        this._peak = 0;
        done = true;
      }
    }
    return done;
  }

  /** RMS level of the last completed window in dBFS (floor −120; −120 before the first). */
  get rmsDb() {
    return this._rmsDb;
  }

  /** Peak level of the last completed window in dBFS (floor −120; −120 before the first). */
  get peakDb() {
    return this._peakDb;
  }
}

/**
 * Runs of digital silence: consecutive samples with |x| ≤ level (−140 dBFS
 * by default, so only true zeros). A run is reported once it has ended and
 * only when it lasted at least minFrames (1 ms at 48 kHz): a quiet 16-bit
 * microphone gives single zero samples all the time, a clock crossing's
 * underrun gives 10 ms of zeros at once.
 */
export class ZeroRuns {
  /** @param {{level?: number, minFrames?: number, maxRuns?: number}} [options] */
  constructor({ level = 1e-7, minFrames = 48, maxRuns = 256 } = {}) {
    this._level = level;
    this._min = Math.max(1, Math.round(minFrames));
    const max = Math.max(0, Math.round(maxRuns));
    this._starts = new Float64Array(max);
    this._lengths = new Float64Array(max);
    this._count = 0;
    this._n = 0;
    this._run = 0;
    this._runStart = 0;
    this._dropped = 0;
    this._zeroFrames = 0;
  }

  /** @param {ArrayLike<number>} samples */
  push(samples) {
    const level = this._level;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      if (x <= level && x >= -level) {
        if (this._run === 0) this._runStart = this._n;
        this._run++;
      } else if (this._run > 0) {
        this._end();
      }
      this._n++;
    }
  }

  _end() {
    const run = this._run;
    this._run = 0;
    if (run < this._min) return;
    this._zeroFrames += run;
    if (this._count < this._starts.length) {
      this._starts[this._count] = this._runStart;
      this._lengths[this._count] = run;
      this._count++;
    } else {
      this._dropped++;
    }
  }

  /**
   * Runs of at least minFrames that ended since the last take, oldest first
   * (a run still open is not included). At most maxRuns are kept between
   * takes; later ones are counted in `dropped`.
   * @returns {Array<{startFrame: number, frames: number}>}
   */
  takeRuns() {
    const out = new Array(this._count);
    for (let i = 0; i < this._count; i++) out[i] = { startFrame: this._starts[i], frames: this._lengths[i] };
    this._count = 0;
    return out;
  }

  /** Length of the run still open (0 when the last sample was not zero). */
  get openFrames() {
    return this._run;
  }

  /** Samples pushed so far. */
  get frame() {
    return this._n;
  }

  /** Runs that did not fit between two takes. */
  get dropped() {
    return this._dropped;
  }

  /**
   * Samples inside runs of at least minFrames so far, the open run included
   * once it is that long: the share of digital silence (a noise gate gives
   * a lot of it). Single zero samples of a quiet 16-bit microphone are not
   * counted.
   */
  get zeroFrames() {
    return this._zeroFrames + (this._run >= this._min ? this._run : 0);
  }
}

/**
 * Short-time loudness in dB, streamed: the same frames as delay-estimate's
 * envelopeDb(samples, sampleRate, {hopMs, winMs}). Frame f covers samples
 * [f·hop, f·hop + win) and is max(−120, 10·log10(sum of squares / win +
 * 1e-12)). Completed frames wait in a ring of `capacity` frames until
 * take(); beyond that the oldest are dropped and counted.
 */
export class EnvelopeStream {
  /** @param {{sampleRate?: number, hopMs?: number, winMs?: number, capacity?: number}} [options] */
  constructor({ sampleRate = 48000, hopMs = 5, winMs = 10, capacity = 2048 } = {}) {
    const hop = Math.round((sampleRate * hopMs) / 1000);
    const win = Math.round((sampleRate * winMs) / 1000);
    if (!(hop >= 1) || !(win >= hop) || win % hop !== 0) {
      throw new RangeError(`The window (${win} samples) must be a whole number of hops (${hop} samples).`);
    }
    this._sampleRate = sampleRate;
    this._hop = hop;
    this._win = win;
    this._hopSums = new Float64Array(win / hop); // the last win/hop hop sums, as a ring
    this._hops = 0; // hops completed
    this._acc = 0;
    this._pos = 0;
    this._buf = new Float32Array(Math.max(1, Math.round(capacity)));
    this._head = 0; // ring index of the oldest frame kept
    this._count = 0; // frames kept
    this._frame0 = 0; // frame index of the oldest frame kept
    this._dropped = 0;
  }

  /** @param {ArrayLike<number>} samples */
  push(samples) {
    for (let i = 0; i < samples.length; i++) {
      const x = finite(samples[i]);
      this._acc += x * x;
      if (++this._pos === this._hop) this._hopDone();
    }
  }

  _hopDone() {
    const m = this._hopSums.length;
    this._hopSums[this._hops % m] = this._acc;
    this._acc = 0;
    this._pos = 0;
    this._hops++;
    if (this._hops < m) return;
    let sum = 0;
    for (let i = 0; i < m; i++) sum += this._hopSums[i];
    const cap = this._buf.length;
    if (this._count === cap) {
      this._head = (this._head + 1) % cap;
      this._count--;
      this._frame0++;
      this._dropped++;
    }
    this._buf[(this._head + this._count) % cap] = toDb(sum / this._win);
    this._count++;
  }

  /**
   * The frames completed since the last take, oldest first.
   * @returns {Float32Array}
   */
  take() {
    const out = new Float32Array(this._count);
    const cap = this._buf.length;
    for (let i = 0; i < this._count; i++) out[i] = this._buf[(this._head + i) % cap];
    this._head = (this._head + this._count) % cap;
    this._frame0 += this._count;
    this._count = 0;
    return out;
  }

  /** Index of the first frame the next take() returns. */
  get frame0() {
    return this._frame0;
  }

  /** Frame spacing in ms (5 at 48 kHz with the defaults). */
  get hopMs() {
    return (this._hop / this._sampleRate) * 1000;
  }

  /** Frames lost because take() came too late. */
  get dropped() {
    return this._dropped;
  }
}

/**
 * Watches a steady test tone (TONE_HZ) after it crossed from one audio clock
 * to another, and reports every disturbance as an event:
 *  - "hole": a run of zeros (a clock crossing's underrun inserts 10 ms of them);
 *  - "skip": the tone's phase jumped (an overrun dropped 10 ms: +112.5°);
 *  - "click": any other short disturbance (a spike);
 *  - "dropout": zeros for 20–100 ms; "gap": 100 ms or more of zeros, or of a
 *    lost tone;
 *  - "step": an abrupt change of volume (not a tick);
 *  - "level": the volume settled at another level (Windows' ducking, a
 *    volume slider), reported once it is steady.
 * Ticks (the audible clicks Gate 1 counts) are holes, skips and clicks.
 *
 * How: each 512-sample block (exactly 11 cycles of the tone) is
 * demodulated at the tone's frequency, giving its amplitude, its phase and
 * how much of its energy is not the tone. A block is disturbed when that
 * residual is above −40 dB, when a zero run of 0.5 ms or more touches it,
 * when the tone is 20 dB below its usual level, or when its phase moved
 * more than 20° from the block before. Consecutive disturbed blocks form one
 * event, classified when the next clean block arrives. A clean tone that
 * stays 20 dB or more quieter for 10 blocks has a new level: the event ends
 * there as a "step". Nothing is reported
 * until the tone has been found (10 clean blocks in a row, at least −60
 * dBFS) and during the first 500 ms after the start or a reset().
 */
export class ToneCheck {
  constructor({
    sampleRate = 48000,
    blockFrames = 512,
    cycles = 11,
    residualLimit = 1e-4,
    phaseLimitDeg = 20,
    zeroLevel = 1e-5,
    minZeroFrames = 24,
    dropoutMs = 20,
    gapMs = 100,
    primeMs = 500,
    stepEventDb = 0.3,
    levelChangeDb = 1,
    lostDb = -20,
    minToneDb = -60,
    maxEvents = 1000,
  } = {}) {
    const B = Math.max(2, Math.round(blockFrames));
    this._B = B;
    this._sampleRate = sampleRate;
    this._cycles = cycles;
    const w = (2 * Math.PI * cycles) / B;
    this._cos = new Float64Array(B);
    this._sin = new Float64Array(B);
    for (let i = 0; i < B; i++) {
      this._cos[i] = Math.cos(w * i);
      this._sin[i] = Math.sin(w * i);
    }
    this._residualLimit = residualLimit;
    this._phaseLimitDeg = phaseLimitDeg;
    this._phaseLimit = (phaseLimitDeg * Math.PI) / 180;
    this._zeroLevel = zeroLevel;
    this._minZero = Math.max(1, Math.round(minZeroFrames));
    this._dropoutFrames = (dropoutMs * sampleRate) / 1000;
    this._gapFrames = (gapMs * sampleRate) / 1000;
    this._primeBlocks = Math.ceil((primeMs * sampleRate) / 1000 / B);
    this._stepEventDb = stepEventDb;
    this._levelChangeDb = levelChangeDb;
    this._lostRatio = 10 ** (lostDb / 20);
    this._minTone = 10 ** (minToneDb / 20);
    this._maxEvents = Math.max(0, Math.round(maxEvents));

    this._n = 0; // samples pushed
    this._j = 0; // position inside the current block
    this._k = 0; // index of the current block (blocks are aligned to sample 0)
    this._I = 0;
    this._Q = 0;
    this._E = 0;
    // Zero runs: the open one, and the longest run of at least minZero that ended in this block.
    this._zRun = 0;
    this._zStart = 0;
    this._blockZeroMax = 0;
    this._blockZeroStart = -1;
    // Lock and priming.
    this._armBlock = 0;
    this._lockCount = 0;
    this._locked = false;
    this._lockDb = null;
    this._minStableDb = null;
    // The tone as it should be: level, drift of its phase per block, the last clean block.
    this._Aref = 0;
    this._drift = 0;
    this._lastK = 0;
    this._lastPhi = 0;
    this._lastA = 0;
    this._prevClean = false;
    this._prevPhi = 0; // the phase of the block before, clean or not
    // The event in progress.
    this._ev = false;
    this._evStart = 0;
    this._evBeforeK = 0;
    this._evBeforePhi = 0;
    this._evBeforeA = 0;
    this._evZeroMax = 0;
    this._evLostBlocks = 0;
    this._evQuiet = 0; // trailing blocks of clean tone, only far quieter than before
    this._evPrime = false;
    // Slow level tracker: windows of 10 clean blocks.
    this._wSum = 0;
    this._wN = 0;
    this._wStart = 0;
    this._stableDb = null;
    this._chg = false;
    this._chgFrom = 0;
    this._chgAt = 0;
    this._chgLast = 0;
    this._chgCalm = 0;

    this._events = [];
    this._holes = 0;
    this._skips = 0;
    this._clicks = 0;
    this._dropouts = 0;
    this._gaps = 0;
    this._levels = 0;
    this._steps = 0;
  }

  /** @param {ArrayLike<number>} samples */
  push(samples) {
    const B = this._B;
    const cos = this._cos;
    const sin = this._sin;
    const zeroLevel = this._zeroLevel;
    for (let i = 0; i < samples.length; i++) {
      const x = finite(samples[i]);
      const j = this._j;
      this._I += x * cos[j];
      this._Q += x * sin[j];
      this._E += x * x;
      if (x <= zeroLevel && x >= -zeroLevel) {
        if (this._zRun === 0) this._zStart = this._n;
        this._zRun++;
      } else if (this._zRun > 0) {
        if (this._zRun >= this._minZero) {
          if (this._zRun > this._blockZeroMax) this._blockZeroMax = this._zRun;
          if (this._blockZeroStart < 0 || this._zStart < this._blockZeroStart) this._blockZeroStart = this._zStart;
        }
        this._zRun = 0;
      }
      this._n++;
      if (++this._j === B) {
        this._j = 0;
        this._block();
      }
    }
  }

  _block() {
    const B = this._B;
    const k = this._k++;
    const start = k * B;
    const I = this._I;
    const Q = this._Q;
    const E = this._E;
    this._I = 0;
    this._Q = 0;
    this._E = 0;
    const P = (2 * (I * I + Q * Q)) / B;
    const A = Math.sqrt((2 * P) / B);
    const phi = Math.atan2(-Q, I);
    const rho = Math.max(0, E - P) / Math.max(E, 1e-20);
    // Zero runs that touch this block: one that ended in it, or the one still open.
    const open = this._zRun >= this._minZero ? this._zRun : 0;
    const zeroHere = open > this._blockZeroMax ? open : this._blockZeroMax;
    let zeroStart = this._blockZeroStart;
    if (open > 0 && (zeroStart < 0 || this._zStart < zeroStart)) zeroStart = this._zStart;
    this._blockZeroMax = 0;
    this._blockZeroStart = -1;

    if (!this._locked) {
      if (A >= this._minTone && rho <= this._residualLimit && zeroHere === 0) {
        if (++this._lockCount >= 10) this._lock(k, phi, A);
      } else {
        this._lockCount = 0;
      }
      return;
    }

    const lost = A < this._lostRatio * this._Aref;
    const smooth = rho <= this._residualLimit && zeroHere === 0;
    let disturbed = !smooth || lost;
    if (!disturbed && this._prevClean) {
      const d = wrap(phi - this._lastPhi - this._drift);
      if (d > this._phaseLimit || d < -this._phaseLimit) disturbed = true;
    }
    // A clean tone, only 20 dB or more quieter than before (a level slider pulled down): after 10 such
    // blocks that is the tone's new level, not a lost tone. Without this the event would never end.
    const step = wrap(phi - this._prevPhi - this._drift);
    const quiet = lost && smooth && step <= this._phaseLimit && step >= -this._phaseLimit;
    this._prevPhi = phi;
    if (disturbed && this._ev && quiet && this._evQuiet + 1 >= 10) {
      this._Aref = A;
      disturbed = false;
    }
    if (disturbed) {
      if (!this._ev) {
        this._ev = true;
        this._evStart = zeroStart >= 0 && zeroStart < start ? zeroStart : start;
        this._evBeforeK = this._lastK;
        this._evBeforePhi = this._lastPhi;
        this._evBeforeA = this._lastA;
        this._evZeroMax = 0;
        this._evLostBlocks = 0;
        this._evQuiet = 0;
        this._evPrime = k - this._armBlock < this._primeBlocks;
      } else if (zeroStart >= 0 && zeroStart < this._evStart) {
        this._evStart = zeroStart;
      }
      if (zeroHere > this._evZeroMax) this._evZeroMax = zeroHere;
      if (lost && !quiet) this._evLostBlocks++;
      this._evQuiet = quiet ? this._evQuiet + 1 : 0;
      this._prevClean = false;
      return;
    }

    if (this._ev) this._close(k, start, phi, A);
    if (this._prevClean) this._drift += (wrap(phi - this._lastPhi) - this._drift) / 256;
    this._Aref += (A - this._Aref) / 16;
    this._lastK = k;
    this._lastPhi = phi;
    this._lastA = A;
    this._prevClean = true;
    this._slow(A, start);
  }

  _lock(k, phi, A) {
    this._locked = true;
    this._Aref = A;
    this._lastK = k;
    this._lastPhi = phi;
    this._lastA = A;
    this._prevPhi = phi;
    this._prevClean = true;
    const db = 20 * Math.log10(A);
    this._lockDb = db;
    this._minStableDb = this._minStableDb === null ? db : Math.min(this._minStableDb, db);
    this._wSum = 0;
    this._wN = 0;
    this._stableDb = null;
    this._chg = false;
  }

  /** The event in progress ends at clean block k: classify it. */
  _close(k, start, phi, A) {
    this._ev = false;
    if (this._evPrime) return; // it began while priming
    const B = this._B;
    const sr = this._sampleRate;
    const zero = this._evZeroMax;
    const frames = start - this._evStart;
    const stepDeg = (wrap(phi - this._evBeforePhi - this._drift * (k - this._evBeforeK)) * 180) / Math.PI;
    const stepDb = A > 0 && this._evBeforeA > 0 ? 20 * Math.log10(A / this._evBeforeA) : 0;
    let kind;
    let holeMs = null;
    if (zero >= this._gapFrames || this._evLostBlocks * B >= this._gapFrames) {
      kind = "gap";
      holeMs = ((zero >= this._gapFrames ? zero : frames) / sr) * 1000;
      this._gaps++;
    } else if (zero >= this._dropoutFrames) {
      kind = "dropout";
      holeMs = (zero / sr) * 1000;
      this._dropouts++;
    } else if (zero >= this._minZero) {
      kind = "hole";
      holeMs = (zero / sr) * 1000;
      this._holes++;
    } else if (Math.abs(stepDeg) >= this._phaseLimitDeg) {
      kind = "skip";
      this._skips++;
    } else if (Math.abs(stepDb) >= this._stepEventDb) {
      kind = "step";
      this._steps++;
    } else {
      kind = "click";
      this._clicks++;
    }
    if (this._events.length >= this._maxEvents) return;
    const ev = { kind, atFrame: this._evStart, frames, phaseStepDeg: round(stepDeg, 1), stepDb: round(stepDb, 2) };
    if (holeMs !== null) ev.holeMs = round(holeMs, 2);
    this._events.push(ev);
  }

  /** The slow level tracker: the mean amplitude of every 10 clean blocks against the last steady level. */
  _slow(A, start) {
    if (this._wN === 0) this._wStart = start;
    this._wSum += A;
    if (++this._wN < 10) return;
    const db = 20 * Math.log10(this._wSum / this._wN);
    const windowStart = this._wStart;
    const windowEnd = start + this._B;
    this._wSum = 0;
    this._wN = 0;
    if (this._stableDb === null) {
      this._stableDb = db;
      return;
    }
    if (!this._chg) {
      if (Math.abs(db - this._stableDb) >= this._levelChangeDb) {
        this._chg = true;
        this._chgFrom = this._stableDb;
        this._chgAt = windowStart;
        this._chgLast = db;
        this._chgCalm = 0;
      }
      return;
    }
    this._chgCalm = Math.abs(db - this._chgLast) <= 0.2 ? this._chgCalm + 1 : 0;
    this._chgLast = db;
    if (this._chgCalm < 3) return;
    this._chg = false;
    this._stableDb = db;
    if (Math.abs(db - this._chgFrom) < this._levelChangeDb) return; // it came back: no change after all
    this._levels++;
    this._minStableDb = this._minStableDb === null ? db : Math.min(this._minStableDb, db);
    if (this._events.length >= this._maxEvents) return;
    this._events.push({
      kind: "level",
      atFrame: this._chgAt,
      frames: windowEnd - this._chgAt,
      fromDb: round(this._chgFrom, 2),
      toDb: round(db, 2),
    });
  }

  /**
   * Events that ended since the last take, oldest first: { kind, atFrame,
   * frames, holeMs?, phaseStepDeg?, stepDb?, fromDb?, toDb? }. At most
   * maxEvents are kept between takes; the counts keep counting.
   */
  takeEvents() {
    const out = this._events;
    this._events = [];
    return out;
  }

  /** Events of each kind so far (never capped). */
  get counts() {
    return {
      holes: this._holes,
      skips: this._skips,
      clicks: this._clicks,
      dropouts: this._dropouts,
      gaps: this._gaps,
      levels: this._levels,
      steps: this._steps,
    };
  }

  /** Audible ticks so far: holes + skips + clicks. */
  get ticks() {
    return this._holes + this._skips + this._clicks;
  }

  /** True once the tone has been found. */
  get locked() {
    return this._locked;
  }

  /** The tone's peak level now, in dBFS (null before the lock). */
  get levelDb() {
    return this._locked && this._Aref > 0 ? 20 * Math.log10(this._Aref) : null;
  }

  /** The tone's level when it was found (the latest lock), in dBFS; null before. */
  get lockDb() {
    return this._lockDb;
  }

  /** The lowest steady level so far: the levels at each lock and every level event's new level. */
  get minStableDb() {
    return this._minStableDb;
  }

  /**
   * The tone's frequency offset in parts per million, from the drift of its
   * phase: about 0 through a FIFO crossing (it drops or repeats whole
   * buffers); not 0 through a resampling route.
   */
  get phaseDriftPpm() {
    return (this._drift / (2 * Math.PI * this._cycles)) * 1e6;
  }

  /** Samples pushed so far. */
  get frame() {
    return this._n;
  }

  /** Look for the tone again (lock and priming start over); counts and events are kept. */
  reset() {
    this._locked = false;
    this._lockCount = 0;
    this._armBlock = this._k;
    this._ev = false;
    this._prevClean = false;
    this._wSum = 0;
    this._wN = 0;
    this._stableDb = null;
    this._chg = false;
  }
}
