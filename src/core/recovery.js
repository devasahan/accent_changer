/**
 * Keeps the voice flowing into VB-CABLE: one reducer runs the first start,
 * the user's changes (another microphone, another output) and the recovery
 * after faults (Windows Audio restarted, the headset unplugged, the audio
 * device reported an error).
 *
 * The graph feeds it events (the context's state and errors, the mic track
 * ending, device changes, heartbeats from the meter worklet, the results of
 * the operations it asked for, timers it set, user requests) and carries out
 * the actions it answers with: resume the context, rebuild the graph, reopen
 * the microphone, set or clear a timer, report what happened. Only one
 * operation is in flight at a time. An operation is not trusted until a
 * heartbeat of a routed generation arrives (the meter worklet's message, made
 * on the audio thread), so a context that says "running" but plays nothing
 * is caught. Recovery never gives up: it retries every 250 ms for the first
 * 15 s of an outage, then every second, and at once when the devices come
 * back. Timers are backstops only: device events, heartbeats and errors
 * arrive as events and are never throttled in a hidden window.
 *
 * Every fault outage is logged with its timings, so the Gate 1 row "Windows
 * Audio restart: voice back within 2 s" can tell Windows' own restart time
 * from the app's part.
 *
 * Pure: no timers, no clock. Time comes in as `nowMs` (the page's
 * performance.now()), and timers go out as actions.
 */
import { redact } from "./redact.js";

export const RECOVERY_DEFAULTS = Object.freeze({
  verifyMs: 600, // after an op resolves, a heartbeat of a routed generation must arrive within this
  fastRetryMs: 250, // retry interval during the first fastWindowMs of an outage …
  fastWindowMs: 15000,
  slowRetryMs: 1000, // … then this, forever
  startBusyRetryMs: 5000, // first start only: the mic is held by another app (NotReadableError)
  waitBackstopMs: 2000, // first start only: no mic / no cable yet; a devices event usually comes first
  stillTryingEvery: 10, // report "still-trying" at attempts 5, 15, 25, …
  maxLog: 20,
});

const KINDS = ["blocked", "busy", "missing", "transient", "needs-gesture"];

function classify(err, depth) {
  if (!err || typeof err !== "object") return "transient";
  const name = typeof err.name === "string" ? err.name : "";
  if (name === "MicError") {
    switch (err.code) {
      case "blocked":
      case "is-cable":
      case "is-virtual":
        return "blocked";
      case "busy":
        return "busy";
      case "missing":
        return "missing";
      case "other": {
        const cause = err.cause;
        const named = cause && typeof cause === "object" && typeof cause.name === "string" && cause.name !== "";
        return named && depth < 4 ? classify(cause, depth + 1) : "transient";
      }
      default:
        return "transient";
    }
  }
  if (typeof err.kind === "string") return KINDS.includes(err.kind) ? err.kind : "transient"; // a SinkError
  switch (name) {
    case "NeedsGesture":
      return "needs-gesture";
    case "NotAllowedError":
    case "SecurityError":
      return "blocked";
    case "NotReadableError":
    case "AbortError":
      return "busy";
    case "NotFoundError":
    case "OverconstrainedError":
      return "missing";
    default:
      return "transient"; // TimeoutError, InvalidStateError, ResumeFailed, anything unknown
  }
}

/**
 * What kind of failure an error is: "blocked" | "busy" | "missing" |
 * "transient" | "needs-gesture".
 *  - A MicError (name "MicError") by its code: "blocked", "is-cable",
 *    "is-virtual" → "blocked"; "busy" → "busy"; "missing" → "missing";
 *    "other" → its cause's kind when the cause has a name, else "transient".
 *  - A SinkError (an object with a string `kind`): that kind when it is one
 *    of the five, else "transient".
 *  - Name "NeedsGesture" → "needs-gesture".
 *  - DOMException names: NotAllowedError, SecurityError → "blocked";
 *    NotReadableError, AbortError → "busy"; NotFoundError,
 *    OverconstrainedError → "missing"; anything else (TimeoutError,
 *    InvalidStateError, "ResumeFailed", unknown, no error at all) →
 *    "transient".
 * @param {*} err
 * @returns {string}
 */
