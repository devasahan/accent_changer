import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OutputRecovery, RECOVERY_DEFAULTS, classifyError } from "../src/core/recovery.js";
import { restartVerdict } from "../src/core/cable-check.js";

// Errors as the graph feeds them (§4.1, §4.2): MicError and SinkError objects, DOMException-like {name, message}.
const micError = (code, cause = null) => ({
  name: "MicError",
  code,
  message: `microphone ${code}`,
  cause: cause ? { name: cause, message: "" } : undefined,
});
const sinkError = (kind) => ({ name: "SinkError", kind, message: `sink ${kind}` });
const named = (name) => ({ name, message: `${name} happened` });

/** Actions with the report payloads left out: what the reducer asks for, in order. */
const brief = (acts) =>
  acts.map((a) => {
    if (a.do !== "report") return a;
    const out = { do: "report", kind: a.kind };
    if (a.kind === "blocked") out.reason = a.reason;
    return out;
  });

const ev = {
  suspended: { type: "context-state", state: "suspended" },
  interrupted: { type: "context-state", state: "interrupted" },
  closed: { type: "context-state", state: "closed" },
  error: { type: "context-error" },
  stalled: { type: "context-error", stalled: true },
  sinkLost: { type: "sink-changed", matches: false },
  micEnded: { type: "mic-ended" },
  heartbeat: { type: "heartbeat", routed: true },
  unrouted: { type: "heartbeat", routed: false },
  verify: { type: "timer", id: "verify" },
  retry: { type: "timer", id: "retry" },
  userRetry: { type: "user-retry" },
  devices: (cablePresent, micPresent) => ({ type: "devices", cablePresent, micPresent }),
  ok: (op) => ({ type: "op-done", op, ok: true }),
  fail: (op, error, extra = {}) => ({ type: "op-done", op, ok: false, error, ...extra }),
};

const REBUILD_START = { do: "rebuild", reopenMic: true, mode: "full", initial: true };
const SET_VERIFY = { do: "set-timer", id: "verify", ms: 600 };
const CLEAR_VERIFY = { do: "clear-timer", id: "verify" };
const CLEAR_RETRY = { do: "clear-timer", id: "retry" };
const retryIn = (ms) => ({ do: "set-timer", id: "retry", ms });
const rebuild = (reopenMic, mode = "recover") => ({ do: "rebuild", reopenMic, mode, initial: false });

/** A reducer whose first start is done (at t = −1000 … −800), running. */
function running(options) {
  const r = new OutputRecovery(options);
  r.start(-1000);
  r.event(ev.ok("rebuild"), -900);
  r.event(ev.heartbeat, -800);
  assert.equal(r.phase, "running");
  return r;
}

// ---------- classifyError ----------

test("classifyError: MicError codes, SinkError kinds, NeedsGesture and DOMException names", () => {
  assert.equal(classifyError(micError("blocked")), "blocked");
  assert.equal(classifyError(micError("is-cable")), "blocked");
  assert.equal(classifyError(micError("is-virtual")), "blocked");
  assert.equal(classifyError(micError("busy")), "busy");
  assert.equal(classifyError(micError("missing")), "missing");
  assert.equal(classifyError(micError("other", "NotReadableError")), "busy");
  assert.equal(classifyError(micError("other", "NotFoundError")), "missing");
  assert.equal(classifyError(micError("other")), "transient", "no cause");
  assert.equal(classifyError({ name: "MicError", code: "other", cause: { message: "x" } }), "transient", "a cause without a name");
  assert.equal(classifyError(micError("strange")), "transient");
  for (const kind of ["missing", "blocked", "transient", "needs-gesture", "busy"]) assert.equal(classifyError(sinkError(kind)), kind);
  assert.equal(classifyError(sinkError("odd")), "transient");
  assert.equal(classifyError({ name: "NeedsGesture" }), "needs-gesture");
  const dom = (name) => new DOMException("x", name);
  assert.equal(classifyError(dom("NotAllowedError")), "blocked");
  assert.equal(classifyError(dom("SecurityError")), "blocked");
  assert.equal(classifyError(dom("NotReadableError")), "busy");
  assert.equal(classifyError(dom("AbortError")), "busy");
  assert.equal(classifyError(dom("NotFoundError")), "missing");
  assert.equal(classifyError(named("OverconstrainedError")), "missing");
  for (const name of ["TimeoutError", "InvalidStateError", "ResumeFailed", "NoSuchError"]) {
    assert.equal(classifyError(named(name)), "transient", name);
  }
  assert.equal(classifyError({ what: "unknown" }), "transient");
  assert.equal(classifyError(null), "transient");
  assert.equal(classifyError(undefined), "transient");
  assert.equal(classifyError("NotAllowedError"), "transient", "a string is not an error object");
  const loop = { name: "MicError", code: "other" };
  loop.cause = loop;
  assert.equal(classifyError(loop), "transient", "a cause that points back at itself ends");
});

// ---------- the first start ----------

test("first start: one rebuild, verified by a heartbeat, gives the start record and no log", () => {
  const r = new OutputRecovery();
  assert.equal(r.phase, "idle");
  assert.deepEqual(r.start(0), [REBUILD_START]);
  assert.equal(r.phase, "recovering");
  assert.deepEqual(r.start(5), [], "start() outside idle does nothing");
  assert.deepEqual(r.event(ev.ok("rebuild"), 300), [SET_VERIFY]);
  assert.equal(r.phase, "verifying");
  assert.deepEqual(r.event(ev.unrouted, 350), [], "an unrouted heartbeat proves nothing");
  const acts = r.event(ev.heartbeat, 400);
  assert.deepEqual(brief(acts), [CLEAR_VERIFY, { do: "report", kind: "started" }]);
  assert.deepEqual(acts[1].record, { ms: 400, attempts: 1, steps: ["rebuild"] });
  assert.deepEqual(r.startRecord, { ms: 400, attempts: 1, steps: ["rebuild"] });
  assert.equal(r.phase, "running");
  assert.equal(r.outage, null);
  assert.deepEqual(r.log, []);
});

test("first start: a busy microphone is retried every 5 s", () => {
  const r = new OutputRecovery();
  r.start(0);
  assert.deepEqual(r.event(ev.fail("rebuild", micError("busy", "NotReadableError")), 100), [retryIn(5000)]);
  assert.equal(r.phase, "waiting");
  assert.deepEqual(r.event(ev.retry, 5100), [REBUILD_START], "a MicError asks for the mic again");
  assert.equal(r.outage.attempts, 2);
  assert.equal(r.outage.lastError.code, "busy");
});

