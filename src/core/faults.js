/**
 * When the safety mixer may go back to the converted voice after a fault.
 *
 * A fault (the converted voice stalled or went bad, the engine dropped) puts
 * the meeting on the user's own voice at once; this policy decides when the
 * converted voice may come back. In an interview it comes back only when the
 * user asks again (Convert): an accent that flips back and forth by itself is
 * worse than either voice held steady. In practice mode it comes back by
 * itself after a backoff that doubles with each fault in a row (0.5 s, 1 s,
 * 2 s, 4 s, 8 s, then 10 s), and a clean minute of converting starts the
 * backoff over; three faults within two minutes lock it on the user's own
 * voice until they press Convert. Every return also waits for 3 s of healthy
 * converted speech and for a pause, so no word is cut in two.
 *
 * Pure: no clock and no timers. Time comes in as `nowMs` from any monotonic
 * millisecond clock (the mixer's sample count, for example), so the class
 * runs unchanged inside an AudioWorklet.
 */

/** Anything but "practice" is treated as "interview": the mode that never switches by itself. */
function normalizeMode(mode) {
  return mode === "practice" ? "practice" : "interview";
}

/** Faults kept for `faults` at most, however close together: a runaway caller must not grow the list. */
const MAX_KEPT = 32;

/** Consecutive-fault count is capped so the backoff arithmetic stays finite. */
const MAX_STEPS = 30;

export class FaultPolicy {
  /**
   * @param {object} [options]
   * @param {"interview"|"practice"} [options.mode] interview: only the user brings the converted voice back.
   * @param {number} [options.firstRetryMs] practice mode: wait after the first fault in a row.
   * @param {number} [options.maxRetryMs] practice mode: longest wait (the doubling stops here).
   * @param {number} [options.lockFaults] this many faults within `lockWindowMs` lock the own voice.
   * @param {number} [options.lockWindowMs]
   * @param {number} [options.healthyNeededMs] healthy converted speech needed before any return.
   * @param {number} [options.cleanResetMs] converting this long without a fault starts the backoff over.
   */
  constructor({
    mode = "interview",
    firstRetryMs = 500,
    maxRetryMs = 10000,
    lockFaults = 3,
    lockWindowMs = 120000,
    healthyNeededMs = 3000,
    cleanResetMs = 60000,
  } = {}) {
    this.firstRetryMs = firstRetryMs;
    this.maxRetryMs = maxRetryMs;
    this.lockFaults = lockFaults;
    this.lockWindowMs = lockWindowMs;
    this.healthyNeededMs = healthyNeededMs;
    this.cleanResetMs = cleanResetMs;
    this._mode = normalizeMode(mode);
    this._faults = []; // recent faults, oldest first
    this._steps = 0; // faults in a row (backoff step); a clean stretch resets it
    this._retryAtMs = null; // earliest automatic return after the last fault (practice mode)
    this._locked = false;
    // A Convert press since the last fault. True before any fault: the mixer
    // asks only after the user pressed Convert, and nothing has gone wrong yet.
    this._approved = true;
    this._ownByUser = false; // the user chose their own voice: nothing returns until Convert
    this._convertingSinceMs = null; // start of the current converted stretch
  }

  /** "interview" or "practice". */
  get mode() {
    return this._mode;
  }

  /**
   * Switch between "interview" (returns only on Convert) and "practice"
   * (returns by itself after the backoff). Takes effect for the next
   * mayReturn(); a fault already recorded keeps its retry time.
   */
  setMode(mode) {
    this._mode = normalizeMode(mode);
  }

  /** True after `lockFaults` faults within `lockWindowMs`, until userConvert(). */
  get locked() {
    return this._locked;
  }

  /** Recent faults (within lockWindowMs of the latest one), oldest first: [{atMs, reason}] (a copy). */
  get faults() {
    return this._faults.map((f) => ({ atMs: f.atMs, reason: f.reason }));
  }

  /**
   * Record a fault: the mixer has just switched to the user's own voice.
   * Call once per switch away from the converted voice.
   * @param {number} nowMs
   * @param {string} [reason] e.g. "stall", "bad-output", "engine-down"
   * @returns {{locked: boolean, retryAtMs: number|null}} retryAtMs is when practice
   *   mode may return by itself (still needing health and a pause); null in
   *   interview mode and when locked.
   */
  fault(nowMs, reason) {
    this._settle(nowMs);
    this._steps = Math.min(this._steps + 1, MAX_STEPS);
    this._convertingSinceMs = null;
    this._approved = false;
    this._faults.push({ atMs: nowMs, reason: reason ?? null });
    // Window inclusive: faults at 0 s, 60 s and 120 s are "3 faults within 2 minutes".
    while (this._faults.length && nowMs - this._faults[0].atMs > this.lockWindowMs) this._faults.shift();
    while (this._faults.length > MAX_KEPT) this._faults.shift();
    // Faults from before a Convert press still count: if the converter keeps
    // failing right after the user asked for it again, it locks again at once
    // rather than retrying by itself.
    if (this._faults.length >= this.lockFaults) this._locked = true;
    const waitMs = Math.min(this.maxRetryMs, this.firstRetryMs * 2 ** (this._steps - 1));
    this._retryAtMs = nowMs + waitMs;
    return {
      locked: this._locked,
      retryAtMs: this._mode === "practice" && !this._locked ? this._retryAtMs : null,
    };
  }

  /**
   * May the mixer switch back to the converted voice now? Interview mode:
   * only after userConvert() since the last fault. Practice mode: also by
   * itself once the backoff has passed, unless locked. Both need
   * `healthyMs >= healthyNeededMs` and `atPause`; nothing returns after
   * userOwn() until userConvert(). A true answer is taken as the moment the
   * converted voice comes back (the start of a clean stretch for the backoff
   * reset), so call it only when you will act on the answer.
   * @param {{nowMs: number, healthyMs: number, atPause: boolean}} state
   * @returns {boolean}
   */
  mayReturn({ nowMs, healthyMs, atPause } = {}) {
    this._settle(nowMs);
    if (this._ownByUser) return false;
    if (!(healthyMs >= this.healthyNeededMs) || !atPause) return false;
    const automatic =
      this._mode === "practice" && !this._locked && this._retryAtMs !== null && nowMs >= this._retryAtMs;
    if (!this._approved && !automatic) return false;
    if (this._convertingSinceMs === null) this._convertingSinceMs = nowMs;
    return true;
  }

  /**
   * The user pressed Convert: clears the lock and allows a return (which
   * still needs health and a pause), in either mode, without waiting for the
   * backoff.
   * @param {number} [nowMs]
   */
  userConvert(nowMs) {
    this._settle(nowMs);
    this._ownByUser = false;
    this._approved = true;
    this._locked = false;
  }

  /**
   * The user pressed own voice: no return, automatic or approved, until
   * userConvert(). Pass `nowMs` so a clean stretch that ends here still
   * resets the backoff.
   * @param {number} [nowMs]
   */
  userOwn(nowMs) {
    this._settle(nowMs);
    this._ownByUser = true;
    this._convertingSinceMs = null;
  }

  /** A converted stretch of `cleanResetMs` without a fault starts the backoff over. */
  _settle(nowMs) {
    if (this._convertingSinceMs !== null && nowMs - this._convertingSinceMs >= this.cleanResetMs) this._steps = 0;
  }
}
