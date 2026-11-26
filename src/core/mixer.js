/**
 * The safety mixer: the voice the meeting hears.
 *
 * It runs in the AudioWorklet that feeds the virtual cable (48 kHz, 128-sample
 * blocks) with two inputs: the user's mic ("original", content time = now)
 * and the accent converter's output ("converted", arrival time = now, D ms
 * behind the original, D about 250-450 ms). The meeting hears the converted
 * voice while it follows the original, and the user's own voice otherwise.
 * In a live interview the mic must never go silent or garbled for long, no
 * word may be lost, and the accent must not flip back and forth by itself:
 * - Convert: the converted voice comes in only when the engine's media flows,
 *   D is known, the stall detector has heard 3 s of healthy converted speech
 *   since (FaultPolicy decides) and everything between what the original
 *   plays and what the converted voice plays is a pause, so the switch cuts,
 *   skips and repeats no word. Equal-power crossfade of toConvertedMs.
 * - A fault (the converted voice stalls, NaN or a burst, the engine drops, a
 *   fault the main thread reports): the user's own voice comes back at once
 *   (toOwnMs), replayed from where the converted voice stopped, and the
 *   OriginalTimeline catches up with the live mic by shortening pauses. In
 *   an interview the converted voice comes back only after the user presses
 *   Convert again; in practice mode by itself, after FaultPolicy's backoff.
 * - The user's "own voice" (or "off") while converting replays the original
 *   from the converted voice's position too: the same words, in their voice.
 * - Lip sync (the video is delayed by L): both voices come out L after the
 *   user spoke, the original through the timeline's lag, the converted
 *   through a delay line of L - D. A new D (or L) moves the converted voice
 *   only in a pause. In low-delay mode (L = null) the original is a
 *   passthrough and the converted voice plays as it arrives.
 * The converted voice is brought slowly to the original's speech level, and
 * a peak limiter guards the output. Silence in gives silence out.
 *
 * Pause checks look at what is being played, in content time: the
 * main Vad's speech runs (from a little before its flag rose to the end of
 * the last speech frame) are kept for the last few seconds, so "is the
 * converted voice in a pause?" is answered for content D (or L) ago, not for
 * the live mic.
 *
 * Pure (no DOM, no Web Audio, no clock, no timers): time is the number of
 * samples processed, so it runs unchanged in the AudioWorklet and in Node
 * tests. Allocation-free per block, apart from the events it queues (a few
 * per second).
 */

import { Vad, frameDb } from "./vad.js";
import { StallDetector } from "./stall.js";
import { FaultPolicy } from "./faults.js";
import { OriginalTimeline } from "./timeline.js";

const OFF = "off";
const CONNECTING = "connecting";
const CONVERTING = "converting";
const OWN_MANUAL = "own-manual";
const OWN_FAULT = "own-fault";

const HALF_PI = Math.PI / 2;

/** Blocks longer than this are handled in pieces (decisions are taken once per piece). */
const MAX_BLOCK = 1024;

/** Queued events kept at most: a caller that never takes them must not grow memory. */
const MAX_EVENTS = 256;

/** Speech runs of the original kept for the pause checks: many more than the few seconds they look back. */
const RUNS = 64;

/** takeEvents() with nothing queued: one shared, frozen empty list (no allocation per block). */
const NO_EVENTS = Object.freeze([]);

/** The limiter's gain snaps back to exactly 1 this close to it (-0.00001 dB), so a passthrough is bit-exact again. */
const UNITY = 1 - 1e-6;

/** The converted stream is float audio in [-1, 1]; a runaway value is clipped before it can drive the limiter far down. */
const CONV_MAX = 1;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function reasonOf(msg, fallback) {
  return typeof msg.reason === "string" && msg.reason ? msg.reason : fallback;
}