test("first start: a transient setSinkId failure retries in 250 ms and starts without a click", () => {
  const r = new OutputRecovery();
  r.start(0);
  assert.deepEqual(r.event(ev.fail("rebuild", sinkError("transient")), 80), [retryIn(250)]);
  assert.deepEqual(r.event(ev.retry, 330), [{ do: "rebuild", reopenMic: false, mode: "full", initial: true }], "the live mic is kept");
  assert.deepEqual(r.event(ev.ok("rebuild"), 500), [SET_VERIFY]);
  assert.deepEqual(brief(r.event(ev.heartbeat, 560)), [CLEAR_VERIFY, { do: "report", kind: "started" }]);
  assert.deepEqual(r.startRecord, { ms: 560, attempts: 2, steps: ["rebuild", "rebuild"] });
});

test("first start: no cable waits 2 s or for a devices event", () => {
  const r = new OutputRecovery();
  r.start(0);
  assert.deepEqual(r.event(ev.fail("rebuild", sinkError("missing")), 50), [retryIn(2000)]);
  assert.deepEqual(r.event(ev.unrouted, 100), [], "the meters-only generation is not routed");
  assert.deepEqual(r.event(ev.devices(false, true), 400), [], "still no cable");
  assert.deepEqual(r.event(ev.devices(true, true), 900), [CLEAR_RETRY, { do: "rebuild", reopenMic: false, mode: "full", initial: true }]);
  assert.equal(r.outage.devicesGoneAtMs, 400);
  assert.equal(r.outage.devicesBackAtMs, 900);
});

test("first start: a missing microphone waits for it (2 s backstop)", () => {
  const r = new OutputRecovery();
  r.start(0);
  assert.deepEqual(r.event(ev.fail("rebuild", micError("missing")), 50), [retryIn(2000)]);
  assert.deepEqual(r.event(ev.devices(true, false), 300), [], "the cable alone is not enough: the mic is needed");
  assert.deepEqual(r.event(ev.devices(true, true), 700), [CLEAR_RETRY, REBUILD_START]);
});

test("first start: a blocked microphone waits for the user or a device change", () => {
  const r = new OutputRecovery();
  r.start(0);
  const error = micError("blocked", "NotAllowedError");
  const acts = r.event(ev.fail("rebuild", error), 40);
  assert.deepEqual(brief(acts), [{ do: "report", kind: "blocked", reason: "blocked" }]);
  assert.equal(acts[0].error, error, "the error as the graph gave it");
  assert.equal(acts[0].outage.kind, "start");
  assert.equal(r.phase, "blocked");
  assert.deepEqual(r.event(ev.retry, 100), [], "no timer runs while blocked");
  assert.deepEqual(r.event(ev.devices(true, true), 3000), [REBUILD_START]);
  // Blocked again: the same devices again change nothing; a change of presence tries again.
  r.event(ev.fail("rebuild", error), 3040);
  assert.deepEqual(r.event(ev.devices(true, true), 3500), []);
  assert.deepEqual(r.event(ev.devices(true, false), 3600), [REBUILD_START]);
  r.event(ev.fail("rebuild", error), 3640);
  assert.deepEqual(r.event(ev.userRetry, 9000), [REBUILD_START]);
});

test("first start: needs-gesture (Edge) blocks until the user clicks", () => {
  const r = new OutputRecovery();
  r.start(0);
  assert.deepEqual(brief(r.event(ev.fail("rebuild", { name: "NeedsGesture" }), 900)), [
    { do: "report", kind: "blocked", reason: "needs-gesture" },
  ]);
  assert.equal(r.phase, "blocked");
  assert.deepEqual(r.event(ev.userRetry, 5000), [{ do: "rebuild", reopenMic: false, mode: "full", initial: true }]);
  r.event(ev.ok("rebuild"), 5100);
  r.event(ev.heartbeat, 5150);
  assert.equal(r.phase, "running");
  assert.equal(r.startRecord.attempts, 2);
  assert.deepEqual(r.log, [], "a start is never logged");
});

test("first start: a fault during it stays part of the start", () => {
  const r = new OutputRecovery();
  r.start(0);
  assert.deepEqual(r.event(ev.error, 50), [], "no lost report for a start");
  assert.deepEqual(r.event(ev.ok("rebuild"), 300), [{ do: "rebuild", reopenMic: false, mode: "full", initial: true }]);
  assert.equal(r.outage.kind, "start");
});

// ---------- faults ----------

test("fault: a suspended context is resumed and verified", () => {
  const r = running();
  const acts = r.event(ev.suspended, 1000);
  assert.deepEqual(brief(acts), [{ do: "report", kind: "lost" }, { do: "resume" }]);
  assert.equal(acts[0].outage.cause, "context-suspended");
  assert.equal(acts[0].outage.attempts, 0, "the lost report comes before the attempt");
  assert.equal(r.phase, "recovering");
  assert.deepEqual(r.event(ev.ok("resume"), 1050), [SET_VERIFY]);
  const back = r.event(ev.heartbeat, 1120);
  assert.deepEqual(brief(back), [CLEAR_VERIFY, { do: "report", kind: "back" }]);
  const record = back[1].record;
  assert.equal(record.cause, "context-suspended");
  assert.equal(record.outageMs, 120);
  assert.equal(record.lostAtMs, 1000);
  assert.equal(record.backAtMs, 1120);
  assert.deepEqual(record.steps, ["resume"]);
  assert.equal(record.serviceBackAtMs, 1000);
  assert.equal(record.appMs, 120);
  assert.equal(record.waitMs, 0);
  assert.equal(record.micToo, false);
  assert.equal(record.devicesBackAtMs, null);
  assert.equal(record.afterDevicesBackMs, null);
  assert.deepEqual(r.log, [record]);
  assert.equal(r.phase, "running");
});

test("fault: an interrupted context is resumed too", () => {
  const r = running();
  assert.deepEqual(brief(r.event(ev.interrupted, 10)), [{ do: "report", kind: "lost" }, { do: "resume" }]);
});

test("fault: an error, a resume that seems to work, no heartbeat → a rebuild at once", () => {
  const r = running();
  assert.deepEqual(brief(r.event(ev.error, 0)), [{ do: "report", kind: "lost" }, { do: "resume" }]);
  assert.deepEqual(r.event(ev.ok("resume"), 30), [SET_VERIFY]);
  assert.deepEqual(r.event(ev.verify, 630), [rebuild(false)]);
  assert.deepEqual(r.event(ev.ok("rebuild"), 900), [SET_VERIFY]);
  const back = r.event(ev.heartbeat, 980);
  assert.deepEqual(back[1].record.steps, ["resume", "rebuild"]);
  assert.equal(back[1].record.cause, "render-error");
  assert.equal(back[1].record.outageMs, 980);
});