export function classifyError(err) {
  return classify(err, 0);
}

/** The cause of a fault event, and what it breaks; null for events that are not faults. */
function faultOf(ev) {
  switch (ev.type) {
    case "context-state":
      if (ev.state === "suspended" || ev.state === "interrupted") return { cause: "context-suspended", context: true };
      if (ev.state === "closed") return { cause: "context-closed", context: true };
      return null;
    case "context-error":
      return { cause: ev.stalled ? "render-stalled" : "render-error", context: true };
    case "sink-changed":
      return ev.matches === true ? null : { cause: "sink-changed", context: true };
    case "mic-ended":
      return { cause: "mic-ended", mic: true };
    default:
      return null;
  }
}

/** An error as the outage keeps it: name, message (redacted: Chromium's messages can hold a device id), code, kind. */
function summarize(err) {
  if (err && typeof err === "object") {
    const out = {
      name: typeof err.name === "string" && err.name ? err.name : "Error",
      message: redact(typeof err.message === "string" ? err.message : ""),
    };
    if (typeof err.code === "string") out.code = err.code;
    if (typeof err.kind === "string") out.kind = err.kind;
    return out;
  }
  return { name: "Error", message: redact(err === undefined || err === null ? "" : String(err)) };
}

const isMicError = (err) => Boolean(err && typeof err === "object" && err.name === "MicError");

const report = (kind, fields) => ({ do: "report", kind, ...fields });

/** The fields of an outage that callers see (a copy: later changes do not reach a report already made). */
function publicOutage(o) {
  return {
    kind: o.kind,
    cause: o.cause,
    lostAtMs: o.lostAtMs,
    attempts: o.attempts,
    steps: o.steps.slice(),
    needContext: o.needContext,
    needMic: o.needMic,
    dirty: o.dirty,
    lastError: o.lastError ? { ...o.lastError } : null,
    lastFailAtMs: o.lastFailAtMs,
    opStartedAtMs: o.opStartedAtMs,
    firstOkOpStartedAtMs: o.firstOkOpStartedAtMs,
    devicesGoneAtMs: o.devicesGoneAtMs,
    devicesBackAtMs: o.devicesBackAtMs,
    micToo: o.everContext && o.everMic,
  };
}

const copyRecord = (r) => (r ? { ...r, steps: r.steps.slice() } : null);

/** Options merged over the defaults; a value that is not a finite number keeps the default. */
function mergeOptions(options) {
  const out = { ...RECOVERY_DEFAULTS };
  if (options && typeof options === "object") {
    for (const key of Object.keys(RECOVERY_DEFAULTS)) {
      const v = options[key];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[key] = v;
    }
  }
  out.stillTryingEvery = Math.max(1, Math.round(out.stillTryingEvery));
  out.maxLog = Math.max(1, Math.round(out.maxLog));
  return out;
}

/**
 * The reducer. One instance per graph. Phases:
 *  - "idle": not started (or stopped); every event is ignored.
 *  - "running": the voice flows; faults start a recovery, user requests a change.
 *  - "recovering": an op (resume, rebuild, reopen-mic) is in flight.
 *  - "verifying": the op succeeded; waiting for a heartbeat of a routed generation.
 *  - "waiting": the op failed; a retry timer is set.
 *  - "blocked": the op was refused (permission, a click needed in Edge); waits
 *    for the user or a change of devices.
 * An outage is "start" (the first start: never reported lost, never logged,
 * ends with "started"), "change" (a user request while running: never
 * logged, ends with "applied") or "fault" (reported "lost", logged, ends
 * with "back").
 */
