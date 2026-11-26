import test from "node:test";
import assert from "node:assert/strict";
import { FaultPolicy } from "../src/core/faults.js";

const healthy = (nowMs, extra = {}) => ({ nowMs, healthyMs: 3000, atPause: true, ...extra });

test("defaults: interview mode, unlocked, no faults; a first return needs only health and a pause", () => {
  const p = new FaultPolicy();
  assert.equal(p.mode, "interview");
  assert.equal(p.locked, false);
  assert.deepEqual(p.faults, []);
  // The mixer asks while "connecting" after the user's Convert: nothing has failed yet.
  assert.equal(p.mayReturn(healthy(0)), true);
});

test("every return needs healthyMs >= healthyNeededMs and a pause", () => {
  const p = new FaultPolicy({ mode: "practice" });
  assert.equal(p.mayReturn({ nowMs: 0, healthyMs: 2999, atPause: true }), false);
  assert.equal(p.mayReturn({ nowMs: 0, healthyMs: 3000, atPause: false }), false);
  assert.equal(p.mayReturn({ nowMs: 0, healthyMs: NaN, atPause: true }), false);
  assert.equal(p.mayReturn({ nowMs: 0, atPause: true }), false);
  assert.equal(p.mayReturn({ nowMs: 0, healthyMs: 3000, atPause: true }), true);
  // Also after a fault, once the backoff has passed.
  p.fault(1000, "stall");
  assert.equal(p.mayReturn({ nowMs: 9000, healthyMs: 2000, atPause: true }), false);
  assert.equal(p.mayReturn({ nowMs: 9000, healthyMs: 5000, atPause: false }), false);
  assert.equal(p.mayReturn({ nowMs: 9000, healthyMs: 5000, atPause: true }), true);
  const custom = new FaultPolicy({ healthyNeededMs: 1000 });
  assert.equal(custom.mayReturn({ nowMs: 0, healthyMs: 1000, atPause: true }), true);
});

test("interview mode: after a fault only Convert brings the converted voice back", () => {
  const p = new FaultPolicy({ mode: "interview" });
  assert.deepEqual(p.fault(10000, "stall"), { locked: false, retryAtMs: null });
  // 30 s of perfectly healthy converted speech, pauses everywhere: still own voice.
  for (let t = 10000; t <= 40000; t += 100) assert.equal(p.mayReturn(healthy(t)), false, `t=${t}`);
  p.userConvert(40000);
  assert.equal(p.mayReturn({ nowMs: 40100, healthyMs: 1000, atPause: true }), false, "still needs health");
  assert.equal(p.mayReturn({ nowMs: 40100, healthyMs: 3000, atPause: false }), false, "still needs a pause");
  assert.equal(p.mayReturn(healthy(40200)), true);
  // The approval is used up by the next fault.
  p.fault(50000, "engine-down");
  assert.equal(p.mayReturn(healthy(90000)), false);
});

test("practice mode: returns by itself after the backoff, not before", () => {
  const p = new FaultPolicy({ mode: "practice" });
  assert.deepEqual(p.fault(10000, "stall"), { locked: false, retryAtMs: 10500 });
  assert.equal(p.mayReturn(healthy(10000)), false);
  assert.equal(p.mayReturn(healthy(10499)), false);
  assert.equal(p.mayReturn(healthy(10500)), true);
});

test("practice backoff doubles per fault in a row: 0.5, 1, 2, 4, 8, 10, 10 s", () => {
  // Faults two minutes apart (never 3 in the lock window), converting under 60 s between them.
  const p = new FaultPolicy({ mode: "practice" });
  const waits = [];
  for (let k = 0; k < 7; k++) {
    const at = k * 120000;
    const { locked, retryAtMs } = p.fault(at, "stall");
    assert.equal(locked, false, `fault ${k + 1}`);
    waits.push(retryAtMs - at);
    // Own voice for 70 s (the user listening), then 50 s converted before the next fault.
    assert.equal(p.mayReturn(healthy(at + 70000)), true);
  }
  assert.deepEqual(waits, [500, 1000, 2000, 4000, 8000, 10000, 10000]);
  const custom = new FaultPolicy({ mode: "practice", firstRetryMs: 100, maxRetryMs: 250, lockFaults: 99 });
  assert.deepEqual([1, 2, 3, 4].map((k) => custom.fault(k, "x").retryAtMs - k), [100, 200, 250, 250]);
});

test("a clean 60 s of converting resets the backoff; 59 s does not", () => {
  const p = new FaultPolicy({ mode: "practice" });
  assert.equal(p.fault(0, "stall").retryAtMs, 500);
  assert.equal(p.mayReturn(healthy(4000)), true); // converting again from 4 s
  assert.equal(p.fault(4000 + 59000, "stall").retryAtMs, 63000 + 1000, "59 s clean: next step");
  assert.equal(p.mayReturn(healthy(70000)), true);
  assert.equal(p.mayReturn(healthy(100000)), true, "asking again while converting keeps the stretch start");
  assert.equal(p.fault(70000 + 60000, "stall").retryAtMs, 130000 + 500, "60 s clean: back to the first step");
  assert.equal(p.locked, false, "faults at 63 s and 130 s only: not 3 within 2 minutes");
});

test("a clean stretch ended by the user (own voice) also resets the backoff", () => {
  const p = new FaultPolicy({ mode: "practice", lockFaults: 99 });
  p.fault(0, "stall");
  p.fault(1000, "stall");
  assert.equal(p.mayReturn(healthy(5000)), true);
  p.userOwn(5000 + 61000);
  p.userConvert(70000);
  assert.equal(p.mayReturn(healthy(71000)), true);
  assert.equal(p.fault(72000, "stall").retryAtMs, 72500);
});