test("fault: an error whose resume fails is rebuilt at once", () => {
  const r = running();
  r.event(ev.error, 0);
  assert.deepEqual(r.event(ev.fail("resume", named("ResumeFailed")), 10), [rebuild(false)]);
  assert.equal(r.outage.lastError.name, "ResumeFailed");
  assert.equal(r.outage.lastFailAtMs, 10);
});

test("fault: a closed context, a stalled one and a lost sink are rebuilt directly", () => {
  for (const [event, cause] of [
    [ev.closed, "context-closed"],
    [ev.stalled, "render-stalled"],
    [ev.sinkLost, "sink-changed"],
  ]) {
    const r = running();
    const acts = r.event(event, 0);
    assert.deepEqual(brief(acts), [{ do: "report", kind: "lost" }, rebuild(false)], cause);
    assert.equal(acts[0].outage.cause, cause);
    r.event(ev.ok("rebuild"), 400);
    assert.equal(r.event(ev.heartbeat, 450)[1].record.cause, cause);
  }
});

test("fault: a sink change that still matches, and a running state, are no faults", () => {
  const r = running();
  assert.deepEqual(r.event({ type: "sink-changed", matches: true }, 0), []);
  assert.deepEqual(r.event({ type: "context-state", state: "running" }, 0), []);
  assert.equal(r.phase, "running");
});

test("fault: the mic ends → reopen-mic; a context error during it → a rebuild after it; micToo", () => {
  const r = running();
  assert.deepEqual(brief(r.event(ev.micEnded, 0)), [{ do: "report", kind: "lost" }, { do: "reopen-mic", mode: "recover" }]);
  assert.deepEqual(r.event(ev.error, 20), [], "the op in flight finishes first");
  assert.equal(r.outage.dirty, true);
  assert.deepEqual(r.event(ev.ok("reopen-mic"), 150), [rebuild(false)], "the reopen could not fix the context");
  assert.deepEqual(r.event(ev.ok("rebuild"), 450), [SET_VERIFY]);
  const record = r.event(ev.heartbeat, 500)[1].record;
  assert.deepEqual(record.steps, ["reopen-mic", "rebuild"]);
  assert.equal(record.micToo, true);
  assert.equal(record.cause, "mic-ended");
});

test("fault: transient failures retry every 250 ms, then every second after a minute", () => {
  const r = running();
  r.event(ev.closed, 0);
  assert.deepEqual(r.event(ev.fail("rebuild", sinkError("transient")), 100), [retryIn(250)]);
  assert.deepEqual(r.event(ev.retry, 350), [rebuild(false)]);
  assert.deepEqual(r.event(ev.fail("rebuild", named("InvalidStateError")), 400), [retryIn(250)]);
  assert.deepEqual(r.event(ev.retry, 650), [rebuild(false)]);
  assert.deepEqual(r.event(ev.fail("rebuild", named("TimeoutError")), 700), [retryIn(250)]);
  r.event(ev.retry, 15100);
  assert.deepEqual(r.event(ev.fail("rebuild", sinkError("transient")), 15200), [retryIn(250)], "a slow Windows Audio restart: still fast");
  r.event(ev.retry, 59000);
  assert.deepEqual(r.event(ev.fail("rebuild", sinkError("transient")), 59999), [retryIn(250)]);
  r.event(ev.retry, 60100);
  assert.deepEqual(r.event(ev.fail("rebuild", sinkError("transient")), 60200), [retryIn(1000)]);
  assert.equal(r.phase, "waiting");
});

test("fault: the fast retries end exactly a minute after the loss", () => {
  const r = running();
  r.event(ev.closed, 0);
  r.event(ev.fail("rebuild", sinkError("transient")), 100);
  r.event(ev.retry, 59900);
  assert.deepEqual(r.event(ev.fail("rebuild", sinkError("transient")), 60000), [retryIn(1000)]);
});

test("fault: with only the context to rebuild, the cable back is enough (the microphone is not needed)", () => {
  const r = running();
  r.event(ev.closed, 0);
  r.event(ev.fail("rebuild", sinkError("missing")), 50);
  assert.deepEqual(r.event(ev.devices(true, false), 100), [CLEAR_RETRY, rebuild(false)]);
  assert.equal(r.outage.devicesGoneAtMs, null, "no microphone involved: its absence is not counted");
});

test("fault: the microphone missing from the device list counts as gone while its reopen is in flight", () => {
  const r = running();
  r.event(ev.micEnded, 0);
  assert.equal(r.outage.needMic, false, "the reopen-mic in flight took the flag");
  assert.deepEqual(r.event(ev.devices(true, false), 20), []);
  assert.equal(r.outage.devicesGoneAtMs, 20);
  r.event(ev.devices(true, true), 300);
  assert.equal(r.outage.devicesBackAtMs, 300);
});

test("fault: devicesBackAtMs is the first time both are back; later device lists do not move it", () => {
  const r = running();
  r.event(ev.closed, 0);
  r.event(ev.devices(false, true), 10);
  r.event(ev.fail("rebuild", sinkError("missing")), 50);
  r.event(ev.devices(true, true), 300);
  r.event(ev.fail("rebuild", sinkError("transient")), 340);
  r.event(ev.devices(true, true), 500);
  assert.equal(r.outage.devicesBackAtMs, 300);
});

test("fault: a busy microphone during a fault is retried in 250 ms, not 5 s", () => {
  const r = running();
  r.event(ev.micEnded, 0);
  assert.deepEqual(r.event(ev.fail("reopen-mic", micError("busy", "NotReadableError")), 40), [retryIn(250)]);
  assert.deepEqual(r.event(ev.retry, 290), [{ do: "reopen-mic", mode: "recover" }]);
});

test("fault: the cable back in the device list ends the wait at once", () => {
  const r = running();
  r.event(ev.closed, 0);
  r.event(ev.devices(false, true), 10);
  r.event(ev.fail("rebuild", sinkError("missing")), 50);
  assert.equal(r.phase, "waiting");
  assert.deepEqual(r.event(ev.devices(true, true), 700), [CLEAR_RETRY, rebuild(false)]);
  r.event(ev.ok("rebuild"), 900);
  const record = r.event(ev.heartbeat, 950)[1].record;
  assert.equal(record.devicesGoneAtMs, 10);
  assert.equal(record.devicesBackAtMs, 700);
  assert.equal(record.afterDevicesBackMs, 250);
  assert.equal(record.waitMs, 700 - 50);
});