export class SafetyMixer {
  /**
   * @param {object} [options]
   * @param {number} [options.sampleRate=48000]
   * @param {"interview"|"practice"} [options.mode="interview"] interview: after a fault only Convert brings the converted voice back
   * @param {number|null} [options.lipSyncMs=null] lip-sync total delay L (ms); null = low-delay mode
   * @param {number} [options.toOwnMs=30] crossfade to the user's own voice
   * @param {number} [options.toConvertedMs=60] crossfade to the converted voice
   * @param {number} [options.maxGainDb=6] the converted voice's level correction is at most this, either way
   * @param {number} [options.limitDb=-1] output peak limit, dBFS
   * @param {number} [options.gainSlewDbPerSec=1] the level correction moves at most this fast while the converted voice is heard
   * @param {number} [options.releaseMs=50] limiter release time constant
   * @param {number} [options.replayLeadMs=30] a stall replay starts this much before the stall start, so its fade-in is over by then
   * @param {number} [options.guessBackMs=100] other faults replay from this much before the converted voice's position
   * @param {number} [options.pauseMarginMs=40] pause checks reach this far either side (D may be off by the stall detector's ±40 ms)
   * @param {number} [options.catchUpHangMs=100] hangover of the speech flag the timeline shortens pauses by
   * @param {number} [options.maxLipSyncMs=1000] longest lip-sync delay (the delay line's memory)
   * @param {number} [options.delayFadeMs=5] crossfade when the converted delay line moves
   * @param {number} [options.envelopeHopMs=5] envelope events: one level (over two hops) every hopMs ...
   * @param {number} [options.envelopeEveryMs=250] ... sent this often
   * @param {number} [options.historyMs=4000] how far back a replay can reach
   * @param {object} [options.vadOptions] for the Vad (the sample rate is the mixer's)
   * @param {object} [options.stallOptions] for the StallDetector
   * @param {object} [options.faultOptions] for the FaultPolicy (mode comes from `mode`)
   * @param {object} [options.timelineOptions] for the OriginalTimeline
   */
  constructor({
    sampleRate = 48000,
    mode = "interview",
    lipSyncMs = null,
    toOwnMs = 30,
    toConvertedMs = 60,
    maxGainDb = 6,
    limitDb = -1,
    gainSlewDbPerSec = 1,
    releaseMs = 50,
    replayLeadMs = 30,
    guessBackMs = 100,
    pauseMarginMs = 40,
    catchUpHangMs = 100,
    maxLipSyncMs = 1000,
    delayFadeMs = 5,
    envelopeHopMs = 5,
    envelopeEveryMs = 250,
    historyMs = 4000,
    vadOptions = {},
    stallOptions = {},
    faultOptions = {},
    timelineOptions = {},
  } = {}) {
    const n = (ms) => Math.max(0, Math.round((ms * sampleRate) / 1000));
    this.sampleRate = sampleRate;
    this.maxGainDb = Math.max(0, maxGainDb);
    this._toOwnStep = 1 / Math.max(1, n(toOwnMs));
    this._toConvLen = Math.max(1, n(toConvertedMs));
    this._toConvStep = 1 / this._toConvLen;
    this._limit = 10 ** (limitDb / 20);
    this._release = Math.exp(-1 / Math.max(1, n(releaseMs)));
    this._slew = gainSlewDbPerSec / sampleRate; // dB per sample
    this._lead = n(replayLeadMs);
    this._guessBack = n(guessBackMs);
    this._margin = n(pauseMarginMs);
    this._maxLipMs = Math.max(0, maxLipSyncMs);
    this._maxLip = n(this._maxLipMs);

    // All four count samples from the same first block, so their positions agree.
    this._vad = new Vad({ ...vadOptions, sampleRate });
    // The timeline's pause flag: the same detector with a short hangover. With 300 ms, the
    // pauses it may shorten would be 300 ms shorter than the real ones and catching up after a
    // replay would take twice as many pauses; its keepPauseMs and word-start guard protect the rest.
    this._flagVad = new Vad({ ...vadOptions, sampleRate, hangMs: catchUpHangMs });
    this._stall = new StallDetector({ ...stallOptions, sampleRate });
    this._policy = new FaultPolicy({ ...faultOptions, mode });
    this._timeline = new OriginalTimeline({ historyMs, ...timelineOptions, sampleRate });
    // Content this new may hold a word the Vad has not flagged yet (attack plus a frame).
    this._unflagged = (this._vad.attackFrames + 1) * this._vad.frameLen;

    // The converted delay line (lip sync), indexed by arrival time.
    this._ccap = this._maxLip + 2 * MAX_BLOCK + 1;
    this._cring = new Float32Array(this._ccap);
    this._convDelay = 0; // samples
    this._cdLen = Math.max(1, n(delayFadeMs));
    this._cdIn = new Float32Array(this._cdLen);
    this._cdOut = new Float32Array(this._cdLen);
    for (let j = 0; j < this._cdLen; j++) {
      const t = ((j + 0.5) / this._cdLen) * HALF_PI;
      this._cdIn[j] = Math.sin(t);
      this._cdOut[j] = Math.cos(t);
    }
    this._cdFrom = 0; // the delay the line is moving away from
    this._cdLeft = 0; // samples of that move still to crossfade

    // Scratch: orig in, conv in (when the caller's arrays do not fit), the two paths' output.
    this._bufs = [0, 1, 2, 3].map(() => new Float32Array(MAX_BLOCK));
    this._viewN = -1;
    this._views = null;

    // Speech runs of the original, content time: [start, end); end = Infinity while open.
    this._runStart = new Float64Array(RUNS);
    this._runEnd = new Float64Array(RUNS);
    this._runCount = 0;
    this._runOpen = false;
    this._known = -Infinity; // runs before this were forgotten: content there counts as speech

    // Envelopes for the main thread's LatencyTracker (as envelopeDb with winMs = 2 hops).
    this._hop = Math.max(1, n(envelopeHopMs));
    this._hopMs = (this._hop * 1000) / sampleRate;
    this._envPer = Math.max(1, Math.round(envelopeEveryMs / this._hopMs));
    this._envO = new Float32Array(this._envPer);
    this._envC = new Float32Array(this._envPer);
    this._envN = 0;
    this._envFrame = 0; // index of the first frame of the next event
    this._hopO = 0;
    this._hopC = 0;
    this._hopFill = 0;
    this._prevO = 0;
    this._prevC = 0;
    this._havePrev = false;

    this._events = [];
    this._ask = { nowMs: 0, healthyMs: 0, atPause: false }; // reused for every mayReturn()

    this._state = OFF;
    this._pos = 0; // samples taken in: the content time of the next original sample
    this._outAt = 0; // time of the next output sample (= _pos between blocks)
    this._bad = false; // non-finite samples in the converted block just taken in
    this._media = false;
    this._D = null; // applied D (ms) or null
    this._Ds = 0;
    this._pendingD = undefined; // a new D waiting for a pause (undefined = none)
    this._L = null; // lip-sync L (ms) or null
    this._Ls = 0; // the original's target lag (samples)
    this._x = 0; // crossfade position: 0 = original, 1 = converted
    this._xTarget = 0;
    this._xStep = this._toOwnStep;
    this._gainDb = 0; // the converted voice's level correction
    this._gainLin = 1;
    this._limG = 1;
    this._setLipSync(lipSyncMs);
    this._applyPending();
  }