export class OutputRecovery {
  /** @param {Partial<typeof RECOVERY_DEFAULTS>} [options] merged over RECOVERY_DEFAULTS */
  constructor(options = {}) {
    this.options = mergeOptions(options);
    this._phase = "idle";
    this._o = null; // the outage in progress
    this._op = null; // the op in flight: { name, startedAtMs, failBaseMs }
    this._log = [];
    this._startRecord = null;
    this._presence = null; // the last `devices` event: { cablePresent, micPresent }
  }

  /** "idle" | "running" | "recovering" | "verifying" | "waiting" | "blocked" */
  get phase() {
    return this._phase;
  }

  /**
   * The outage in progress (a copy), or null: { kind, cause, lostAtMs,
   * attempts, steps, needContext, needMic, dirty, lastError, lastFailAtMs,
   * opStartedAtMs, firstOkOpStartedAtMs, devicesGoneAtMs, devicesBackAtMs,
   * micToo }.
   */
  get outage() {
    return this._o ? publicOutage(this._o) : null;
  }

  /**
   * Fault outages that ended, newest last, at most maxLog: { cause,
   * lostAtMs, backAtMs, outageMs, attempts, steps, devicesGoneAtMs,
   * devicesBackAtMs, afterDevicesBackMs, serviceBackAtMs, appMs, waitMs,
   * micToo }.
   */
  get log() {
    return this._log.map(copyRecord);
  }

  /** The first start: { ms, attempts, steps }, or null until it is done. */
  get startRecord() {
    return copyRecord(this._startRecord);
  }

  /**
   * Begin the first start: → [{do: "rebuild", reopenMic: true, mode: "full", initial: true}].
   * Outside "idle" it does nothing ([]).
   * @param {number} nowMs
   */
  start(nowMs) {
    if (this._phase !== "idle") return [];
    this._o = this._newOutage("start", "start", nowMs, { context: true, mic: true });
    return this._attempt(nowMs);
  }

  /** Stop: phase "idle", the outage dropped, both timers cleared. The log and the start record are kept. */
  stop() {
    this._phase = "idle";
    this._o = null;
    this._op = null;
    this._presence = null;
    return [
      { do: "clear-timer", id: "verify" },
      { do: "clear-timer", id: "retry" },
    ];
  }

  /**
   * Feed one event; → the actions to carry out, in order.
   * @param {{type: string}} ev
   * @param {number} nowMs
   * @returns {object[]}
   */
  event(ev, nowMs) {
    if (this._phase === "idle" || !ev || typeof ev !== "object") return [];
    if (ev.type === "heartbeat" && ev.routed !== true) return []; // only a routed generation proves the voice flows
    if (ev.type === "devices") return this._devices(ev, nowMs);
    const fault = faultOf(ev);
    if (this._phase === "running") {
      if (fault) return this._fault(fault, nowMs);
      if (ev.type === "rebuild-request") return this._change(ev.reason ?? "output", { context: true }, nowMs);
      if (ev.type === "mic-request") return this._change(ev.reason ?? "user", { mic: true }, nowMs);
      return [];
    }
    if (fault) return this._faultDuringOutage(fault, nowMs);
    switch (this._phase) {
      case "recovering":
        return this._recovering(ev, nowMs);
      case "verifying":
        return this._verifying(ev, nowMs);
      case "waiting":
        return this._waiting(ev, nowMs);
      case "blocked":
        return this._blocked(ev, nowMs);
      default:
        return [];
    }
  }

  // ---------- outages ----------

  _newOutage(kind, cause, nowMs, flags) {
    const o = {
      kind,
      cause,
      lostAtMs: nowMs,
      attempts: 0,
      steps: [],
      needContext: false,
      needMic: false,
      dirty: false,
      lastError: null,
      lastFailAtMs: null,
      opStartedAtMs: null,
      firstOkOpStartedAtMs: null,
      waitBaseMs: null, // the last failure before the first op that worked
      nextCause: null, // the reason of the latest request that came in while an op ran
      devicesGoneAtMs: null,
      devicesBackAtMs: null,
      everContext: false,
      everMic: false,
    };
    this._need(o, flags);
    return o;
  }