test("fault: a refused route blocks without timers; the user's retry tries again", () => {
  const r = running();
  r.event(ev.sinkLost, 0);
  const acts = r.event(ev.fail("rebuild", sinkError("blocked")), 60);
  assert.deepEqual(brief(acts), [{ do: "report", kind: "blocked", reason: "blocked" }]);
  assert.equal(r.phase, "blocked");
  assert.deepEqual(r.event(ev.fail("rebuild", named("NotAllowedError")), 70), [], "no op in flight");
  assert.deepEqual(r.event(ev.retry, 300), []);
  assert.deepEqual(r.event(ev.userRetry, 5000), [rebuild(false)]);
});

test("fault: a NotAllowedError blocks too", () => {
  const r = running();
  r.event(ev.closed, 0);
  assert.deepEqual(brief(r.event(ev.fail("rebuild", named("NotAllowedError")), 20)), [
    { do: "report", kind: "blocked", reason: "blocked" },
  ]);
});

test("duplicate events while an op is pending produce nothing", () => {
  const r = running();
  r.event(ev.closed, 0);
  assert.deepEqual(r.event(ev.closed, 1), []);
  assert.deepEqual(r.event(ev.error, 2), []);
  assert.deepEqual(r.event(ev.micEnded, 3), []);
  assert.deepEqual(r.event(ev.userRetry, 4), []);
  assert.deepEqual(r.event(ev.heartbeat, 5), [], "a heartbeat while an op runs proves nothing yet");
  assert.deepEqual(r.event(ev.verify, 6), [], "a stale timer");
  assert.deepEqual(r.event(ev.ok("resume"), 7), [], "the result of an op that is not in flight");
  assert.equal(r.outage.attempts, 1);
});

test("no heartbeat after an op: the context is rebuilt, also when a microphone was asked for meanwhile", () => {
  const r = running();
  r.event(ev.closed, 0);
  r.event(ev.ok("rebuild"), 300);
  assert.deepEqual(r.event({ type: "mic-request", reason: "user" }, 320), []);
  assert.deepEqual(r.event(ev.verify, 900), [retryIn(250)]);
  assert.deepEqual(r.event(ev.retry, 1150), [rebuild(true)], "not a reopen alone: the context did not render");
});

test("only a heartbeat that says routed: true proves the voice flows", () => {
  const r = running();
  r.event(ev.closed, 0);
  r.event(ev.ok("rebuild"), 300);
  assert.equal(r.phase, "verifying");
  for (const hb of [{ type: "heartbeat" }, { type: "heartbeat", routed: "yes" }, { type: "heartbeat", routed: 1 }, ev.unrouted]) {
    assert.deepEqual(r.event(hb, 350), [], JSON.stringify(hb));
  }
  assert.equal(r.phase, "verifying");
  assert.equal(r.event(ev.heartbeat, 400)[1].kind, "back");
});

test("stale timers are ignored in the other phases", () => {
  const r = running();
  r.event(ev.closed, 0);
  r.event(ev.fail("rebuild", sinkError("transient")), 10);
  assert.deepEqual(r.event(ev.verify, 20), [], "a verify timer while waiting");
  r.event(ev.retry, 260);
  r.event(ev.ok("rebuild"), 300);
  assert.deepEqual(r.event(ev.retry, 310), [], "a retry timer while verifying");
  assert.equal(r.phase, "verifying");
});

test("stop() forgets the devices: after a new start, the first device list counts as a change", () => {
  const r = new OutputRecovery();
  r.start(0);
  const blocked = micError("blocked", "NotAllowedError");
  r.event(ev.fail("rebuild", blocked), 40);
  assert.deepEqual(r.event(ev.devices(true, true), 100), [REBUILD_START]);
  r.event(ev.fail("rebuild", blocked), 140);
  r.stop();
  r.start(200);
  r.event(ev.fail("rebuild", blocked), 240);
  assert.equal(r.phase, "blocked");
  assert.deepEqual(r.event(ev.devices(true, true), 300), [REBUILD_START]);
});

test("still-trying is never reported for a change", () => {
  const r = running();
  r.event({ type: "mic-request", reason: "user" }, 0);
  const reports = [];
  for (let k = 0; k < 6; k++) {
    const t = 100 + k * 1000;
    r.event(ev.ok("reopen-mic"), t);
    r.event({ type: "mic-request", reason: "user" }, t + 10);
    const acts = r.event(ev.heartbeat, t + 20);
    assert.deepEqual(acts[1], { do: "reopen-mic", mode: "full" });
    reports.push(...acts.filter((a) => a.do === "report"));
  }
  assert.equal(r.outage.attempts, 7);
  assert.deepEqual(reports, []);
});

test("idle ignores everything; stop() clears both timers and goes idle", () => {
  const r = new OutputRecovery();
  for (const e of [ev.error, ev.closed, ev.micEnded, ev.heartbeat, ev.devices(true, true), ev.userRetry, ev.retry, ev.ok("rebuild")]) {
    assert.deepEqual(r.event(e, 0), []);
  }
  assert.deepEqual(r.event(null, 0), []);
  const s = running();
  s.event(ev.closed, 0);
  assert.deepEqual(s.stop(), [CLEAR_VERIFY, CLEAR_RETRY]);
  assert.equal(s.phase, "idle");
  assert.equal(s.outage, null);
  assert.deepEqual(s.event(ev.ok("rebuild"), 100), []);
  assert.deepEqual(s.start(200), [REBUILD_START], "it can start again");
});

test("the log keeps the last 20 fault outages", () => {
  const r = running();
  for (let k = 0; k < 25; k++) {
    const t = k * 1000;
    r.event(ev.closed, t);
    r.event(ev.ok("rebuild"), t + 300);
    r.event(ev.heartbeat, t + 400 + k);
  }
  const log = r.log;
  assert.equal(log.length, 20);
  assert.equal(log[0].lostAtMs, 5000, "the oldest five are gone");
  assert.equal(log[19].outageMs, 424);
  const other = running({ maxLog: 3 });
  for (let k = 0; k < 5; k++) {
    other.event(ev.closed, k * 1000);
    other.event(ev.ok("rebuild"), k * 1000 + 100);
    other.event(ev.heartbeat, k * 1000 + 200);
  }
  assert.equal(other.log.length, 3);
});

test("still-trying is reported at attempts 5 and 15, with the time since the loss", () => {
  const r = running();
  r.event(ev.closed, 0);
  let t = 0;
  const reports = [];
  for (let attempt = 2; attempt <= 16; attempt++) {
    t += 100;
    r.event(ev.fail("rebuild", sinkError("transient")), t);
    t += 250;
    const acts = r.event(ev.retry, t);
    assert.deepEqual(acts[0], rebuild(false));
    for (const a of acts.filter((x) => x.do === "report")) reports.push({ attempt, kind: a.kind, sinceMs: a.sinceMs, attempts: a.outage.attempts });
  }
  assert.deepEqual(reports, [
    { attempt: 5, kind: "still-trying", sinceMs: 1400, attempts: 5 },
    { attempt: 15, kind: "still-trying", sinceMs: 4900, attempts: 15 },
  ]);
});