test("3 faults within 2 minutes lock the own voice in practice mode, until Convert", () => {
  const p = new FaultPolicy({ mode: "practice" });
  assert.equal(p.fault(0, "stall").locked, false);
  assert.equal(p.mayReturn(healthy(5000)), true);
  assert.equal(p.fault(30000, "bad-output").locked, false);
  assert.equal(p.mayReturn(healthy(35000)), true);
  assert.deepEqual(p.fault(119000, "engine-down"), { locked: true, retryAtMs: null });
  assert.equal(p.locked, true);
  for (let t = 119000; t <= 600000; t += 1000) assert.equal(p.mayReturn(healthy(t)), false, `t=${t}`);
  p.userConvert(600000);
  assert.equal(p.locked, false);
  assert.equal(p.mayReturn({ nowMs: 600100, healthyMs: 100, atPause: true }), false, "Convert still needs health");
  assert.equal(p.mayReturn(healthy(600100)), true);
});

test("lock window: 3 faults spanning exactly 2 minutes lock, 2 min + 1 ms does not", () => {
  const a = new FaultPolicy({ mode: "practice" });
  a.fault(0, "stall");
  a.fault(60000, "stall");
  assert.equal(a.fault(120000, "stall").locked, true);
  const b = new FaultPolicy({ mode: "practice" });
  b.fault(0, "stall");
  b.fault(60000, "stall");
  const r = b.fault(120001, "stall");
  assert.equal(r.locked, false);
  assert.equal(r.retryAtMs, 120001 + 2000, "third fault in a row: 2 s");
  const c = new FaultPolicy({ mode: "practice", lockFaults: 2, lockWindowMs: 10000 });
  c.fault(0, "x");
  assert.equal(c.fault(10000, "x").locked, true);
});

test("after Convert clears a lock, faults inside the window lock again at once", () => {
  const p = new FaultPolicy({ mode: "practice" });
  p.fault(0, "stall");
  p.fault(10000, "stall");
  p.fault(20000, "stall");
  assert.equal(p.locked, true);
  p.userConvert(30000);
  assert.equal(p.mayReturn(healthy(34000)), true);
  assert.deepEqual(p.fault(40000, "stall"), { locked: true, retryAtMs: null });
  assert.equal(p.mayReturn(healthy(200000)), false);
});

test("interview mode counts toward the lock too (shown to the user), retryAtMs stays null", () => {
  const p = new FaultPolicy();
  p.fault(0, "stall");
  p.userConvert(1000);
  p.fault(5000, "stall");
  p.userConvert(6000);
  assert.deepEqual(p.fault(9000, "stall"), { locked: true, retryAtMs: null });
  p.userConvert(10000);
  assert.equal(p.locked, false);
  assert.equal(p.mayReturn(healthy(11000)), true);
});

test("Convert in practice mode returns without waiting for the backoff", () => {
  const p = new FaultPolicy({ mode: "practice", lockFaults: 99 });
  for (let k = 0; k < 5; k++) p.fault(k, "stall"); // 8 s backoff now
  assert.equal(p.mayReturn(healthy(100)), false);
  p.userConvert(100);
  assert.equal(p.mayReturn(healthy(200)), true);
});

test("userOwn: no return at all (practice backoff or not) until Convert", () => {
  const p = new FaultPolicy({ mode: "practice" });
  p.userOwn(0);
  assert.equal(p.mayReturn(healthy(100)), false, "before any fault");
  p.userConvert(200);
  assert.equal(p.mayReturn(healthy(300)), true);
  p.fault(1000, "stall");
  p.userOwn(1100);
  for (let t = 1100; t <= 60000; t += 500) assert.equal(p.mayReturn(healthy(t)), false, `t=${t}`);
  p.userConvert(60000);
  assert.equal(p.mayReturn(healthy(60100)), true);
  // Interview mode the same, even right after a Convert.
  const q = new FaultPolicy();
  q.userConvert(0);
  q.userOwn();
  assert.equal(q.mayReturn(healthy(10)), false);
});

test("setMode: switching modes changes how the next return is decided", () => {
  const p = new FaultPolicy({ mode: "interview" });
  assert.equal(p.fault(0, "stall").retryAtMs, null);
  assert.equal(p.mayReturn(healthy(5000)), false);
  p.setMode("practice");
  assert.equal(p.mode, "practice");
  assert.equal(p.mayReturn(healthy(5000)), true, "the stored 0.5 s backoff has passed");
  assert.equal(p.fault(6000, "stall").retryAtMs, 7000);
  p.setMode("interview");
  assert.equal(p.mayReturn(healthy(20000)), false, "interview: no automatic return");
  p.setMode("karaoke");
  assert.equal(p.mode, "interview", "unknown modes are the safe one");
  assert.equal(new FaultPolicy({ mode: "nonsense" }).mode, "interview");
});

test("faults: recent faults with reasons, older than the window dropped, a copy", () => {
  const p = new FaultPolicy({ mode: "practice", lockFaults: 99 });
  p.fault(0, "stall");
  p.fault(50000, "bad-output");
  p.fault(130000, "engine-down");
  assert.deepEqual(p.faults, [
    { atMs: 50000, reason: "bad-output" },
    { atMs: 130000, reason: "engine-down" },
  ]);
  p.faults.push({ atMs: 1, reason: "x" });
  p.faults[0].reason = "changed";
  assert.equal(p.faults.length, 2);
  assert.equal(p.faults[0].reason, "bad-output");
  for (let k = 0; k < 100; k++) p.fault(140000 + k, "flood");
  assert.equal(p.faults.length, 32, "bounded");
  p.fault(400000);
  assert.deepEqual(p.faults, [{ atMs: 400000, reason: null }], "no reason given: null");
});