  /** Set the flags an event or a failed op asks for; `micToo` remembers that both were needed at some point. */
  _need(o, { context = false, mic = false }) {
    if (context) o.needContext = o.everContext = true;
    if (mic) o.needMic = o.everMic = true;
  }

  /** running → a fault outage: report it lost, then the first attempt. */
  _fault(fault, nowMs) {
    this._o = this._newOutage("fault", fault.cause, nowMs, fault);
    const lost = report("lost", { outage: publicOutage(this._o) });
    return [lost, ...this._attempt(nowMs)];
  }

  /** running → a change outage (a user request): no report until it is applied. */
  _change(reason, flags, nowMs) {
    this._o = this._newOutage("change", String(reason), nowMs, flags);
    return this._attempt(nowMs);
  }

  /**
   * A change that failed, or that broke something, becomes a fault outage
   * from now on: reported lost and logged when back. Timings that belong to
   * the change are dropped, so the record measures the fault only, and only
   * what is needed from now on counts for `micToo` (a microphone the user
   * picked is not a microphone Windows took away).
   */
  _toFault(cause, nowMs) {
    const o = this._o;
    o.kind = "fault";
    o.cause = cause;
    o.lostAtMs = nowMs;
    o.lastFailAtMs = null;
    o.firstOkOpStartedAtMs = null;
    o.waitBaseMs = null;
    o.devicesGoneAtMs = null;
    o.devicesBackAtMs = null;
    o.everContext = o.needContext;
    o.everMic = o.needMic;
    return report("lost", { outage: publicOutage(o) });
  }

  /** A fault while an outage is in progress: the next attempt (or the one after the op in flight) covers it. */
  _faultDuringOutage(fault, nowMs) {
    const o = this._o;
    this._need(o, fault);
    o.dirty = true;
    return o.kind === "change" ? [this._toFault(fault.cause, nowMs)] : [];
  }

  // ---------- phases ----------

  /** A user request while an op runs or is verified: the flag it needs, and one more op after this one. */
  _request(ev) {
    const o = this._o;
    const output = ev.type === "rebuild-request";
    this._need(o, output ? { context: true } : { mic: true });
    o.dirty = true;
    o.nextCause = String(ev.reason ?? (output ? "output" : "user"));
    return [];
  }

  _recovering(ev, nowMs) {
    switch (ev.type) {
      case "rebuild-request":
      case "mic-request":
        return this._request(ev);
      case "op-done":
        return this._opDone(ev, nowMs);
      default:
        return [];
    }
  }

  _opDone(ev, nowMs) {
    const op = this._op;
    if (!op || (typeof ev.op === "string" && ev.op !== op.name)) return []; // not the op in flight
    this._op = null;
    const o = this._o;
    if (ev.ok) {
      // The first op of this outage that worked: Windows Audio was running when it started.
      if (o.firstOkOpStartedAtMs === null && op.startedAtMs >= o.lostAtMs) {
        o.firstOkOpStartedAtMs = op.startedAtMs;
        o.waitBaseMs = op.failBaseMs;
      }
      if (o.dirty) return this._attempt(nowMs); // the op could not have fixed what broke during it
      this._phase = "verifying";
      return [{ do: "set-timer", id: "verify", ms: this.options.verifyMs }];
    }
    const error = ev.error;
    if (o.kind === "change" && ev.kept === true) return this._changeFailed(o, error, nowMs);
    // A failed op needs its work done again. A rebuild that failed after its mic step
    // (a SinkError, a context error) keeps the live mic it opened.
    if (op.name === "resume") this._need(o, { context: true });
    else if (op.name === "reopen-mic") this._need(o, { mic: true });
    else this._need(o, { context: true, mic: isMicError(error) });
    const acts = o.kind === "change" ? [this._toFault("change-failed", nowMs)] : [];
    return acts.concat(this._fail(classifyError(error), error, nowMs));
  }