test("a failed op's error is kept redacted: Chromium's messages hold device ids", () => {
  const r = running();
  r.event(ev.closed, 0);
  const id = "a".repeat(64);
  r.event(ev.fail("rebuild", { name: "NotFoundError", message: `Requested device not found: ${id}`, kind: "transient" }), 10);
  const last = r.outage.lastError;
  assert.equal(last.name, "NotFoundError");
  assert.equal(last.kind, "transient");
  assert.ok(!last.message.includes(id), last.message);
  r.event(ev.retry, 300);
  r.event(ev.fail("rebuild", micError("busy")), 320);
  assert.deepEqual(r.outage.lastError, { name: "MicError", message: "microphone busy", code: "busy" });
});

test("outage and log are copies: changing them changes nothing inside", () => {
  const r = running();
  r.event(ev.closed, 0);
  const o = r.outage;
  o.steps.push("nonsense");
  o.attempts = 99;
  assert.deepEqual(r.outage.steps, ["rebuild"]);
  r.event(ev.ok("rebuild"), 100);
  r.event(ev.heartbeat, 150);
  const log = r.log;
  log[0].steps.push("x");
  log.pop();
  assert.equal(r.log.length, 1);
  assert.deepEqual(r.log[0].steps, ["rebuild"]);
});

test("options are merged over the defaults", () => {
  assert.equal(RECOVERY_DEFAULTS.verifyMs, 600);
  assert.ok(Object.isFrozen(RECOVERY_DEFAULTS));
  const r = new OutputRecovery({ verifyMs: 900, fastRetryMs: 100, slowRetryMs: "x" });
  assert.equal(r.options.verifyMs, 900);
  assert.equal(r.options.slowRetryMs, 1000);
  r.start(0);
  assert.deepEqual(r.event(ev.ok("rebuild"), 10), [{ do: "set-timer", id: "verify", ms: 900 }]);
});

// ---------- the cable gone during recovery (S2-07) ----------

test("cable gone during recovery: wait without a 'none' sink until it is listed again", () => {
  const r = running();
  assert.deepEqual(brief(r.event(ev.error, 0)), [{ do: "report", kind: "lost" }, { do: "resume" }]);
  assert.deepEqual(r.event(ev.fail("resume", named("ResumeFailed")), 5), [rebuild(false)]);
  assert.deepEqual(r.event(ev.fail("rebuild", sinkError("missing")), 40), [retryIn(250)]);
  assert.equal(r.phase, "waiting");
  assert.deepEqual(r.event(ev.unrouted, 100), []);
  assert.deepEqual(r.event({ type: "devices", cablePresent: false }, 150), []);
  assert.deepEqual(r.event(ev.retry, 290), [rebuild(false)]);
  assert.deepEqual(r.event(ev.fail("rebuild", sinkError("missing")), 320), [retryIn(250)]);
  assert.deepEqual(r.event(ev.devices(true, true), 400), [CLEAR_RETRY, rebuild(false)]);
  assert.deepEqual(r.event(ev.ok("rebuild"), 700), [SET_VERIFY]);
  const back = r.event(ev.heartbeat, 760);
  assert.deepEqual(brief(back), [CLEAR_VERIFY, { do: "report", kind: "back" }]);
  assert.deepEqual(back[1].record.steps, ["resume", "rebuild", "rebuild", "rebuild"]);
  assert.equal(back[1].record.devicesGoneAtMs, 150);
  assert.equal(back[1].record.devicesBackAtMs, 400);
});

// ---------- changes ----------

test("change: a new output is one full rebuild, reported applied, never logged", () => {
  const r = running();
  assert.deepEqual(r.event({ type: "rebuild-request", reason: "output" }, 0), [rebuild(false, "full")]);
  assert.equal(r.outage.kind, "change");
  assert.deepEqual(r.event(ev.ok("rebuild"), 400), [SET_VERIFY]);
  const acts = r.event(ev.heartbeat, 450);
  assert.deepEqual(brief(acts), [CLEAR_VERIFY, { do: "report", kind: "applied" }]);
  assert.deepEqual(acts[1].record, { cause: "output", ms: 450, attempts: 1, steps: ["rebuild"] });
  assert.deepEqual(r.log, []);
});

test("change: a new microphone is a reopen-mic, applied", () => {
  const r = running();
  assert.deepEqual(r.event({ type: "mic-request", reason: "user" }, 0), [{ do: "reopen-mic", mode: "full" }]);
  assert.deepEqual(r.event(ev.ok("reopen-mic"), 200), [SET_VERIFY]);
  const acts = r.event(ev.heartbeat, 260);
  assert.equal(acts[1].kind, "applied");
  assert.equal(acts[1].record.cause, "user");
  assert.equal(r.event({ type: "mic-request", reason: "wanted-back" }, 1000)[0].do, "reopen-mic");
});

test("change: a microphone that fails while the old one stays live → running, change-failed", () => {
  const r = running();
  r.event({ type: "mic-request", reason: "user" }, 0);
  const error = micError("busy", "NotReadableError");
  const acts = r.event(ev.fail("reopen-mic", error, { kept: true }), 100);
  assert.deepEqual(acts, [{ do: "report", kind: "change-failed", error }]);
  assert.equal(r.phase, "running");
  assert.equal(r.outage, null);
  assert.deepEqual(r.log, []);
});

test("change: a newer request that came in while it failed is still served, after the failure is reported", () => {
  const r = running();
  r.event({ type: "mic-request", reason: "user" }, 0);
  assert.deepEqual(r.event({ type: "mic-request", reason: "user" }, 50), []);
  const error = micError("busy");
  assert.deepEqual(r.event(ev.fail("reopen-mic", error, { kept: true }), 100), [
    { do: "report", kind: "change-failed", error },
    { do: "reopen-mic", mode: "full" },
  ]);
  assert.equal(r.outage.kind, "change");
  assert.equal(r.outage.attempts, 1, "a change of its own");
});