  /** "off" | "connecting" | "converting" | "own-manual" | "own-fault". */
  get state() {
    return this._state;
  }

  /** The D in use (ms), or null while unknown. A new D waits for a pause while the converted voice is heard. */
  get delayMs() {
    return this._D;
  }

  /** Lip-sync total delay L (ms), or null in low-delay mode. */
  get lipSyncMs() {
    return this._L;
  }

  /** Healthy converted speech heard since the last miss run, fault or reset (ms; StallDetector.healthyMs). */
  get healthyMs() {
    return this._stall.healthyMs;
  }

  /** How far the original path is behind the live mic (ms): L once caught up in lip sync, else 0. */
  get originalLagMs() {
    return (this._timeline.lagSamples * 1000) / this.sampleRate;
  }

  /** Level correction applied to the converted voice (dB). */
  get gainDb() {
    return this._gainDb;
  }

  /**
   * One render block. `orig`: the mic (content time = now); `conv`: the
   * converted voice (arrival time = now); `out`: the destination. All the
   * same length (a missing or short input counts as silence).
   * @param {Float32Array|null} orig
   * @param {Float32Array|null} conv
   * @param {Float32Array} out
   */
  process(orig, conv, out) {
    const n = out.length;
    if (n <= MAX_BLOCK) {
      this._piece(orig, conv, out, n);
      return;
    }
    for (let i = 0; i < n; i += MAX_BLOCK) {
      const e = Math.min(n, i + MAX_BLOCK);
      const o = orig ? orig.subarray(i, e) : null;
      const c = conv ? conv.subarray(i, e) : null;
      this._piece(o, c, out.subarray(i, e), e - i);
    }
  }

