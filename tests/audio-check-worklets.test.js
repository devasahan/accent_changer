// The checks' worklets, ac-cablewatch and ac-recorder, run in Node through a small stand-in for the
// AudioWorkletGlobalScope: what they send, where they stop, and that a finished one lets the browser drop it.
import test from "node:test";
import assert from "node:assert/strict";
import { tone, zeroFill, whiteNoise } from "./helpers/synth.js";
import { envelopeDb } from "../src/core/delay-estimate.js";

const registered = new Map();
globalThis.sampleRate = 48000;
globalThis.currentFrame = 0;
globalThis.registerProcessor = (name, cls) => registered.set(name, cls);
class Port {
  constructor() {
    this.sent = [];
    this.onmessage = null;
  }
  postMessage(data, transfer) {
    this.sent.push({ data, transfer });
  }
  deliver(data) {
    this.onmessage?.({ data });
  }
}
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = new Port();
  }
};
await import("../src/audio/worklets/cablewatch.worklet.js");
await import("../src/audio/worklets/recorder.worklet.js");

const Watch = registered.get("ac-cablewatch");
const Recorder = registered.get("ac-recorder");

function watch(options) {
  return new Watch({ numberOfInputs: 2, numberOfOutputs: 0, processorOptions: options });
}

/** Push in0/in1 (Float32Array, or null = not connected) through process() in 128-frame quanta. → what process() returned */
function run(proc, in0, in1, frames) {
  const n = frames ?? Math.max(in0?.length ?? 0, in1?.length ?? 0);
  const returned = [];
  for (let i = 0; i < n; i += 128) {
    const a = in0 ? [in0.subarray(i, i + 128)] : [];
    const b = in1 ? [in1.subarray(i, i + 128)] : [];
    returned.push(proc.process([a, b], []));
    globalThis.currentFrame += 128;
  }
  return returned;
}
const sent = (proc, type) => proc.port.sent.map((m) => m.data).filter((d) => d && d.type === type);
const noise = (seconds, seed = 3, dbfs = -40) => whiteNoise(Math.round(seconds * 48000), seed, dbfs);

test("ac-cablewatch and ac-recorder are registered under their app names", () => {
  assert.equal(typeof Watch, "function");
  assert.equal(typeof Recorder, "function");
  assert.equal(registered.has("spike-recorder"), false);
});

// ---------------------------------------------------------------- ac-cablewatch

test("tone mode: a clean tone gives one summary a second, locked at −12 dBFS, no events", () => {
  const w = watch({ mode: "tone" });
  const t0 = Date.now();
  run(w, noise(3), tone({ seconds: 3 }));
  const s = sent(w, "summary");
  assert.deepEqual(s.map((m) => m.frame), [48000, 96000, 144000]);
  for (const m of s) {
    assert.equal(m.mode, "tone");
    assert.equal(m.final, false);
    assert.ok(m.producedEpochMs >= t0 && m.producedEpochMs <= Date.now());
    assert.ok(Array.isArray(m.refRuns) && m.refRuns.length === 0);
    assert.equal(m.env, undefined);
    assert.equal(m.sigRuns, undefined);
  }
  const last = s[s.length - 1].tone;
  assert.equal(last.locked, true);
  assert.ok(Math.abs(last.levelDb + 12) < 0.2, String(last.levelDb));
  assert.ok(Math.abs(last.lockDb + 12) < 0.2);
  assert.ok(Math.abs(last.minStableDb + 12) < 0.2);
  assert.deepEqual(last.counts, { holes: 0, skips: 0, clicks: 0, dropouts: 0, gaps: 0, levels: 0, steps: 0, noises: 0 });
  assert.equal(s.flatMap((m) => m.tone.events).length, 0);
  assert.equal(sent(w, "done").length, 0);
});

test("tone mode: a 300 ms cut is one gap of 300 ms where it was", () => {
  const w = watch({ mode: "tone" });
  const x = zeroFill(tone({ seconds: 4 }), 72000, 14400);
  run(w, noise(4), x);
  w.port.deliver("stop");
  const events = sent(w, "summary").flatMap((m) => m.tone.events);
  assert.equal(events.length, 1, JSON.stringify(events));
  assert.equal(events[0].kind, "gap");
  assert.ok(Math.abs(events[0].holeMs - 300) <= 1, String(events[0].holeMs));
  assert.ok(Math.abs(events[0].atFrame - 72000) <= 1056, String(events[0].atFrame));
  const final = sent(w, "summary").pop();
  assert.equal(final.final, true);
  assert.equal(final.tone.counts.gaps, 1);
});