test("change: a microphone that fails while an output change waits: the output change keeps the live microphone", () => {
  const r = running();
  assert.deepEqual(r.event({ type: "mic-request", reason: "user" }, 1000), [{ do: "reopen-mic", mode: "full" }]);
  assert.deepEqual(r.event({ type: "rebuild-request", reason: "output" }, 1050), []);
  const error = micError("busy", "NotReadableError");
  // The new microphone is busy; the old one still feeds the cable. The output change must not reopen the busy one.
  assert.deepEqual(r.event(ev.fail("reopen-mic", error, { kept: true }), 1100), [
    { do: "report", kind: "change-failed", error },
    rebuild(false, "full"),
  ]);
  assert.equal(r.outage.kind, "change");
  assert.equal(r.outage.cause, "output");
  assert.equal(r.outage.needMic, false);
  assert.deepEqual(r.event(ev.ok("rebuild"), 1400), [SET_VERIFY]);
  const acts = r.event(ev.heartbeat, 1450);
  assert.deepEqual(brief(acts), [CLEAR_VERIFY, { do: "report", kind: "applied" }]);
  assert.deepEqual(acts[1].record, { cause: "output", ms: 350, attempts: 1, steps: ["rebuild"] });
  assert.equal(r.phase, "running");
  assert.deepEqual(r.log, [], "no outage: the voice never stopped");
});

test("change: a failure without the old mic → a fault (change-failed), reported lost", () => {
  const r = running();
  r.event({ type: "mic-request", reason: "user" }, 0);
  const acts = r.event(ev.fail("reopen-mic", micError("missing"), { kept: false }), 80);
  assert.deepEqual(brief(acts), [{ do: "report", kind: "lost" }, retryIn(250)]);
  assert.equal(acts[0].outage.kind, "fault");
  assert.equal(acts[0].outage.cause, "change-failed");
  assert.deepEqual(r.event(ev.retry, 330), [{ do: "reopen-mic", mode: "recover" }]);
  r.event(ev.ok("reopen-mic"), 400);
  const record = r.event(ev.heartbeat, 450)[1].record;
  assert.equal(record.cause, "change-failed");
  assert.equal(record.lostAtMs, 80);
  assert.equal(r.log.length, 1);
});

test("change: no heartbeat after it → a fault (change-failed), reported lost", () => {
  const r = running();
  r.event({ type: "rebuild-request", reason: "route" }, 0);
  r.event(ev.ok("rebuild"), 300);
  const acts = r.event(ev.verify, 900);
  assert.deepEqual(brief(acts), [{ do: "report", kind: "lost" }, retryIn(250)]);
  assert.equal(acts[0].outage.cause, "change-failed");
  assert.deepEqual(r.event(ev.retry, 1150), [rebuild(false)]);
});

test("change: a context error during it is reported lost then, and logged when back", () => {
  const r = running();
  r.event({ type: "mic-request", reason: "user" }, 0);
  const acts = r.event(ev.error, 70);
  assert.deepEqual(brief(acts), [{ do: "report", kind: "lost" }]);
  assert.equal(acts[0].outage.kind, "fault");
  assert.equal(acts[0].outage.cause, "render-error");
  assert.equal(acts[0].outage.lostAtMs, 70);
  assert.deepEqual(r.event(ev.ok("reopen-mic"), 150), [rebuild(false)], "the mic op is done; now the context");
  assert.deepEqual(r.event(ev.ok("rebuild"), 450), [SET_VERIFY]);
  const back = r.event(ev.heartbeat, 500);
  assert.equal(back[1].kind, "back");
  const record = back[1].record;
  assert.equal(record.outageMs, 430);
  assert.equal(record.serviceBackAtMs, 150, "the mic op began before the loss: it does not count");
  assert.equal(record.waitMs, 80);
  assert.deepEqual(record.steps, ["reopen-mic", "rebuild"]);
  assert.equal(record.micToo, false, "the user's new microphone is not one Windows took away");
  assert.equal(r.log.length, 1);
});

test("change: a fault during it that also loses the microphone is micToo", () => {
  const r = running();
  r.event({ type: "mic-request", reason: "user" }, 0);
  r.event(ev.error, 70);
  assert.deepEqual(r.event(ev.fail("reopen-mic", micError("busy", "NotReadableError"), { kept: false }), 150), [retryIn(250)]);
  assert.deepEqual(r.event(ev.retry, 400), [rebuild(true)]);
  r.event(ev.ok("rebuild"), 700);
  const record = r.event(ev.heartbeat, 760)[1].record;
  assert.equal(record.micToo, true);
  assert.equal(record.cause, "render-error");
});

test("change: a microphone that fails while the old one stays live, after a fault came in: the fault is rebuilt with the live microphone", () => {
  // The user picks microphone B, which another app holds. While its reopen runs, the context reports an error.
  // The reopen fails, but microphone A is still live: the rebuild for the fault keeps A (reopenMic false)
  // instead of trying the busy B again and again, and the page hears the switch failed once the voice is back.
  const r = running();
  assert.deepEqual(r.event({ type: "mic-request", reason: "user" }, 10000), [{ do: "reopen-mic", mode: "full" }]);
  assert.deepEqual(brief(r.event(ev.error, 10050)), [{ do: "report", kind: "lost" }]);
  const busy = micError("busy", "NotReadableError");
  assert.deepEqual(r.event(ev.fail("reopen-mic", busy, { kept: true }), 10100), [rebuild(false)]);
  assert.equal(r.outage.needMic, false);
  assert.deepEqual(r.event(ev.ok("rebuild"), 10400), [SET_VERIFY]);
  const back = r.event(ev.heartbeat, 10450);
  assert.deepEqual(brief(back), [CLEAR_VERIFY, { do: "report", kind: "back" }, { do: "report", kind: "change-failed" }]);
  assert.equal(back[2].error, busy, "after back: the page shows the voice as running on change-failed");
  assert.equal(back[1].record.cause, "render-error");
  assert.deepEqual(back[1].record.steps, ["reopen-mic", "rebuild"]);
  assert.equal(back[1].record.micToo, false);
  assert.equal(back[1].record.serviceBackAtMs, 10100);
  assert.equal(back[1].record.waitMs, 50, "from the loss to the rebuild: the failed switch was in the way");
});

test("change: a blocked microphone that kept the old one never holds up the fault's recovery", () => {
  const r = running();
  r.event({ type: "mic-request", reason: "user" }, 0);
  r.event(ev.closed, 30);
  const blocked = micError("blocked", "NotAllowedError");
  assert.deepEqual(r.event(ev.fail("reopen-mic", blocked, { kept: true }), 60), [rebuild(false)]);
  assert.equal(r.phase, "recovering", "not blocked: the old microphone works");
  r.event(ev.ok("rebuild"), 300);
  const back = r.event(ev.heartbeat, 350);
  assert.deepEqual(brief(back), [CLEAR_VERIFY, { do: "report", kind: "back" }, { do: "report", kind: "change-failed" }]);
  assert.equal(back[2].error, blocked);
});