  /**
   * A message from the main thread:
   * - {type:"convert"}: the user wants the converted voice ("connecting" until it may come in).
   * - {type:"own"}: the user's own voice now ("own-manual"; idempotent).
   * - {type:"off"}: passthrough, engine not needed ("off").
   * - {type:"engine", status:"media"|"down", reason}: packets flowing, or the engine dropped (a fault while converting).
   * - {type:"fault", reason}: any other fault the main thread sees (a fault while converting).
   * - {type:"delay", ms}: a new D estimate (null = unknown); used from the next pause.
   * - {type:"lipSync", totalMs}: lip-sync total delay L (null = low-delay mode).
   * - {type:"mode", mode}: "interview" | "practice".
   * Anything else is ignored.
   * @param {object} msg
   */
  command(msg) {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "convert":
        this._policy.userConvert(this._nowMs());
        if (this._state !== CONVERTING && this._state !== CONNECTING) this._setState(CONNECTING, "user");
        break;
      case "own":
        this._policy.userOwn(this._nowMs());
        if (this._state !== OWN_MANUAL) this._toOwn(OWN_MANUAL, "user", this._convPos());
        break;
      case "off":
        this._policy.userOwn(this._nowMs());
        if (this._state !== OFF) this._toOwn(OFF, "user", this._convPos());
        break;
      case "engine":
        if (msg.status === "media") {
          // Healthy speech counts from when the media flows: not from a session that was down.
          if (!this._media) this._stall.reset();
          this._media = true;
        } else if (msg.status === "down") {
          this._media = false;
          this._fault("engine-down", reasonOf(msg, "engine down"), this._convPos() - this._guessBack);
        }
        break;
      case "fault":
        this._fault("main", reasonOf(msg, "fault"), this._convPos() - this._guessBack);
        break;
      case "delay":
        this._pendingD = typeof msg.ms === "number" && Number.isFinite(msg.ms) ? Math.max(0, msg.ms) : null;
        this._applyPending();
        break;
      case "lipSync":
        this._setLipSync(msg.totalMs);
        this._applyPending();
        break;
      case "mode":
        this._policy.setMode(msg.mode);
        break;
      default:
        break;
    }
  }

  /**
   * Returns the queued events and clears the queue (an empty, frozen list when
   * there are none): {type:"state", state, reason}; {type:"fault", kind,
   * reason, atMs, locked, retryAtMs, replayFrom} (replayFrom: the content
   * sample the original is replayed from); {type:"envelopes", orig, conv,
   * hopMs, frame} with the levels (dB) of both inputs, about every 250 ms
   * (frame = index of the first one, counted from the first sample).
   * @returns {object[]}
   */
  takeEvents() {
    if (this._events.length === 0) return NO_EVENTS;
    const list = this._events;
    this._events = [];
    return list;
  }

  // ---- one block ----------------------------------------------------------

  _piece(orig, conv, out, n) {
    if (n === 0) return;
    const v = this._viewsFor(n);
    const o = orig && orig.length === n ? orig : this._fit(orig, v[0], n);
    const c = conv && conv.length === n ? conv : this._fit(conv, v[1], n);
    this._take(o, c, n);
    this._decide();
    this._render(v[2], v[3], out, n);
  }

  /** Inputs into the detectors, the timeline, the delay line and the envelopes. */
  _take(orig, conv, n) {
    const ring = this._cring;
    const cap = this._ccap;
    const hop = this._hop;
    let w = this._pos % cap;
    let bad = false;
    let so = this._hopO;
    let sc = this._hopC;
    let fill = this._hopFill;
    for (let i = 0; i < n; i++) {
      let c = conv[i];
      if (c - c !== 0) {
        c = 0; // NaN or ±Infinity never reaches the output
        bad = true;
      } else if (c > CONV_MAX) c = CONV_MAX;
      else if (c < -CONV_MAX) c = -CONV_MAX;
      ring[w] = c;
      if (++w === cap) w = 0;
      const x = orig[i];
      if (x - x === 0) so += x * x;
      sc += c * c;
      if (++fill === hop) {
        this._envelope(so, sc);
        so = 0;
        sc = 0;
        fill = 0;
      }
    }
    this._hopO = so;
    this._hopC = sc;
    this._hopFill = fill;
    this._bad = bad;

    this._vad.push(orig);
    this._flagVad.push(orig);
    this._pos += n;
    this._trackRuns(n);
    this._stall.push(orig, conv, this._D, this._vad.speaking);
    this._timeline.write(orig, this._flagVad.speaking);
  }

  /** Faults, a pending D, and the way back to the converted voice. */
  _decide() {
    const stall = this._stall;
    if (this._state === CONVERTING) {
      if (this._bad || stall.badOutput) {
        this._fault("bad-output", this._bad ? "non-finite samples" : "level burst", this._convPos() - this._guessBack);
      } else if (stall.stalled) {
        // Where the converted voice stopped, a little earlier so the replay's fade-in is over by
        // then; or where the listener is, if the delay line has not played that far yet.
        this._fault("stall", "converted voice stopped", Math.min(this._convPos(), stall.stallStartSample - this._lead));
      }
    } else if (stall.stalled || stall.badOutput) {
      stall.reset(); // not on the air: nothing to switch, but the converted voice must prove itself again
    }
    if (this._pendingD !== undefined || this._convDelay !== this._wantedDelay(this._D)) this._applyPending();
    if (this._state === CONNECTING || this._state === OWN_FAULT) this._tryReturn();
  }

  _render(origOut, convOut, out, n) {
    this._timeline.read(origOut, this._Ls);
    const g0 = this._gainLin;
    this._updateGain(n);
    if (this._x > 0 || this._xTarget === 1) this._readConv(convOut, n, g0, this._gainLin);
    else this._cdLeft = 0; // unheard: a move of the delay line needs no crossfade
    this._mix(origOut, convOut, out, n);
    this._outAt += n;
  }

  // ---- switching ----------------------------------------------------------

  _setState(state, reason) {
    if (state === this._state) return;
    this._state = state;
    this._emit({ type: "state", state, reason });
  }

  /** Crossfade to the original; leaving the converted voice, replay the original from `replayFrom` (content time). */
  _toOwn(state, reason, replayFrom) {
    if (this._state === CONVERTING) this._timeline.jumpTo(replayFrom);
    this._xTarget = 0;
    this._xStep = this._toOwnStep;
    this._setState(state, reason);
  }

  /** A fault: only matters while converting (then to the user's own voice, replayed); otherwise health starts over. */
  _fault(kind, reason, replayFrom) {
    if (this._state !== CONVERTING) {
      this._stall.reset();
      return;
    }
    const atMs = this._nowMs();
    const { locked, retryAtMs } = this._policy.fault(atMs, kind);
    this._stall.reset(); // healthy speech is counted afresh from here
    const tl = this._timeline;
    const from = clamp(Math.round(replayFrom), Math.max(0, tl.writePos - tl.historySamples), tl.writePos);
    this._emit({ type: "fault", kind, reason, atMs, locked, retryAtMs, replayFrom: from });
    this._toOwn(OWN_FAULT, kind, from);
  }

  /** Connecting, or own voice after a fault: switch to the converted voice when everything allows it. */
  _tryReturn() {
    if (!this._media || this._D === null) return;
    const healthy = this._stall.healthyMs;
    if (!(healthy >= this._policy.healthyNeededMs)) return;
    if (!this._switchPause()) return;
    // Asked only now: a true answer starts the policy's clean stretch, so it must lead to the switch.
    const ask = this._ask;
    ask.nowMs = this._nowMs();
    ask.healthyMs = healthy;
    ask.atPause = true;
    if (!this._policy.mayReturn(ask)) return;
    const reason = this._state === CONNECTING ? "ready" : "retry";
    this._xTarget = 1;
    this._xStep = this._toConvStep;
    this._setState(CONVERTING, reason);
  }

  /**
   * May the voices switch now? The original plays content from its read
   * position, the converted voice from where it is (content time); the
   * switch moves the listener from one to the other, so everything from the
   * earlier of the two to the later one plus the crossfade must be a pause
   * (with margins). Only the two crossfades are not enough: when the
   * replayed original still lags behind, a word between them would be
   * skipped (or, the other way round, said twice).
   */
  _switchPause() {
    const o = this._timeline.writePos - this._timeline.lagSamples;
    const c = this._convPos();
    return !this._speechIn(Math.min(o, c) - this._margin, Math.max(o, c) + this._toConvLen + this._margin);
  }

  // ---- D, L and the delay line ---------------------------------------------

  _setLipSync(ms) {
    if (typeof ms !== "number" || !Number.isFinite(ms)) {
      this._L = null;
      this._Ls = 0;
    } else {
      this._L = clamp(ms, 0, this._maxLipMs);
      this._Ls = Math.round((this._L * this.sampleRate) / 1000);
    }
  }

  /** Converted delay line for D (ms or null): L - D in lip sync (>= 0), else 0. */
  _wantedDelay(D) {
    if (this._L === null) return 0;
    const d = this._Ls - (D === null ? 0 : Math.round((D * this.sampleRate) / 1000));
    return clamp(d, 0, this._maxLip);
  }

  /**
   * Bring a new D (and the delay line L - D) into use. While the converted
   * voice is not heard, at once. While it is heard: in low-delay mode the
   * output does not depend on D, so at the first pause of the original; in
   * lip sync the converted voice moves, so only when what it plays, before
   * and after the move, is a pause. An unknown D never replaces a known one
   * while the converted voice is heard (it would go unwatched).
   */
  _applyPending() {
    const nextD = this._pendingD !== undefined ? this._pendingD : this._D;
    const nextDs = nextD === null ? 0 : Math.round((nextD * this.sampleRate) / 1000);
    const nextCd = this._wantedDelay(nextD);
    const heard = this._state === CONVERTING || this._x > 0;
    if (heard) {
      if (nextD === null) return;
      if (nextCd !== this._convDelay) {
        const at = this._outAt - nextDs;
        const hi = Math.max(nextCd, this._convDelay);
        const lo = Math.min(nextCd, this._convDelay);
        if (this._speechIn(at - hi - this._margin, at - lo + this._cdLen + this._margin)) return;
      } else if (this._vad.speaking) return;
    }
    this._D = nextD;
    this._Ds = nextDs;
    this._pendingD = undefined;
    if (nextCd !== this._convDelay) {
      this._cdFrom = this._convDelay;
      this._cdLeft = heard ? this._cdLen : 0;
      this._convDelay = nextCd;
    }
  }

  /** Content time of the converted voice at the next output sample. */
  _convPos() {
    return this._outAt - this._Ds - this._convDelay;
  }

  _nowMs() {
    return (this._outAt * 1000) / this.sampleRate;
  }

  // ---- speech runs (pause checks) -----------------------------------------

  /** Record where the original's speech runs start and end (content time). */
  _trackRuns(n) {
    const vad = this._vad;
    if (vad.speaking) {
      if (this._runOpen) return;
      const k = this._runCount % RUNS;
      if (this._runCount >= RUNS) this._known = this._runEnd[k];
      // The flag rose after attackFrames speech frames, the first of which began at most this far back.
      this._runStart[k] = Math.max(0, this._pos - n - this._unflagged);
      this._runEnd[k] = Infinity;
      this._runCount++;
      this._runOpen = true;
    } else if (this._runOpen) {
      // The flag fell hangMs after the last speech frame: the run ended there.
      const k = (this._runCount - 1) % RUNS;
      const end = this._pos - Math.round((vad.pauseMs * this.sampleRate) / 1000);
      this._runEnd[k] = Math.max(this._runStart[k], end);
      this._runOpen = false;
    }
  }

  /**
   * Does content [a, b) hold (or may it hold) speech? A run overlapping it,
   * content older than the runs kept, or, near the live edge, a loud frame
   * the Vad has not flagged yet (a word starting).
   */
  _speechIn(a, b) {
    const vad = this._vad;
    if (b > this._pos - this._unflagged && !vad.speaking && vad.levelDb > vad.thresholdDb) return true;
    for (let k = this._runCount - 1, stop = Math.max(0, this._runCount - RUNS); k >= stop; k--) {
      const s = k % RUNS;
      if (this._runEnd[s] <= a) break;
      if (this._runStart[s] < b) return true;
    }
    return a < this._known;
  }

  // ---- signal path --------------------------------------------------------

  /** Level correction: -offsetDb within ±maxGainDb, at most gainSlewDbPerSec while heard, at once while not. */
  _updateGain(n) {
    const target = clamp(-this._stall.offsetDb, -this.maxGainDb, this.maxGainDb);
    let g = this._gainDb;
    if (this._x > 0 || this._xTarget === 1) {
      const step = this._slew * n;
      g = target > g + step ? g + step : target < g - step ? g - step : target;
    } else g = target;
    if (g !== this._gainDb) {
      this._gainDb = g;
      this._gainLin = 10 ** (g / 20);
    }
  }

  /** The converted voice at the next n output times: through the delay line, gain ramping g0 -> g1. */
  _readConv(out, n, g0, g1) {
    const ring = this._cring;
    const cap = this._ccap;
    const t0 = this._outAt;
    let r = (((t0 - this._convDelay) % cap) + cap) % cap; // before the first sample: never written, 0
    const dg = (g1 - g0) / n;
    if (this._cdLeft > 0) {
      // The line moved (in a pause): crossfade from the old read position to the new one.
      let q = (((t0 - this._cdFrom) % cap) + cap) % cap;
      for (let i = 0; i < n; i++) {
        let v = ring[r];
        if (this._cdLeft > 0) {
          const j = this._cdLen - this._cdLeft--;
          v = this._cdIn[j] * v + this._cdOut[j] * ring[q];
        }
        out[i] = (g0 + dg * (i + 1)) * v;
        if (++r === cap) r = 0;
        if (++q === cap) q = 0;
      }
    } else if (dg === 0) {
      for (let i = 0; i < n; i++) {
        out[i] = g0 * ring[r];
        if (++r === cap) r = 0;
      }
    } else {
      for (let i = 0; i < n; i++) {
        out[i] = (g0 + dg * (i + 1)) * ring[r];
        if (++r === cap) r = 0;
      }
    }
  }

  /** Equal-power crossfade between the paths, then the peak limiter (instant attack, exponential release). */
  _mix(o, c, out, n) {
    const thr = this._limit;
    const rel = this._release;
    let g = this._limG;
    let x = this._x;
    const target = this._xTarget;
    if (x === target) {
      const src = x === 0 ? o : c;
      for (let i = 0; i < n; i++) {
        const y = src[i];
        if (g < 1) {
          g = 1 - (1 - g) * rel;
          if (g > UNITY) g = 1;
        }
        const a = y < 0 ? -y : y;
        if (a * g > thr) g = thr / a;
        out[i] = y * g;
      }
    } else {
      const step = this._xStep;
      for (let i = 0; i < n; i++) {
        if (x < target) {
          x += step;
          if (x > 1) x = 1;
        } else if (x > target) {
          x -= step;
          if (x < 0) x = 0;
        }
        const t = x * HALF_PI;
        const y = Math.cos(t) * o[i] + Math.sin(t) * c[i];
        if (g < 1) {
          g = 1 - (1 - g) * rel;
          if (g > UNITY) g = 1;
        }
        const a = y < 0 ? -y : y;
        if (a * g > thr) g = thr / a;
        out[i] = y * g;
      }
    }
    this._x = x;
    this._limG = g;
  }

  // ---- envelopes and events -----------------------------------------------

  /** One hop of both inputs done: a level over the last two hops (as envelopeDb with winMs = 2 hops). */
  _envelope(so, sc) {
    if (this._havePrev) {
      const win = 2 * this._hop;
      const k = this._envN++;
      this._envO[k] = frameDb(this._prevO + so, win);
      this._envC[k] = frameDb(this._prevC + sc, win);
      if (this._envN === this._envPer) {
        this._emit({
          type: "envelopes",
          orig: this._envO.slice(),
          conv: this._envC.slice(),
          hopMs: this._hopMs,
          frame: this._envFrame,
        });
        this._envFrame += this._envPer;
        this._envN = 0;
      }
    }
    this._prevO = so;
    this._prevC = sc;
    this._havePrev = true;
  }

  _emit(event) {
    if (this._events.length >= MAX_EVENTS) this._events.shift();
    this._events.push(event);
  }

  // ---- scratch ------------------------------------------------------------

  _viewsFor(n) {
    if (this._viewN !== n) {
      this._views = this._bufs.map((b) => b.subarray(0, n));
      this._viewN = n;
    }
    return this._views;
  }

  /** A missing or wrong-length input as an n-sample block (silence where it has nothing). */
  _fit(src, view, n) {
    view.fill(0);
    if (src) for (let i = 0, m = Math.min(n, src.length); i < m; i++) view[i] = src[i];
    return view;
  }
}