  /**
   * A change failed, but the old microphone is still live and feeds the
   * cable: nothing broke. The change is over (reported "change-failed") and
   * the voice runs on. A request that came in while the op ran is served next,
   * as a change of its own; the microphone that just failed is not tried
   * again (a pending output change rebuilds with the live microphone), unless
   * a newer microphone request asked for one.
   */
  _changeFailed(o, error, nowMs) {
    const acts = [report("change-failed", { error })];
    if (!o.dirty || (!o.needContext && !o.needMic)) {
      this._phase = "running";
      this._o = null;
      return acts;
    }
    this._o = this._newOutage("change", o.nextCause ?? o.cause, nowMs, { context: o.needContext, mic: o.needMic });
    return acts.concat(this._attempt(nowMs));
  }

  _verifying(ev, nowMs) {
    const o = this._o;
    switch (ev.type) {
      case "heartbeat": // routed (others were dropped in event())
        if (o.dirty) return [{ do: "clear-timer", id: "verify" }, ...this._attempt(nowMs)];
        return this._back(nowMs);
      case "timer": {
        if (ev.id !== "verify") return [];
        // No heartbeat: the context does not render or is not routed, whatever the op said.
        this._need(o, { context: true });
        const acts = o.kind === "change" ? [this._toFault("change-failed", nowMs)] : [];
        const error = { name: "NoHeartbeat", message: `No sound came through within ${this.options.verifyMs} ms.` };
        return acts.concat(this._fail("transient", error, nowMs));
      }
      case "rebuild-request":
      case "mic-request":
        return this._request(ev);
      default:
        return [];
    }
  }

  _waiting(ev, nowMs) {
    const o = this._o;
    switch (ev.type) {
      case "timer":
        return ev.id === "retry" ? this._attempt(nowMs) : [];
      case "user-retry":
        return [{ do: "clear-timer", id: "retry" }, ...this._attempt(nowMs)];
      case "rebuild-request":
        this._need(o, { context: true });
        return [{ do: "clear-timer", id: "retry" }, ...this._attempt(nowMs)];
      case "mic-request":
        this._need(o, { mic: true });
        return [{ do: "clear-timer", id: "retry" }, ...this._attempt(nowMs)];
      default:
        return [];
    }
  }

  _blocked(ev, nowMs) {
    const o = this._o;
    switch (ev.type) {
      case "user-retry":
        return this._attempt(nowMs);
      case "rebuild-request":
        this._need(o, { context: true });
        return this._attempt(nowMs);
      case "mic-request":
        this._need(o, { mic: true });
        return this._attempt(nowMs);
      default:
        return [];
    }
  }

  /**
   * A device list was read again. Records when the cable (or the microphone,
   * once the outage involved it) went missing and when both were back; in
   * "waiting", a list with what the next attempt needs short-circuits the
   * retry timer; in "blocked", any change of presence tries again.
   */
  _devices(ev, nowMs) {
    const cur = { cablePresent: ev.cablePresent === true, micPresent: ev.micPresent === true };
    const prev = this._presence;
    this._presence = cur;
    const o = this._o;
    if (!o) return [];
    const gone = !cur.cablePresent || (o.everMic && !cur.micPresent);
    if (gone) {
      if (o.devicesGoneAtMs === null) o.devicesGoneAtMs = nowMs;
    } else if (o.devicesGoneAtMs !== null && o.devicesBackAtMs === null) {
      o.devicesBackAtMs = nowMs;
    }
    if (this._phase === "waiting" && cur.cablePresent && (cur.micPresent || !o.needMic)) {
      return [{ do: "clear-timer", id: "retry" }, ...this._attempt(nowMs)];
    }
    const changed = !prev || prev.cablePresent !== cur.cablePresent || prev.micPresent !== cur.micPresent;
    if (this._phase === "blocked" && changed) return this._attempt(nowMs);
    return [];
  }

  // ---------- attempts ----------