test("a microphone opened after a failed switch makes the switch old news: no change-failed when back", () => {
  const r = running();
  r.event({ type: "mic-request", reason: "user" }, 0);
  r.event(ev.error, 20);
  assert.deepEqual(r.event(ev.fail("reopen-mic", micError("busy"), { kept: true }), 40), [rebuild(false)]);
  // The user picks microphone C while the rebuild runs; it opens.
  assert.deepEqual(r.event({ type: "mic-request", reason: "user" }, 60), []);
  assert.deepEqual(r.event(ev.ok("rebuild"), 300), [{ do: "reopen-mic", mode: "recover" }]);
  assert.deepEqual(r.event(ev.ok("reopen-mic"), 400), [SET_VERIFY]);
  assert.deepEqual(brief(r.event(ev.heartbeat, 450)), [CLEAR_VERIFY, { do: "report", kind: "back" }]);
  // The same when C is asked for while B's reopen runs: the fault's rebuild then opens C itself.
  const q = running();
  q.event({ type: "mic-request", reason: "user" }, 0);
  q.event(ev.error, 20);
  assert.deepEqual(q.event({ type: "mic-request", reason: "user" }, 30), []);
  assert.deepEqual(q.event(ev.fail("reopen-mic", micError("busy"), { kept: true }), 40), [rebuild(true)]);
  assert.deepEqual(q.event(ev.ok("rebuild"), 300), [SET_VERIFY]);
  assert.deepEqual(brief(q.event(ev.heartbeat, 350)), [CLEAR_VERIFY, { do: "report", kind: "back" }]);
});

test("a microphone request served during the first start or a fault, failing with the old microphone live: verified, not retried", () => {
  // The first start: the user picks a microphone while it runs.
  let r = new OutputRecovery();
  r.start(0);
  assert.deepEqual(r.event({ type: "mic-request", reason: "user" }, 100), []);
  assert.deepEqual(r.event(ev.ok("rebuild"), 300), [{ do: "reopen-mic", mode: "full" }]);
  const busy = micError("busy");
  assert.deepEqual(r.event(ev.fail("reopen-mic", busy, { kept: true }), 350), [SET_VERIFY]);
  const started = r.event(ev.heartbeat, 400);
  assert.deepEqual(brief(started), [CLEAR_VERIFY, { do: "report", kind: "started" }, { do: "report", kind: "change-failed" }]);
  assert.equal(started[2].error, busy);
  assert.deepEqual(r.startRecord.steps, ["rebuild", "reopen-mic"]);
  // A fault: the wanted microphone came back while a stand-in fed the cable, but another app holds it.
  r = running();
  r.event(ev.suspended, 0);
  assert.deepEqual(r.event({ type: "mic-request", reason: "wanted-back" }, 20), []);
  assert.deepEqual(r.event(ev.ok("resume"), 50), [{ do: "reopen-mic", mode: "recover" }]);
  assert.deepEqual(r.event(ev.fail("reopen-mic", busy, { kept: true }), 90), [SET_VERIFY]);
  const back = r.event(ev.heartbeat, 120);
  assert.deepEqual(brief(back), [CLEAR_VERIFY, { do: "report", kind: "back" }, { do: "report", kind: "change-failed" }]);
  assert.deepEqual(back[1].record.steps, ["resume", "reopen-mic"]);
  // A failed reopen-mic without kept during a fault still reopens the microphone.
  r = running();
  r.event(ev.micEnded, 0);
  assert.deepEqual(r.event(ev.fail("reopen-mic", busy, { kept: false }), 40), [retryIn(250)]);
  assert.deepEqual(r.event(ev.retry, 290), [{ do: "reopen-mic", mode: "recover" }]);
});

test("change: only a reopen can keep the old microphone: a failed rebuild is a failure whatever it says", () => {
  // A rebuild tears the old context down first, so nothing it leaves can still feed the cable.
  const r = running();
  r.event({ type: "rebuild-request", reason: "output" }, 0);
  const acts = r.event(ev.fail("rebuild", sinkError("transient"), { kept: true }), 100);
  assert.deepEqual(brief(acts), [{ do: "report", kind: "lost" }, retryIn(250)]);
  assert.equal(acts[0].outage.cause, "change-failed");
});

test("change: one that turns into a fault keeps none of its own timings in the fault's record", () => {
  // A route change whose rebuild works but plays nothing: a fault ("change-failed") from the missing heartbeat.
  const r = running();
  r.event({ type: "rebuild-request", reason: "route" }, 0);
  r.event(ev.devices(false, true), 100);
  r.event(ev.devices(true, true), 200);
  r.event(ev.ok("rebuild"), 300);
  assert.equal(brief(r.event(ev.verify, 900))[0].kind, "lost");
  assert.deepEqual(r.event(ev.retry, 1150), [rebuild(false)]);
  r.event(ev.ok("rebuild"), 1400);
  const record = r.event(ev.heartbeat, 1450)[1].record;
  assert.equal(record.lostAtMs, 900);
  assert.equal(record.serviceBackAtMs, 1150, "the fault's own first op that worked, not the change's (at 0)");
  assert.equal(record.appMs, 300);
  assert.equal(record.waitMs, 250);
  assert.equal(record.devicesGoneAtMs, null, "the cable went and came back during the change, not the fault");
  assert.equal(record.devicesBackAtMs, null);
});

test("change: a rebuild request while a fault's rebuild is pending → one more rebuild after it", () => {
  const r = running();
  r.event(ev.closed, 0);
  assert.deepEqual(r.event({ type: "rebuild-request", reason: "output" }, 100), []);
  assert.deepEqual(r.event(ev.ok("rebuild"), 400), [rebuild(false)]);
  assert.deepEqual(r.event(ev.ok("rebuild"), 700), [SET_VERIFY]);
  assert.equal(r.event(ev.heartbeat, 750)[1].kind, "back");
  assert.deepEqual(r.log[0].steps, ["rebuild", "rebuild"]);
});

test("change: requests while waiting or blocked try again at once", () => {
  const r = running();
  r.event(ev.closed, 0);
  r.event(ev.fail("rebuild", sinkError("transient")), 50);
  assert.deepEqual(r.event({ type: "mic-request", reason: "user" }, 60), [CLEAR_RETRY, rebuild(true)]);
  r.event(ev.fail("rebuild", sinkError("blocked")), 90);
  assert.equal(r.phase, "blocked");
  assert.deepEqual(r.event({ type: "rebuild-request", reason: "output" }, 100), [rebuild(false)]);
});