test("stopAfterFrames: it stops at exactly that frame, sends a last summary and done, then nothing", () => {
  const w = watch({ mode: "tone", stopAfterFrames: 100000 });
  run(w, noise(3), tone({ seconds: 3 }));
  const s = sent(w, "summary");
  assert.deepEqual(s.map((m) => m.frame), [48000, 96000, 100000]);
  assert.deepEqual(s.map((m) => m.final), [false, false, true]);
  assert.deepEqual(sent(w, "done"), [{ type: "done", frame: 100000 }]);
  const n = w.port.sent.length;
  run(w, noise(1), tone({ seconds: 1 }));
  w.port.deliver("stop");
  w.port.deliver({ type: "extend", stopAfterFrames: 500000 });
  assert.equal(w.port.sent.length, n, "nothing after done");
});

test("a finished watcher returns false, so the browser can drop it once its inputs are disconnected", () => {
  // Done at its own end: true while it watches, false from the quantum that reached the end.
  const w = watch({ mode: "tone", stopAfterFrames: 1000 });
  const returned = run(w, noise(0.05), tone({ seconds: 0.05 }));
  const end = Math.floor(1000 / 128); // the quantum with frame 1000 in it
  assert.ok(returned.slice(0, end).every((r) => r === true), JSON.stringify(returned));
  assert.ok(returned.slice(end).every((r) => r === false), JSON.stringify(returned));
  assert.deepEqual(sent(w, "done"), [{ type: "done", frame: 1000 }]);

  // Done on "stop", in both modes.
  for (const mode of ["tone", "mic"]) {
    const v = watch({ mode });
    assert.ok(run(v, noise(0.5), noise(0.5, 4)).every((r) => r === true), mode);
    v.port.deliver("stop");
    assert.ok(run(v, noise(0.1), noise(0.1, 4)).every((r) => r === false), mode);
    assert.equal(sent(v, "done").length, 1, mode);
  }

  // Done when an extend says the end has passed already.
  const x = watch({ mode: "tone", stopAfterFrames: 480000 });
  run(x, noise(0.2), tone({ seconds: 0.2 }));
  x.port.deliver({ type: "extend", stopAfterFrames: 10 });
  assert.equal(x.process([[noise(0.01).subarray(0, 128)], [tone({ seconds: 0.01 }).subarray(0, 128)]], []), false);
});

test("stop: a tone lost at the very end is closed as a gap in the last summary", () => {
  const w = watch({ mode: "tone" });
  const x = zeroFill(tone({ seconds: 3 }), 120000, 24000); // lost for the last 0.5 s
  run(w, noise(3), x);
  w.port.deliver("stop");
  const final = sent(w, "summary").pop();
  assert.equal(final.final, true);
  assert.equal(final.frame, 144000);
  const gap = final.tone.events.find((e) => e.kind === "gap");
  assert.ok(gap && gap.holeMs >= 490, JSON.stringify(final.tone.events));
  assert.equal(sent(w, "done").length, 1);
});

test("extend: a later stop, never earlier than what was watched", () => {
  const w = watch({ mode: "tone", stopAfterFrames: 60000 });
  run(w, noise(0.5), tone({ seconds: 0.5 }));
  w.port.deliver({ type: "extend", stopAfterFrames: 120000 });
  run(w, noise(3), tone({ seconds: 3 }));
  assert.deepEqual(sent(w, "done"), [{ type: "done", frame: 120000 }]);

  const v = watch({ mode: "tone", stopAfterFrames: 480000 });
  run(v, noise(1), tone({ seconds: 1 }));
  v.port.deliver({ type: "extend", stopAfterFrames: 1000 }); // already past it: stops now
  assert.deepEqual(sent(v, "done"), [{ type: "done", frame: 48000 }]);
  v.port.deliver({ type: "extend", stopAfterFrames: "x" });
  assert.equal(sent(v, "done").length, 1);
});