  /**
   * The next op for the outage: a resume for the first attempt of a fault
   * that only suspended the context (or reported a render error); else a
   * rebuild when the context is needed (reopening the mic too when it is
   * needed); else a reopen of the mic.
   */
  _attempt(nowMs) {
    const o = this._o;
    o.attempts++;
    o.dirty = false;
    o.opStartedAtMs = nowMs;
    const mode = o.kind === "fault" ? "recover" : "full";
    let action;
    if (
      o.kind === "fault" &&
      o.needContext &&
      !o.needMic &&
      o.attempts === 1 &&
      (o.cause === "context-suspended" || o.cause === "render-error")
    ) {
      action = { do: "resume" };
      o.needContext = false;
    } else if (o.needContext || !o.needMic) {
      action = { do: "rebuild", reopenMic: o.needMic, mode, initial: o.kind === "start" };
      o.needContext = false;
      o.needMic = false;
    } else {
      action = { do: "reopen-mic", mode };
      o.needMic = false;
    }
    o.steps.push(action.do);
    this._op = { name: action.do, startedAtMs: nowMs, failBaseMs: o.lastFailAtMs };
    this._phase = "recovering";
    const acts = [action];
    const every = this.options.stillTryingEvery;
    if (o.kind !== "change" && o.attempts >= 5 && (o.attempts - 5) % every === 0) {
      acts.push(report("still-trying", { outage: publicOutage(o), sinceMs: nowMs - o.lostAtMs }));
    }
    return acts;
  }

  /** An op failed (or its heartbeat never came): block, retry at once after a failed resume, or wait. */
  _fail(kind, error, nowMs) {
    const o = this._o;
    o.lastFailAtMs = nowMs;
    o.lastError = summarize(error);
    if (kind === "blocked" || kind === "needs-gesture") {
      this._phase = "blocked";
      return [report("blocked", { outage: publicOutage(o), reason: kind, error })];
    }
    if (o.attempts === 1 && o.steps[o.steps.length - 1] === "resume") return this._attempt(nowMs);
    const { startBusyRetryMs, waitBackstopMs, fastRetryMs, fastWindowMs, slowRetryMs } = this.options;
    let ms;
    if (o.kind === "start" && kind === "busy") ms = startBusyRetryMs;
    else if (o.kind === "start" && kind === "missing") ms = waitBackstopMs;
    else ms = nowMs - o.lostAtMs < fastWindowMs ? fastRetryMs : slowRetryMs;
    this._phase = "waiting";
    return [{ do: "set-timer", id: "retry", ms }];
  }

  /** A heartbeat after a clean op: the outage is over. */
  _back(nowMs) {
    const o = this._o;
    this._phase = "running";
    this._o = null;
    this._op = null;
    const acts = [{ do: "clear-timer", id: "verify" }];
    const steps = o.steps.slice();
    if (o.kind === "start") {
      this._startRecord = { ms: nowMs - o.lostAtMs, attempts: o.attempts, steps };
      acts.push(report("started", { record: copyRecord(this._startRecord) }));
    } else if (o.kind === "change") {
      acts.push(report("applied", { record: { cause: o.cause, ms: nowMs - o.lostAtMs, attempts: o.attempts, steps } }));
    } else {
      const first = o.firstOkOpStartedAtMs;
      const record = {
        cause: o.cause,
        lostAtMs: o.lostAtMs,
        backAtMs: nowMs,
        outageMs: nowMs - o.lostAtMs,
        attempts: o.attempts,
        steps,
        devicesGoneAtMs: o.devicesGoneAtMs,
        devicesBackAtMs: o.devicesBackAtMs,
        afterDevicesBackMs: o.devicesBackAtMs === null ? null : nowMs - o.devicesBackAtMs,
        serviceBackAtMs: first,
        appMs: first === null ? null : nowMs - first,
        waitMs: first === null ? null : first - (o.waitBaseMs ?? o.lostAtMs),
        micToo: o.everContext && o.everMic,
      };
      this._log.push(record);
      while (this._log.length > this.options.maxLog) this._log.shift();
      acts.push(report("back", { record: copyRecord(record) }));
    }
    return acts;
  }
}