test("a request while verifying marks the op dirty: one more op after the heartbeat", () => {
  const r = running();
  r.event(ev.closed, 0);
  r.event(ev.ok("rebuild"), 300);
  assert.deepEqual(r.event({ type: "mic-request", reason: "user" }, 320), []);
  assert.deepEqual(r.event(ev.heartbeat, 350), [CLEAR_VERIFY, { do: "reopen-mic", mode: "recover" }]);
});

// ---------- Windows Audio restart ----------

test("Windows Audio restart with devices events: the record splits Windows' time from the app's", () => {
  const r = running();
  const at = (t, e) => r.event(e, t);
  assert.deepEqual(brief(at(0, ev.micEnded)), [{ do: "report", kind: "lost" }, { do: "reopen-mic", mode: "recover" }]);
  assert.deepEqual(at(5, ev.error), []);
  assert.deepEqual(at(20, ev.devices(false, false)), []);
  assert.deepEqual(at(40, ev.fail("reopen-mic", micError("busy", "NotReadableError"))), [retryIn(250)]);
  const stillTrying = [];
  for (const t of [290, 580, 870, 1160, 1450]) {
    const acts = at(t, ev.retry);
    assert.deepEqual(acts[0], rebuild(true), `attempt at ${t}`);
    if (acts.some((a) => a.kind === "still-trying")) stillTrying.push(t);
    assert.deepEqual(at(t + 40, ev.fail("rebuild", micError("busy", "NotReadableError"))), [retryIn(250)]);
  }
  assert.deepEqual(stillTrying, [1160]);
  assert.deepEqual(at(1500, ev.devices(true, true)), [CLEAR_RETRY, rebuild(true)]);
  assert.equal(r.outage.attempts, 7);
  assert.deepEqual(at(1700, ev.ok("rebuild")), [SET_VERIFY]);
  const back = at(1800, ev.heartbeat);
  assert.deepEqual(brief(back), [CLEAR_VERIFY, { do: "report", kind: "back" }]);
  assert.deepEqual(back[1].record, {
    cause: "mic-ended",
    lostAtMs: 0,
    backAtMs: 1800,
    outageMs: 1800,
    attempts: 7,
    steps: ["reopen-mic", "rebuild", "rebuild", "rebuild", "rebuild", "rebuild", "rebuild"],
    devicesGoneAtMs: 20,
    devicesBackAtMs: 1500,
    afterDevicesBackMs: 300,
    serviceBackAtMs: 1500,
    appMs: 300,
    waitMs: 10,
    micToo: true,
  });
  assert.equal(restartVerdict(back[1].record).verdict, "pass");
});

/** S2-02: the context errors, the mic ends, no device event comes; rebuilds fail until `serviceBackAt`. */
function restartWithoutDevices(serviceBackAt) {
  const r = running();
  assert.deepEqual(brief(r.event(ev.error, 0)), [{ do: "report", kind: "lost" }, { do: "resume" }]);
  assert.deepEqual(r.event(ev.micEnded, 2), []);
  let acts = r.event(ev.fail("resume", named("ResumeFailed")), 10);
  assert.deepEqual(acts, [rebuild(true)], "the failed resume is followed by a rebuild at once");
  let t = 10;
  const attempts = [10];
  while (t < serviceBackAt) {
    acts = r.event(ev.fail("rebuild", micError("busy", "NotReadableError")), t + 50);
    assert.deepEqual(acts, [retryIn(250)]);
    t += 300;
    acts = r.event(ev.retry, t);
    assert.deepEqual(acts[0], rebuild(true));
    attempts.push(t);
  }
  return { r, t, attempts };
}

test("Windows Audio restart without devices events (back after 1.5 s)", () => {
  const { r, t, attempts } = restartWithoutDevices(1500);
  assert.deepEqual(attempts, [10, 310, 610, 910, 1210, 1510]);
  assert.equal(t, 1510);
  assert.deepEqual(r.event(ev.ok("rebuild"), 1700), [SET_VERIFY]);
  const record = r.event(ev.heartbeat, 1780)[1].record;
  assert.equal(record.outageMs, 1780);
  assert.equal(record.attempts, 7);
  assert.deepEqual(record.steps, ["resume", "rebuild", "rebuild", "rebuild", "rebuild", "rebuild", "rebuild"]);
  assert.equal(record.serviceBackAtMs, 1510);
  assert.equal(record.appMs, 270);
  assert.equal(record.waitMs, 250);
  assert.equal(record.devicesBackAtMs, null);
  assert.equal(record.devicesGoneAtMs, null);
  assert.equal(record.micToo, true);
  assert.deepEqual(restartVerdict(record), { verdict: "pass", text: "pass" });
});

test("Windows Audio restart without devices events (back after 2.7 s): Windows' part is told apart", () => {
  const { r, t } = restartWithoutDevices(2600);
  assert.equal(t, 2710);
  r.event(ev.ok("rebuild"), 2900);
  const record = r.event(ev.heartbeat, 2980)[1].record;
  assert.equal(record.outageMs, 2980);
  assert.equal(record.serviceBackAtMs, 2710);
  assert.equal(record.appMs, 270);
  assert.equal(record.waitMs, 250);
  assert.equal(record.attempts, 11);
  assert.deepEqual(restartVerdict(record), { verdict: "pass", text: "pass (Windows itself took about 2.7 s)" });
});

test("Windows Audio restart without devices events that takes 16 s or 30 s: the app's part is still one fast retry", () => {
  // README step 9 allows up to 30 s. With a 1 s retry after 15 s, waitMs was always ~1000 ms and
  // appMs + waitMs > RESTART_APP_MS: the row failed however quickly the app rebuilt.
  for (const [backAt, firstOk, text] of [
    [16000, 16210, "pass (Windows itself took about 16.2 s)"],
    [30000, 30010, "pass (Windows itself took about 30.0 s)"],
  ]) {
    const { r, t } = restartWithoutDevices(backAt);
    assert.equal(t, firstOk);
    r.event(ev.ok("rebuild"), t + 190);
    const record = r.event(ev.heartbeat, t + 270)[1].record;
    assert.equal(record.serviceBackAtMs, firstOk);
    assert.equal(record.appMs, 270);
    assert.equal(record.waitMs, 250);
    assert.equal(record.micToo, true);
    assert.deepEqual(restartVerdict(record), { verdict: "pass", text });
  }
});

test("recovery.js is pure: no clock, timer, console or DOM", () => {
  const code = readFileSync(new URL("../src/core/recovery.js", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.doesNotMatch(code, /Date\.now|performance\.|new Date|setTimeout|setInterval|requestAnimationFrame|console\.|document\.|window\.|navigator\.|globalThis/);
});