test("an extend that is not a number is ignored", () => {
  const w = watch({ mode: "tone", stopAfterFrames: 60000 });
  w.port.deliver({ type: "extend", stopAfterFrames: Number.NaN });
  w.port.deliver({ type: "extend" });
  run(w, noise(2), tone({ seconds: 2 }));
  assert.deepEqual(sent(w, "done"), [{ type: "done", frame: 60000 }]);
});

test("mic mode: the envelopes equal delay-estimate's envelopeDb, frame for frame, across summaries", () => {
  const w = watch({ mode: "mic" });
  const ref = noise(3.5, 5, -30);
  const sig = noise(3.5, 9, -35);
  run(w, ref, sig);
  w.port.deliver("stop");
  const s = sent(w, "summary");
  let next = 0;
  const refEnv = [];
  const sigEnv = [];
  for (const m of s) {
    assert.equal(m.env.frame0, next, "frame0 continues where the last take ended");
    assert.equal(m.env.ref.length, m.env.sig.length);
    next += m.env.ref.length;
    refEnv.push(...m.env.ref);
    sigEnv.push(...m.env.sig);
  }
  const a = envelopeDb(ref, 48000, { hopMs: 5, winMs: 10 }).db;
  const b = envelopeDb(sig, 48000, { hopMs: 5, winMs: 10 }).db;
  assert.ok(refEnv.length >= a.length - 2 && refEnv.length <= a.length, `${refEnv.length} vs ${a.length}`);
  for (let i = 0; i < refEnv.length; i++) {
    assert.ok(Math.abs(refEnv[i] - a[i]) < 1e-3, `ref ${i}: ${refEnv[i]} vs ${a[i]}`);
    assert.ok(Math.abs(sigEnv[i] - b[i]) < 1e-3, `sig ${i}: ${sigEnv[i]} vs ${b[i]}`);
  }
  // The envelope buffers are transferred, not copied.
  const first = w.port.sent.find((m) => m.data.type === "summary");
  assert.equal(first.transfer.length, 2);
  assert.ok(first.transfer.includes(first.data.env.ref.buffer) && first.transfer.includes(first.data.env.sig.buffer));
});

test("zero runs: a 10 ms hole on each input is reported where it was, with refZeroFrames", () => {
  const w = watch({ mode: "mic" });
  const ref = zeroFill(noise(2, 5), 57600, 480);
  const sig = zeroFill(noise(2, 9), 61000, 960);
  run(w, ref, sig);
  const s = sent(w, "summary");
  const refRuns = s.flatMap((m) => m.refRuns);
  const sigRuns = s.flatMap((m) => m.sigRuns);
  assert.deepEqual(refRuns, [{ startFrame: 57600, frames: 480 }]);
  assert.deepEqual(sigRuns, [{ startFrame: 61000, frames: 960 }]);
  assert.equal(s[s.length - 1].refZeroFrames, 480);
  assert.equal(s[s.length - 1].sigZeroFrames, 960);

  const t = watch({ mode: "tone" });
  run(t, zeroFill(noise(2, 5), 50000, 480), tone({ seconds: 2 }));
  assert.deepEqual(sent(t, "summary").flatMap((m) => m.refRuns), [{ startFrame: 50000, frames: 480 }]);
});

test("missing inputs count as zeros: no tone found; a microphone that never came is one long run at the end", () => {
  const w = watch({ mode: "tone" });
  run(w, null, null, 96000);
  w.port.deliver("stop");
  const s = sent(w, "summary");
  assert.equal(s[s.length - 1].tone.locked, false);
  assert.equal(s.flatMap((m) => m.tone.events).length, 0);
  assert.deepEqual(s.flatMap((m) => m.refRuns), [{ startFrame: 0, frames: 96000 }]);
});

test("defaults: tone mode, a summary every 48000 frames, no stop by itself", () => {
  const w = new Watch({ numberOfInputs: 2, numberOfOutputs: 0 });
  run(w, noise(5), tone({ seconds: 5 }));
  assert.equal(sent(w, "summary").length, 5);
  assert.equal(sent(w, "summary")[0].mode, "tone");
  assert.equal(sent(w, "done").length, 0);
  const m = watch({ mode: "mic", summaryFrames: 24000 });
  run(m, noise(1), noise(1, 4));
  // A summary comes at the end of the quantum where its frames are reached; the next one catches up.
  assert.deepEqual(sent(m, "summary").map((x) => x.frame), [24064, 48000]);
});

test("600 s of tone through the watcher takes well under real time", () => {
  const w = watch({ mode: "tone" });
  const block = tone({ seconds: 10 });
  const mic = noise(10);
  const t0 = performance.now();
  for (let k = 0; k < 60; k++) run(w, mic, block);
  const ms = performance.now() - t0;
  assert.equal(sent(w, "summary").length, 600);
  assert.ok(ms < 3000, `${ms.toFixed(0)} ms`);
});

// ---------------------------------------------------------------- ac-recorder

function recorder(inputs, processorOptions) {
  return new Recorder({ numberOfInputs: inputs, numberOfOutputs: 0, processorOptions });
}

test("recorder: nothing before start; 3 inputs side by side in 4800-frame chunks, transferred", () => {
  const r = recorder(3);
  const a = noise(0.3, 1);
  const b = noise(0.3, 2);
  const c = noise(0.3, 3);
  const push = (n0, n1) => {
    for (let i = n0; i < n1; i += 128) r.process([[a.subarray(i, i + 128)], [b.subarray(i, i + 128)], [c.subarray(i, i + 128)]], []);
  };
  push(0, 1280);
  assert.equal(r.port.sent.length, 0);
  r.port.deliver("start");
  push(1280, 1280 + 9600);
  const chunks = r.port.sent.filter((m) => m.data.type === "chunk");
  assert.equal(chunks.length, 2);
  for (const [k, m] of chunks.entries()) {
    assert.equal(m.data.parts.length, 3);
    assert.equal(m.transfer.length, 3);
    for (const [i, src] of [a, b, c].entries()) {
      assert.deepEqual(Array.from(m.data.parts[i]), Array.from(src.subarray(1280 + k * 4800, 1280 + (k + 1) * 4800)));
    }
  }
});

test("recorder: an input not connected is zeros; stop sends the rest, then stopped", () => {
  const r = recorder(2, { chunkFrames: 1000 });
  const a = noise(0.1, 1);
  r.port.deliver("start");
  for (let i = 0; i < 2560; i += 128) r.process([[a.subarray(i, i + 128)], []], []);
  r.port.deliver("stop");
  const data = r.port.sent.map((m) => m.data);
  assert.deepEqual(data.map((d) => d.type), ["chunk", "chunk", "chunk", "stopped"]);
  assert.deepEqual(data.slice(0, 3).map((d) => d.parts[0].length), [1000, 1000, 560]);
  for (const d of data.slice(0, 3)) assert.ok(d.parts[1].every((x) => x === 0));
  const before = r.port.sent.length;
  for (let i = 0; i < 1280; i += 128) r.process([[a.subarray(0, 128)], []], []);
  assert.equal(r.port.sent.length, before, "nothing after stop");
});

test("recorder: true while it waits for start or records, false once stopped (the browser can then drop it)", () => {
  const r = recorder(2);
  const a = noise(0.1, 1);
  const quantum = () => r.process([[a.subarray(0, 128)], []], []);
  // Before "start": still wanted. A processor that returns false with nothing connected yet is never called again.
  for (let i = 0; i < 5; i++) assert.equal(quantum(), true, "before start");
  r.port.deliver("start");
  for (let i = 0; i < 5; i++) assert.equal(quantum(), true, "recording");
  r.port.deliver("stop");
  for (let i = 0; i < 5; i++) assert.equal(quantum(), false, "stopped");
  // A "start" after "stop" records afresh on the same node, as long as the browser still calls it.
  r.port.deliver("start");
  assert.equal(quantum(), true, "started again");
  // "stop" before any "start" finishes it too.
  const never = recorder(1);
  never.port.deliver("stop");
  assert.equal(never.process([[a.subarray(0, 128)]], []), false);
});

test("recorder: options it cannot use fall back to 4800 frames and 1 input", () => {
  for (const chunkFrames of [0, -5, 1.5, "x", null]) {
    const r = recorder(1, { chunkFrames });
    assert.equal(r.chunkFrames, 4800, String(chunkFrames));
  }
  const r = new Recorder({});
  assert.equal(r.inputsCount, 1);
  r.port.deliver("start");
  for (let i = 0; i < 4800; i += 128) r.process([[]], []);
  const chunk = r.port.sent.find((m) => m.data.type === "chunk");
  assert.ok(chunk && chunk.data.parts[0].every((x) => x === 0));
});
