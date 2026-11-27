// src/audio/measure.js on the scripted fakes in tests/helpers/fake-checks.js: what the checks record where,
// what they make of the worklets' messages, how they end, and what they leave behind.
import test from "node:test";
import assert from "node:assert/strict";
import {
  EPOCH,
  clock,
  nodes,
  cableTracks,
  env,
  resetEnv,
  FakeGraph,
  fakeMonitor,
  fakePlatform,
  fakeTrack,
  newest,
  flush,
  whenSent,
} from "./helpers/fake-checks.js";
import { Checks, CHECK_TEXTS, captureLatencyMs } from "../src/audio/measure.js";
import { synthSpeech, addNoise, whiteNoise, delayed } from "./helpers/synth.js";
import { stopAfterHide, analyzeSpeech, LIMITS } from "../src/core/cable-check.js";
import { envelopeDb } from "../src/core/delay-estimate.js";

const ZERO_COUNTS = { holes: 0, skips: 0, clicks: 0, dropouts: 0, gaps: 0, levels: 0, steps: 0, noises: 0 };

function setup({ method = "context", routePreference = "auto", micTrack } = {}) {
  clock.now += 100_000;
  resetEnv();
  const graph = new FakeGraph({ method, routePreference, ...(micTrack ? { micTrack } : {}) });
  const monitor = fakeMonitor();
  const platform = fakePlatform();
  const logs = [];
  const checks = new Checks({ graph, monitor, platform, log: (level, text) => logs.push(`${level} ${text}`) });
  return { graph, monitor, platform, logs, checks };
}

/**
 * A summary at `frame` (the segment's own frames), made at page time `at`, delivered at `arrive`. Tone mode:
 * the tone locked at −12 dBFS unless `locked` is false (then the tone was never found).
 */
function summary(node, { frame, at, arrive = at, counts = {}, events = [], refRuns = [], refZeroFrames = 0, final = false, levelDb = -12, locked = true, mode = "tone", env: envelope = null, sigRuns = [] }) {
  clock.now = arrive;
  const msg = { type: "summary", frame, producedEpochMs: EPOCH + at, mode, final, refRuns, refZeroFrames, refDropped: 0 };
  if (mode === "tone") {
    msg.tone = locked
      ? { locked: true, levelDb, lockDb: -12, minStableDb: -12, phaseDriftPpm: 0, counts: { ...ZERO_COUNTS, ...counts }, events }
      : { locked: false, levelDb: -120, lockDb: null, minStableDb: null, phaseDriftPpm: null, counts: { ...ZERO_COUNTS, ...counts }, events };
  } else {
    msg.env = envelope ?? { frame0: 0, ref: new Float32Array(0), sig: new Float32Array(0), dropped: 0 };
    msg.sigRuns = sigRuns;
    msg.sigZeroFrames = 0;
    msg.sigDropped = 0;
  }
  node.port.emit(msg);
}

/** Summaries for seconds from..to of a segment that started at page time `start` (frames counted from it). */
function seconds(node, start, from, to, extra = () => ({})) {
  for (let k = from; k <= to; k++) summary(node, { frame: k * 48000, at: start + k * 1000, ...extra(k) });
}

/** Answer a 1 s reading of the microphone's buffer: micBus `lagFrames` behind the fresh source. */
async function answerReading(node, lagFrames, seed = 11) {
  const x = whiteNoise(48000 + 6000, seed, -40);
  const fresh = x.subarray(6000, 54000);
  const bus = x.subarray(6000 - lagFrames, 54000 - lagFrames);
  for (let i = 0; i < 48000; i += 4800) node.port.emit({ type: "chunk", parts: [fresh.slice(i, i + 4800), bus.slice(i, i + 4800)] });
  assert.ok(node.port.sent.includes("stop"), "the reading asks its recorder to stop");
  node.port.emit({ type: "stopped" });
  await flush();
}

/** The first node of `name` made after `count` nodes existed (waits for it). */
async function nextNode(name, count) {
  for (let i = 0; i < 200; i++) {
    const n = nodes.slice(count).find((x) => x.name === name);
    if (n) return n;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`no new ${name}`);
}

async function startTone(s, minutes = 65, extra = {}) {
  const progress = [];
  const handle = await s.checks.startLong({ mode: "tone", minutes, onProgress: (p) => progress.push(p), ...extra });
  const node = newest("ac-cablewatch");
  return { handle, node, progress, start: clock.now };
}

// ---------------------------------------------------------------- refusals

test("checks refuse to run without the voice, without CABLE Output, with bad minutes, or while busy", async () => {
  const s = setup();
  s.graph.state = "starting";
  await assert.rejects(s.checks.measureDelay(), { message: CHECK_TEXTS.notRunning });
  await assert.rejects(s.checks.startLong(), { message: CHECK_TEXTS.notRunning });
  s.graph.state = "running";
  s.graph.snapshot = { ...s.graph.snapshot, cableOut: null };
  await assert.rejects(s.checks.measureDelay(), { message: CHECK_TEXTS.noCableOutput });
  await assert.rejects(s.checks.startLong({ mode: "mic", minutes: 1 }), { message: CHECK_TEXTS.noCableOutput });
  assert.equal(s.checks.busy, null);
  for (const minutes of [0, 0.1, 121, Number.NaN, "x"]) await assert.rejects(s.checks.startLong({ minutes }), { message: CHECK_TEXTS.minutes });
  s.graph.snapshot = { ...s.graph.snapshot, cableOut: { deviceId: "cable-out" } };
  const busy = [];
  s.checks.addEventListener("busy", (e) => busy.push(e.detail.busy));
  const { handle, node } = await startTone(s, 1);
  assert.equal(s.checks.busy, "long");
  await assert.rejects(s.checks.measureDelay(), { message: CHECK_TEXTS.busy });
  await assert.rejects(s.checks.startLong(), { message: CHECK_TEXTS.busy });
  assert.equal(s.checks.busy, "long", "a refusal does not end the running check");
  node.port.emit({ type: "done", frame: 0 });
  await handle.done;
  assert.equal(s.checks.busy, null);
  assert.deepEqual(busy, ["long", null]);
});

test("a refused test tone starts nothing: no CABLE Output, no tap, not busy", async () => {
  const s = setup();
  s.monitor.refuse = Object.assign(new Error("refused"), { name: "MonitorError", code: "OUTPUT_IS_CABLE" });
  const before = cableTracks.length;
  await assert.rejects(s.checks.startLong({ mode: "tone", minutes: 1 }), { name: "MonitorError", code: "OUTPUT_IS_CABLE" });
  assert.equal(cableTracks.length, before);
  assert.equal(s.graph.taps.size, 0);
  assert.equal(s.checks.busy, null);
  assert.deepEqual(s.graph.testSourceCalls, []);
});

// ---------------------------------------------------------------- measure the delay

/** Answer the delay recorder: 12 s, CABLE Output `sigMs` behind the fresh source, micBus `busMs` behind it. */
function delaySignals({ sigMs = 60, busMs = 15 } = {}) {
  const x = addNoise(synthSpeech({ seconds: 12.5, seed: 4, leadSec: 0.3, tailSec: 0.4 }).samples, -60);
  const n = 576000;
  return { fresh: x.subarray(0, n), sig: delayed(x, sigMs * 48).subarray(0, n), bus: delayed(x, busMs * 48).subarray(0, n) };
}
async function answerDelay(node, signals, { chunks = 120, before = () => {} } = {}) {
  const parts = node.options.numberOfInputs;
  assert.ok(node.port.sent.includes("start"));
  for (let k = 0; k < chunks; k++) {
    before(k);
    const at = k * 4800;
    const list = [signals.fresh, signals.sig, signals.bus].slice(0, parts).map((a) => a.slice(at, at + 4800));
    node.port.emit({ type: "chunk", parts: list });
  }
  await flush();
  if (node.port.sent.includes("stop")) node.port.emit({ type: "stopped" });
}

test("measureDelay on the context route: three inputs at the graph, passthrough and the buffer's share", async () => {
  const s = setup();
  const progress = [];
  const before = nodes.length;
  const p = s.checks.measureDelay({ onProgress: (left) => progress.push(left) });
  const node = await nextNode("ac-recorder", before);
  assert.equal(node.context, s.graph.ctx, "recorded in the graph's own context");
  assert.equal(node.options.numberOfInputs, 3);
  assert.equal(node.options.numberOfOutputs, 0);
  assert.deepEqual(node.options.processorOptions, { chunkFrames: 4800 });
  const sources = s.graph.ctx.sources;
  assert.ok(sources.some((n) => n.stream === s.graph.micStream && n.links.some(([t, i]) => t === node && i === 0)), "a fresh source of the microphone → input 0");
  assert.ok(sources.some((n) => n.stream !== s.graph.micStream && n.links.some(([t, i]) => t === node && i === 1)), "CABLE Output → input 1");
  assert.ok(s.graph.micBus.links.some(([t, i]) => t === node && i === 2), "micBus → input 2");
  assert.ok(s.graph.ctx.modules.some((u) => u.endsWith("/worklets/recorder.worklet.js")));
  await answerDelay(node, delaySignals());
  const r = await p;
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.passthroughMs - 60) <= 2, String(r.passthroughMs));
  assert.equal(r.micFifoMs, 15);
  assert.ok(r.micFifoScore > 0.99);
  assert.equal(r.captureLatencyMs, 10);
  assert.equal(r.estimateMs, Math.round((r.passthroughMs + 10 + 10) * 10) / 10);
  assert.equal(r.verdict, "good");
  assert.equal(r.site, "graph");
  assert.equal(r.route, "context");
  assert.equal(r.routePreference, "auto");
  assert.equal(r.seconds, 12);
  assert.equal(r.outputLatencyMs, 20);
  assert.equal(r.baseLatencyMs, 10);
  assert.equal(r.cableOutputRateHz, 48000);
  assert.equal(r.cableCaptureLatencyMs, 10);
  assert.deepEqual(r.notes, []);
  assert.equal(progress[0], 12);
  assert.equal(progress[progress.length - 1], 0);
  assert.equal(progress.length, 120);
  assert.equal(s.graph.taps.size, 0, "the tap is removed");
  assert.equal(cableTracks[cableTracks.length - 1].readyState, "ended", "CABLE Output is closed");
  assert.equal(node.links.length + s.graph.micBus.links.filter(([t]) => t === node).length, 0, "the recorder is disconnected");
  assert.equal(s.checks.busy, null);
  assert.ok(s.logs.some((l) => /^info check delay done good [\d.]+ ms fifo 15 ms score [\d.]+ graph$/.test(l)), s.logs.join("\n"));
});

test("measureDelay: an outage, a rebuild or the end of CABLE Output cuts it short with a text", async () => {
  for (const cut of ["lost", "rebuild", "cable"]) {
    const s = setup();
    const before = nodes.length;
    const p = s.checks.measureDelay();
    p.catch(() => {});
    const node = await nextNode("ac-recorder", before);
    const sig = delaySignals();
    await answerDelay(node, sig, {
      chunks: 30,
      before: (k) => {
        if (k !== 20) return;
        if (cut === "lost") s.graph.lost("render-error");
        if (cut === "rebuild") s.graph.dispatchEvent(new CustomEvent("rebuilt", { detail: { generation: 2 } }));
        if (cut === "cable") cableTracks[cableTracks.length - 1].dispatchEvent(new Event("ended"));
      },
    });
    const text = cut === "cable" ? CHECK_TEXTS.cableEnded : CHECK_TEXTS.restarted;
    await assert.rejects(p, { message: text }, cut);
    assert.equal(s.graph.taps.size, 0, cut);
    assert.equal(s.checks.busy, null, cut);
    assert.ok(s.logs.some((l) => /^warn check delay failed \w+$/.test(l)), cut);
  }
});

test("measureDelay: a generation that ends under the recorder is the same restart", async () => {
  const s = setup();
  const before = nodes.length;
  const p = s.checks.measureDelay();
  p.catch(() => {});
  const node = await nextNode("ac-recorder", before);
  await answerDelay(node, delaySignals(), { chunks: 10 });
  await s.graph.rebuild({ backAtMs: clock.now + 500 });
  await assert.rejects(p, { message: CHECK_TEXTS.restarted });
  assert.equal(s.graph.taps.size, 0, "a once-tap does not come back after the rebuild");
});

test("measureDelay on the audio element route: its own context on CABLE Input, no micBus, and the run says so", async () => {
  const s = setup({ method: "element", routePreference: "element" });
  const before = nodes.length;
  const p = s.checks.measureDelay();
  const node = await nextNode("ac-recorder", before);
  assert.notEqual(node.context, s.graph.ctx);
  assert.equal(node.context.sinkId, "cable-in");
  assert.equal(s.graph.micBus.links.length, 0, "micBus is not reachable there");
  assert.equal(s.graph.taps.size, 0, "no tap on the graph");
  await answerDelay(node, delaySignals());
  const r = await p;
  assert.equal(r.site, "own-context");
  assert.equal(r.micFifoMs, null);
  assert.equal(r.micFifoScore, null);
  assert.equal(r.ok, true);
  assert.equal(node.context.state, "closed", "its own context is closed");
  // Gate 1's delay row lists a run forced onto the audio element beside the others and does not count it.
  assert.equal(r.route, "element");
  assert.equal(r.routePreference, "element");
});

test("measureDelay on the element route when CABLE Input refuses its own context: the graph's context and a note", async () => {
  const s = setup({ method: "element", routePreference: "element" });
  env.sinkFails = true;
  const before = nodes.length;
  const p = s.checks.measureDelay();
  const node = await nextNode("ac-recorder", before);
  assert.equal(node.context, s.graph.ctx);
  assert.equal(s.graph.micBus.links.length, 0, "input 2 stays unconnected on the element route");
  await answerDelay(node, delaySignals());
  const r = await p;
  assert.equal(r.site, "graph");
  assert.equal(r.micFifoMs, null);
  assert.deepEqual(r.notes, [CHECK_TEXTS.ownCrossing]);
});

test("captureLatencyMs: track.stats is in ms (its average first), getSettings().latency in seconds", () => {
  // Chromium's MediaStreamTrackAudioStats gives DOMHighResTimeStamps: milliseconds.
  assert.equal(captureLatencyMs(fakeTrack({ stats: { latency: 12.5 }, latency: 0.01 })), 12.5);
  assert.equal(captureLatencyMs(fakeTrack({ stats: { latency: 0.2 }, latency: 0.01 })), 0.2);
  assert.equal(captureLatencyMs(fakeTrack({ stats: { averageLatency: 14.24, latency: 30 }, latency: 0.01 })), 14.2);
  assert.equal(captureLatencyMs(fakeTrack({ stats: { averageLatency: Number.NaN, latency: 21 } })), 21);
  // A track made by an audio context (the fake VB-CABLE loop) reports a few ms.
  assert.equal(captureLatencyMs(fakeTrack({ stats: { averageLatency: 8.001, latency: 8.001 } })), 8);
  // Above a second it is not a capture latency; 0 means no frames yet. Then the settings, in seconds.
  assert.equal(captureLatencyMs(fakeTrack({ stats: { averageLatency: 1500, latency: 1200 }, latency: 0.01 })), 10);
  assert.equal(captureLatencyMs(fakeTrack({ stats: { averageLatency: 0, latency: 0 }, latency: 0.02 })), 20);
  assert.equal(captureLatencyMs(fakeTrack({ stats: null, latency: 0.02 })), 20);
  assert.equal(captureLatencyMs(fakeTrack({ latency: 2 })), null, "2 s from the settings is not a capture latency either");
  assert.equal(captureLatencyMs(fakeTrack({ latency: null })), null);
  const throwing = fakeTrack({ latency: 0.01 });
  Object.defineProperty(throwing, "stats", { get: () => {
    throw new Error("no stats");
  } });
  assert.equal(captureLatencyMs(throwing), 10);
  assert.equal(captureLatencyMs(null), null);
});

test("measureDelay adds the microphone's own capture latency from its stats, in ms", async () => {
  const s = setup({ micTrack: fakeTrack({ stats: { averageLatency: 12.5, latency: 13 }, latency: 0.01 }) });
  env.cableStats = { averageLatency: 8.001, latency: 8.001 };
  const before = nodes.length;
  const p = s.checks.measureDelay();
  const node = await nextNode("ac-recorder", before);
  await answerDelay(node, delaySignals({ sigMs: 30 }));
  const r = await p;
  assert.equal(r.captureLatencyMs, 12.5);
  assert.equal(r.estimateMs, Math.round((r.passthroughMs + 12.5 + 10) * 10) / 10);
  assert.ok(r.estimateMs < 60, String(r.estimateMs));
  assert.equal(r.verdict, "good");
  assert.equal(r.cableCaptureLatencyMs, 8);
});

// ---------------------------------------------------------------- the long check

test("long tone check: the tone on the cable, a watcher at the graph, done ends it and cleans up", async () => {
  const s = setup();
  const { handle, node, progress, start } = await startTone(s, 0.5);
  assert.deepEqual(s.graph.testSourceCalls, ["on"]);
  assert.equal(node.context, s.graph.ctx);
  assert.equal(node.options.numberOfInputs, 2);
  assert.equal(node.options.numberOfOutputs, 0);
  assert.deepEqual(node.options.processorOptions, { mode: "tone", stopAfterFrames: 1440000, summaryFrames: 48000 });
  assert.ok(s.graph.micBus.links.some(([t, i]) => t === node && i === 0));
  assert.ok(s.graph.ctx.sources.some((n) => n.links.some(([t, i]) => t === node && i === 1)));
  assert.ok(s.logs.includes("info check long start tone 0.5 min context graph"));
  seconds(node, start, 1, 30);
  node.port.emit({ type: "done", frame: 1440000 });
  const r = await handle.done;
  assert.equal(s.checks.busy, null);
  assert.equal(r.verdict, "pass", JSON.stringify(r.reasons));
  assert.equal(r.recordedSec, 30);
  assert.equal(r.phases.visibleSec, 30);
  assert.equal(r.mode, "tone");
  assert.equal(r.minutesAsked, 0.5);
  assert.equal(r.extendedToSec, null);
  assert.deepEqual(r.tone.counts, ZERO_COUNTS);
  assert.equal(r.tone.lockDb, -12);
  assert.equal(r.tone.levelDb, -12);
  assert.deepEqual(r.outages, []);
  assert.deepEqual(r.renderPauses, []);
  assert.equal(r.site, "graph");
  assert.equal(r.route, "context");
  assert.deepEqual(s.graph.testSourceCalls, ["on", "off"]);
  assert.equal(s.monitor.tones[0].stopped, true);
  assert.equal(s.graph.taps.size, 0);
  assert.equal(cableTracks[cableTracks.length - 1].readyState, "ended");
  assert.equal(progress.length, 30);
  assert.deepEqual(Object.keys(progress[0]).sort(), ["dropouts", "elapsedSec", "extendedToSec", "gaps", "levelDb", "locked", "mode", "phase", "phasesSoFar", "ticks", "totalSec"].sort());
  assert.equal(progress[29].elapsedSec, 30);
  assert.equal(progress[29].totalSec, 30);
  assert.equal(progress[29].phase, "visible");
  assert.ok(s.logs.some((l) => /^info check long done pass 30 s outages 0 pauses 0$/.test(l)), s.logs.join("\n"));
});

test("stop(): the watcher is asked to stop and its last summary counts", async () => {
  const s = setup();
  const { handle, node, start } = await startTone(s, 10);
  seconds(node, start, 1, 5);
  const p = handle.stop();
  await flush();
  assert.ok(node.port.sent.includes("stop"));
  summary(node, { frame: 5.5 * 48000, at: start + 5500, final: true, counts: { gaps: 1 }, events: [{ kind: "gap", atFrame: 5 * 48000, frames: 9600, holeMs: 200 }] });
  node.port.emit({ type: "done", frame: 5.5 * 48000 });
  const r = await p;
  assert.equal(r.recordedSec, 5.5);
  assert.equal(r.tone.counts.gaps, 1);
  assert.equal(r.verdict, "fail");
  assert.deepEqual(r.tone.events, [{ atSec: 5, phase: "visible", kind: "gap", ms: 200 }]);
  assert.equal(await handle.done, r);
});

test("a rebuild: a new segment continues the timeline, the outage counts once, no rendering pause", async () => {
  const s = setup();
  const { handle, node, start } = await startTone(s, 1);
  seconds(node, start, 1, 10);
  clock.now = start + 10_400;
  await s.graph.rebuild({ cause: "render-error", backAtMs: start + 11_900 });
  const node2 = newest("ac-cablewatch");
  assert.notEqual(node2, node);
  assert.equal(node2.context, s.graph.ctx);
  // Built about 11.9 s in: the rest of the minute.
  assert.ok(Math.abs(node2.options.processorOptions.stopAfterFrames - (60 - 11.9) * 48000) < 4800, String(node2.options.processorOptions.stopAfterFrames));
  // Its first frame was rendered 12.0 s in (a little after the build): the first summary corrects the stop.
  const seg2 = start + 12_000;
  summary(node2, { frame: 48000, at: seg2 + 1000 });
  const extend = node2.port.sent.find((m) => m?.type === "extend");
  assert.deepEqual(extend, { type: "extend", stopAfterFrames: (60 - 12) * 48000 });
  for (let k = 2; k <= 48; k++) summary(node2, { frame: k * 48000, at: seg2 + k * 1000 });
  node2.port.emit({ type: "done", frame: 48 * 48000 });
  const r = await handle.done;
  assert.equal(r.recordedSec, 60);
  assert.equal(r.recoveries, 1);
  assert.deepEqual(r.outages, [{ atSec: 10.4, phase: "visible", ms: 1500, cause: "render-error" }]);
  assert.deepEqual(r.renderPauses, []);
  assert.equal(r.verdict, "fail");
  assert.ok(r.reasons.some((x) => /stopped once/.test(x)) && r.reasons.some((x) => /back once/.test(x)), JSON.stringify(r.reasons));
  assert.equal(s.graph.taps.size, 0);
});

test("rendering pauses: one the frames show is an outage; one inside a recovery is that recovery; late messages are not", async () => {
  // Frames stop for 800 ms while time goes on.
  let s = setup();
  let t = await startTone(s, 0.5);
  seconds(t.node, t.start, 1, 10);
  seconds(t.node, t.start + 800, 11, 30);
  t.node.port.emit({ type: "done", frame: 30 * 48000 });
  let r = await t.handle.done;
  assert.equal(r.renderPauses.length, 1, JSON.stringify(r.renderPauses));
  assert.ok(Math.abs(r.renderPauses[0].ms - 800) <= 1 && r.renderPauses[0].atSec === 10, JSON.stringify(r.renderPauses));
  assert.deepEqual(r.outages, []);
  assert.equal(r.verdict, "fail");
  assert.ok(r.reasons.some((x) => /stopped once/.test(x)));

  // The same pause while the graph reports a suspension it recovered from: counted once, as the outage.
  s = setup();
  t = await startTone(s, 0.5);
  seconds(t.node, t.start, 1, 10);
  clock.now = t.start + 10_100;
  s.graph.lost("context-suspended");
  s.graph.back("context-suspended", t.start + 10_100, 900);
  seconds(t.node, t.start + 800, 11, 30);
  t.node.port.emit({ type: "done", frame: 30 * 48000 });
  r = await t.handle.done;
  assert.deepEqual(r.renderPauses, []);
  assert.equal(r.outages.length, 1);
  assert.equal(r.outages[0].cause, "context-suspended");

  // Messages made on time but delivered 3 s late (a busy main thread): no pause, one slow-window line.
  s = setup();
  t = await startTone(s, 0.5);
  seconds(t.node, t.start, 1, 30, (k) => (k === 12 ? { arrive: t.start + k * 1000 + 3000 } : {}));
  t.node.port.emit({ type: "done", frame: 30 * 48000 });
  r = await t.handle.done;
  assert.deepEqual(r.renderPauses, []);
  assert.deepEqual(r.mainThreadLate, { count: 1, maxMs: 3000 });
  assert.equal(r.verdict, "pass", JSON.stringify(r.reasons));
  assert.ok(r.lines.some((l) => /slow to update once/.test(l)));
});

test("hideFor during a long check: the hidden phase, the end moved to 2 minutes after the window is back", async () => {
  const s = setup();
  s.platform.hideMs = 5000;
  const { handle, node, start, progress } = await startTone(s, 0.25);
  seconds(node, start, 1, 3);
  const h = await s.checks.hideFor(30);
  assert.equal(h.minutes, 30);
  assert.equal(Date.parse(h.showAt) - Date.parse(h.at), 5000);
  const endSec = stopAfterHide({ plannedEndSec: 15, hideEndSec: 8, maxEndSec: 15 + LIMITS.EXTEND_MAX_SEC });
  assert.equal(endSec, 128);
  const extend = node.port.sent.find((m) => m?.type === "extend");
  assert.deepEqual(extend, { type: "extend", stopAfterFrames: 128 * 48000 });
  assert.equal(handle.extendedToSec, 128);
  assert.equal(Date.parse(h.longEndsAt), EPOCH + start + 128_000);
  assert.equal(Date.parse(handle.endsAt), EPOCH + start + 128_000);
  // A second, shorter Hide never brings the end forward.
  s.platform.hideMs = 1000;
  await s.checks.hideFor(1);
  assert.equal(node.port.sent.filter((m) => m?.type === "extend").length, 1);
  seconds(node, start, 4, 12);
  const p = handle.stop();
  await flush();
  node.port.emit({ type: "done", frame: 12 * 48000 });
  const r = await p;
  assert.equal(r.extendedToSec, 128);
  assert.ok(r.phases.hiddenSec >= 4.9 && r.phases.hiddenSec <= 5.3, JSON.stringify(r.phases));
  assert.ok(progress.some((x) => x.phase === "hidden"));
  assert.equal(progress[progress.length - 1].totalSec, 128);
  assert.ok(s.logs.includes("info check long extended to 128 s"));
  assert.ok(s.logs.some((l) => l === "info check long phase hidden"), s.logs.join("\n"));
});

test("hideFor without a check: only the hide; the platform's refusal reaches the page", async () => {
  const s = setup();
  const h = await s.checks.hideFor(30);
  assert.equal(h.longEndsAt, null);
  assert.equal(Date.parse(h.showAt) - Date.parse(h.at), 30 * 60000);
  s.platform.hideWindowFor = async () => {
    throw new Error("Hiding the window works only in the installed app. In Edge, minimize the window instead.");
  };
  await assert.rejects(s.checks.hideFor(30), /works only in the installed app/);
  assert.ok(s.logs.includes("warn check hide failed Error"));
});

test("the minimized phase: the window's state is asked for every 5th summary", async () => {
  // The page itself cannot tell a minimized window from a hidden one; only the platform's window state can,
  // and Gate 1 needs 25 minutes minimized.
  const s = setup();
  const { handle, node, start, progress } = await startTone(s, 0.5);
  const asked = [];
  s.platform.windowState = async () => {
    asked.push(clock.now - start);
    return { visible: true, minimized: clock.now >= start + 5000 && clock.now < start + 20_000, focused: false };
  };
  for (let k = 1; k <= 30; k++) {
    summary(node, { frame: k * 48000, at: start + k * 1000 });
    await flush(1); // the answer arrives before the next summary
  }
  node.port.emit({ type: "done", frame: 30 * 48000 });
  const r = await handle.done;
  assert.deepEqual(asked, [5000, 10_000, 15_000, 20_000, 25_000, 30_000]);
  assert.deepEqual(r.phases, { visibleSec: 15, minimizedSec: 15, hiddenSec: 0, unknownSec: 0 });
  assert.equal(r.lines[0], "30 s recorded: 15 s minimized, 0 s hidden, 15 s open.");
  assert.deepEqual(progress.map((p) => p.phase).filter((p, i, all) => p !== all[i - 1]), ["visible", "minimized", "visible"]);
  assert.equal(progress[progress.length - 1].phasesSoFar.minimizedSec, 15);
  assert.ok(s.logs.includes("info check long phase minimized"), s.logs.join("\n"));
});

test("the microphone's buffer: a 1 s reading at summary 2 and every 120 after, through a once-tap at the graph", async () => {
  const s = setup();
  const { handle, node, start } = await startTone(s, 10);
  summary(node, { frame: 48000, at: start + 1000 });
  const before = nodes.filter((n) => n.name === "ac-recorder").length;
  summary(node, { frame: 96000, at: start + 2000 });
  await flush();
  const rec = newest("ac-recorder");
  assert.equal(nodes.filter((n) => n.name === "ac-recorder").length, before + 1);
  assert.equal(rec.context, s.graph.ctx);
  assert.equal(rec.options.numberOfInputs, 2);
  assert.ok(s.graph.micBus.links.some(([t, i]) => t === rec && i === 1));
  await answerReading(rec, 720);
  seconds(node, start, 3, 121);
  assert.equal(nodes.filter((n) => n.name === "ac-recorder").length, before + 1, "nothing between");
  summary(node, { frame: 122 * 48000, at: start + 122_000 });
  await flush();
  const rec2 = newest("ac-recorder");
  assert.notEqual(rec2, rec);
  s.graph.micGen++; // the microphone source changed during this reading: skipped
  await answerReading(rec2, 960);
  seconds(node, start, 123, 242);
  await flush();
  const rec3 = newest("ac-recorder");
  assert.notEqual(rec3, rec2);
  await answerReading(rec3, 1440);
  node.port.emit({ type: "done", frame: 242 * 48000 });
  const r = await handle.done;
  // Two readings were taken (the one during the source change was skipped); micClock uses the run of one
  // microphone source, so the readings before the change are not compared with those after it.
  assert.equal(r.micPath.readingsTaken, 2);
  assert.deepEqual(r.micPath.readings, [{ atSec: 242, lagMs: 30 }]);
  assert.equal(s.graph.taps.size, 0);
});

test("the microphone's buffer: the tone check gives micBus a new source once the tone feeds the cable, before its first reading", async () => {
  // The source made at the start (or the last rebuild) may hold a buffer that filled long before the check (H1):
  // the check's readings must start from an empty one.
  const s = setup();
  const gen0 = s.graph.micGen;
  const { handle, node, start } = await startTone(s, 10);
  assert.deepEqual(s.graph.testSourceCalls, ["on"]);
  assert.deepEqual(s.graph.renewCalls, [true], "renewed once, while the tone fed the cable");
  assert.equal(s.graph.micGen, gen0 + 1);
  summary(node, { frame: 48000, at: start + 1000 });
  summary(node, { frame: 96000, at: start + 2000 });
  await flush();
  await answerReading(newest("ac-recorder"), 480);
  node.port.emit({ type: "done", frame: 2 * 48000 });
  const r = await handle.done;
  assert.equal(r.micPath.renewed, true);
  assert.equal(r.micPath.fullAtStart, false);
  assert.deepEqual(r.micPath.readings, [{ atSec: 2, lagMs: 10 }]);
  assert.equal(s.graph.micGen, gen0 + 1, "no other source change");
});

test("the microphone's buffer: no new source in mic mode (the meeting hears the microphone) or on the element route", async () => {
  let s = setup();
  let handle = await s.checks.startLong({ mode: "mic", minutes: 1 });
  let p = handle.stop();
  await flush();
  newest("ac-cablewatch").port.emit({ type: "done", frame: 48000 });
  let r = await p;
  assert.deepEqual(s.graph.renewCalls, []);
  assert.equal(r.micPath.renewed, false);
  s = setup({ method: "element", routePreference: "element" });
  handle = await s.checks.startLong({ mode: "tone", minutes: 1 });
  p = handle.stop();
  await flush();
  newest("ac-cablewatch").port.emit({ type: "done", frame: 48000 });
  r = await p;
  assert.deepEqual(s.graph.renewCalls, [], "its own context has no micBus");
  assert.equal(r.micPath, null);
});

test("the microphone's buffer: a check with more than 40 readings keeps 40 in its result, the first and the last among them", async () => {
  // 41 readings: at 2 s and then every 120 s up to 4802 s (an 81-minute check). The buffer fills by 1 ms a reading.
  const s = setup();
  const { handle, node, start } = await startTone(s, 81);
  let taken = 0;
  for (let k = 1; k <= 4802; k++) {
    summary(node, { frame: k * 48000, at: start + k * 1000 });
    if (k === 2 || (k > 2 && (k - 2) % 120 === 0)) {
      await flush();
      await answerReading(newest("ac-recorder"), 480 + 48 * taken);
      taken++;
    }
  }
  node.port.emit({ type: "done", frame: 4802 * 48000 });
  const r = await handle.done;
  assert.equal(taken, 41);
  assert.equal(r.micPath.readingsTaken, 41);
  const kept = r.micPath.readings;
  assert.equal(kept.length, 40);
  assert.deepEqual(kept[0], { atSec: 2, lagMs: 10 });
  assert.deepEqual(kept[39], { atSec: 4802, lagMs: 50 });
  assert.ok(kept.every((x, i) => i === 0 || x.atSec > kept[i - 1].atSec), "in order, none twice");
});

test("the microphone's holes: 8–11 ms runs after a watcher's first 10 s count; not around an outage or a new source", async () => {
  const s = setup();
  const { handle, node, start } = await startTone(s, 10);
  const hole = (sec) => ({ startFrame: Math.round(sec * 48000), frames: 480 });
  seconds(node, start, 1, 60, (k) => {
    const runs = [];
    if (k === 5) runs.push(hole(4.2)); // in the watcher's first 10 s: its sources settling
    if (k === 20) runs.push(hole(19.5)); // counts
    if (k === 21) runs.push({ startFrame: 20.5 * 48000, frames: 300 }); // 6 ms: not a hole
    if (k === 31) runs.push(hole(30.5)); // within 2 s after the outage below
    if (k === 46) runs.push(hole(45.5)); // after the microphone source changed at 45 s
    if (k === 59) runs.push(hole(58.5)); // counts
    if (k === 45) s.graph.micGen++;
    return { refRuns: runs };
  });
  // An outage from 29.9 to 30.0 s, recovered without a rebuild.
  s.graph.lost("context-suspended", start + 29_900);
  s.graph.back("context-suspended", start + 29_900, 100);
  node.port.emit({ type: "done", frame: 60 * 48000 });
  const r = await handle.done;
  assert.equal(r.micPath.holes, 2, JSON.stringify(r.micPath));
  assert.equal(r.micPath.holesPer30Min, 60);
});

test("the microphone's holes behind a noise gate: the ones seen still count, as a lower bound", async () => {
  // Tone mode, 2 minutes. A noise gate: 30 silences of 0.4 s (10 % of the check). A slower clock's 10 ms holes
  // that fall into them are not seen; 3 fall into the sound, at 45.5, 60.5 and 75.5 s: 45 per 30 minutes at least.
  const s = setup();
  const { handle, node, start } = await startTone(s, 2);
  const gateRun = (k) => ({ startFrame: Math.round((k - 0.7) * 48000), frames: 0.4 * 48000 });
  const hole = (sec) => ({ startFrame: Math.round(sec * 48000), frames: 480 });
  seconds(node, start, 1, 120, (k) => ({
    refRuns: [...(k > 10 && k <= 40 ? [gateRun(k)] : []), ...([46, 61, 76].includes(k) ? [hole(k - 0.5)] : [])],
    refZeroFrames: Math.min(30, Math.max(0, k - 10)) * 0.4 * 48000 + [46, 61, 76].filter((h) => k >= h).length * 480,
  }));
  node.port.emit({ type: "done", frame: 120 * 48000 });
  const r = await handle.done;
  assert.equal(r.micPath.noiseGate, true, JSON.stringify(r.micPath));
  assert.equal(r.micPath.holes, 3);
  assert.equal(r.verdict, "fail", JSON.stringify(r.lines));
  assert.deepEqual(r.reasons, ["Too many clicks from your microphone's side: at least 45.0 per 30 minutes (6 at most)."]);
  assert.ok(r.lines.some((l) => l.startsWith("Your microphone sends digital silence in pauses")), r.lines.join(" | "));
});

test("the microphone's drop-outs: 20–99 ms runs after a watcher's first 10 s fail the check; not around an outage or a new source", async () => {
  const s = setup();
  const { handle, node, start } = await startTone(s, 10);
  const run = (sec, ms) => ({ startFrame: Math.round(sec * 48000), frames: ms * 48 });
  seconds(node, start, 1, 60, (k) => {
    const runs = [];
    if (k === 5) runs.push(run(4.2, 30)); // in the watcher's first 10 s: its sources settling
    if (k === 20) runs.push(run(19.5, 40)); // counts
    if (k === 21) runs.push(run(20.5, 19)); // under 20 ms: not a drop-out
    if (k === 31) runs.push(run(30.5, 50)); // within 2 s after the outage below
    if (k === 46) runs.push(run(45.5, 30)); // after the microphone source changed at 45 s
    if (k === 59) runs.push(run(58.5, 99)); // counts
    if (k === 45) s.graph.micGen++;
    return { refRuns: runs };
  });
  // An outage from 29.9 to 30.0 s, recovered without a rebuild.
  s.graph.lost("context-suspended", start + 29_900);
  s.graph.back("context-suspended", start + 29_900, 100);
  node.port.emit({ type: "done", frame: 60 * 48000 });
  const r = await handle.done;
  assert.equal(r.micDropouts.count, 2, JSON.stringify(r.micDropouts));
  assert.equal(r.micDropouts.longestMs, 99);
  assert.deepEqual(
    r.micDropouts.runs.map((x) => [x.atSec, x.ms]),
    [
      [19.5, 40],
      [58.5, 99],
    ],
  );
  assert.equal(r.verdict, "fail");
  const reason = r.reasons.find((x) => x.startsWith("The microphone itself dropped out"));
  assert.ok(reason?.startsWith("The microphone itself dropped out twice for 20 to 100 ms (the longest 99 ms at 0:58"), JSON.stringify(r.reasons));
  assert.equal(r.micPath.holes, 0, "a drop-out is not a 10 ms hole");

  // Mic mode: a 50 ms drop-out that CABLE Output repeats 40 ms later is the microphone's, and fails the check.
  const m = setup();
  const handle2 = await m.checks.startLong({ mode: "mic", minutes: 1 });
  const node2 = newest("ac-cablewatch");
  const start2 = clock.now;
  for (let k = 1; k <= 60; k++) {
    const at = 30.25 * 48000;
    summary(node2, {
      mode: "mic",
      frame: k * 48000,
      at: start2 + k * 1000,
      refRuns: k === 31 ? [{ startFrame: at, frames: 2400 }] : [],
      sigRuns: k === 31 ? [{ startFrame: at + 40 * 48, frames: 2400 }] : [],
    });
  }
  node2.port.emit({ type: "done", frame: 60 * 48000 });
  const r2 = await handle2.done;
  assert.deepEqual(r2.speech.dropouts, [], "CABLE Output's own: none");
  assert.equal(r2.micDropouts.count, 1);
  assert.equal(r2.verdict, "fail");
  assert.ok(r2.reasons.some((x) => x.startsWith("The microphone itself dropped out once for 20 to 100 ms (the longest 50 ms at 0:30")), JSON.stringify(r2.reasons));
});

test("priming: runs in a watcher's first 100 ms that last less than 100 ms are its sources starting; longer ones count", async () => {
  // Mic mode, where it matters: a new source node's buffer starts empty, so CABLE Output starts every watcher
  // with a short silence at its frame 0 (20–31 ms in headless Chromium on the fake VB-CABLE loop), and no
  // microphone run explains it. Counted, it would fail every check as a drop-out.
  let s = setup();
  let handle = await s.checks.startLong({ mode: "mic", minutes: 1 });
  let node = newest("ac-cablewatch");
  let start = clock.now;
  summary(node, {
    mode: "mic",
    frame: 48000,
    at: start + 1000,
    refRuns: [{ startFrame: 0, frames: 700 }, { startFrame: 100, frames: 6000 }],
    sigRuns: [{ startFrame: 0, frames: 1440 }],
  });
  node.port.emit({ type: "done", frame: 48000 });
  let r = await handle.done;
  assert.deepEqual(r.speech.dropouts, [], "CABLE Output's 30 ms at frame 0 is not a drop-out");
  assert.equal(r.speech.micHoles, 1, "nor is the microphone's 15 ms at frame 0 one of its short runs");
  // The 125 ms run is kept: the microphone itself sent only digital silence.
  assert.equal(r.verdict, "fail");
  assert.deepEqual(r.reasons, [
    "Your microphone sent only digital silence once (the longest for 125 ms at 0:00 while open): it was muted, or Windows paused it.",
  ]);

  // Tone mode keeps the same 125 ms run.
  s = setup();
  ({ handle, node, start } = await startTone(s, 1));
  summary(node, { frame: 48000, at: start + 1000, refRuns: [{ startFrame: 0, frames: 700 }, { startFrame: 100, frames: 6000 }] });
  node.port.emit({ type: "done", frame: 48000 });
  r = await handle.done;
  assert.equal(r.verdict, "fail");
  assert.ok(r.reasons.some((x) => x.startsWith("Your microphone sent only digital silence once")), JSON.stringify(r.reasons));
});

test("the microphone's silences: one long one fails however long; a noise gate's many short ones are not judged; the result says which", async () => {
  // Tone mode, 2 minutes: the microphone sends only digital silence from 0:30 to 1:30, half the check in one run.
  let s = setup();
  let { handle, node, start } = await startTone(s, 2);
  const long = { startFrame: 30 * 48000, frames: 60 * 48000 };
  seconds(node, start, 1, 120, (k) => ({ refRuns: k === 91 ? [long] : [], refZeroFrames: k >= 91 ? long.frames : 0 }));
  node.port.emit({ type: "done", frame: 120 * 48000 });
  let r = await handle.done;
  assert.equal(r.verdict, "fail");
  assert.deepEqual(r.reasons, [
    "Your microphone sent only digital silence once (the longest for 60.0 s at 0:30 while open): it was muted, or Windows paused it.",
  ]);
  assert.deepEqual(r.micSilence, { checked: true, gate: false, zeroFraction: 0.5, count: 1, longest: [{ atSec: 30, phase: "visible", ms: 60000 }] });
  assert.equal(r.micPath.noiseGate, false);

  // A noise gate: 30 short silences of 0.4 s, 10 % of the check. The check cannot judge them, and says so.
  s = setup();
  ({ handle, node, start } = await startTone(s, 2));
  const gateRun = (k) => ({ startFrame: Math.round((k - 0.7) * 48000), frames: 0.4 * 48000 });
  seconds(node, start, 1, 120, (k) => ({
    refRuns: k > 10 && k <= 40 ? [gateRun(k)] : [],
    refZeroFrames: Math.min(30, Math.max(0, k - 10)) * 0.4 * 48000,
  }));
  node.port.emit({ type: "done", frame: 120 * 48000 });
  r = await handle.done;
  assert.equal(r.verdict, "pass", JSON.stringify(r.reasons));
  assert.equal(r.micSilence.gate, true);
  assert.equal(r.micSilence.checked, false);
  assert.equal(r.micSilence.zeroFraction, 0.1);
  assert.equal(r.micSilence.count, 30);
  assert.equal(r.micSilence.longest.length, 20, "the 20 longest");
  assert.equal(r.micPath.noiseGate, true, "the clicks row reads the same decision");
  assert.ok(r.lines.some((l) => l.startsWith("Your microphone sends digital silence in pauses")), r.lines.join(" | "));
});

test("tone events around an outage are the outage's own: left out of the counts; level changes always count", async () => {
  const s = setup();
  const { handle, node, start } = await startTone(s, 1);
  const ev = (kind, sec, more = {}) => ({ kind, atFrame: Math.round(sec * 48000), frames: 480, ...more });
  // The outage below runs from 20.0 to 20.3 s, so from 19.0 to 22.3 s is its own. The volume drops at 20.6 s.
  seconds(node, start, 1, 60, (k) => {
    if (k === 20) return { events: [ev("click", 19.6)], counts: { clicks: 1 } };
    if (k === 21) {
      return {
        events: [ev("hole", 20.4, { holeMs: 10 }), ev("level", 20.6, { fromDb: -12, toDb: -16 }), ev("skip", 20.7, { phaseStepDeg: 112.5 })],
        counts: { clicks: 1, holes: 1, skips: 1, levels: 1 },
      };
    }
    if (k > 21 && k < 41) return { counts: { clicks: 1, holes: 1, skips: 1, levels: 1 } };
    if (k === 41) return { events: [ev("hole", 40.5, { holeMs: 10 })], counts: { clicks: 1, holes: 2, skips: 1, levels: 1 } };
    if (k > 41) return { counts: { clicks: 1, holes: 2, skips: 1, levels: 1 } };
    return {};
  });
  s.graph.lost("render-error", start + 20_000);
  s.graph.back("render-error", start + 20_000, 300);
  node.port.emit({ type: "done", frame: 60 * 48000 });
  const r = await handle.done;
  assert.deepEqual(r.tone.counts, { ...ZERO_COUNTS, holes: 1, levels: 1 });
  assert.equal(r.tone.aroundOutages, 3);
  assert.deepEqual(r.tone.events.map((e) => e.kind), ["level", "hole"]);
  assert.deepEqual(r.tone.events[0], { atSec: 20.6, phase: "visible", kind: "level", db: -4, fromDb: -12, toDb: -16 });
  assert.deepEqual(r.tone.events[1], { atSec: 40.5, phase: "visible", kind: "hole", ms: 10 });
});

/** The watcher's answer to "stop": its last summary at `sec`, then done. */
async function answerStop(node, start, sec, extra = {}) {
  await whenSent(node, "stop");
  const frame = Math.round(sec * 48000);
  summary(node, { frame, at: start + sec * 1000, final: true, ...extra });
  node.port.emit({ type: "done", frame });
}

test("ending early for a reason nobody chose fails the check, with that reason first", async () => {
  // Four clean seconds of a 10-minute check, then the end comes from outside. Each must not pass.
  const cases = [
    ["tone-lost", CHECK_TEXTS.toneLost, (s) => s.monitor.loseTone()],
    ["cable-ended", CHECK_TEXTS.cableLost, () => cableTracks[cableTracks.length - 1].dispatchEvent(new Event("ended"))],
    ["voice-stopped", CHECK_TEXTS.voiceStopped, (s) => {
      s.graph.state = "stopped"; // the check's once-a-second timer notices
    }],
  ];
  for (const [why, text, cause] of cases) {
    const s = setup();
    const t = await startTone(s, 10);
    seconds(t.node, t.start, 1, 4);
    cause(s);
    await answerStop(t.node, t.start, 4.4);
    const r = await t.handle.done;
    assert.equal(r.verdict, "fail", why);
    assert.deepEqual(r.reasons, [text], why);
    assert.deepEqual(r.endedEarly, { why, note: text }, why);
    assert.equal(r.recordedSec, 4.4, why);
    assert.equal(r.minutesAsked, 10, why);
    assert.ok(!r.notes.includes(text), `${why}: the reason is not repeated in the notes`);
    assert.ok(s.logs.includes(`warn check long ended early ${why}`), why);
    assert.ok(s.logs.includes("info check long done fail 4 s outages 0 pauses 0"), `${why}: ${s.logs.join("\n")}`);
    assert.equal(s.checks.busy, null, why);
  }
});

test("ending early: the reason goes before what the check found; a check that found nothing stays no-signal", async () => {
  // A gap before the end: both reasons, the early end first.
  let s = setup();
  let t = await startTone(s, 10);
  seconds(t.node, t.start, 1, 4, (k) => (k === 3 ? { counts: { gaps: 1 }, events: [{ kind: "gap", atFrame: 2.5 * 48000, frames: 9600, holeMs: 200 }] } : k > 3 ? { counts: { gaps: 1 } } : {}));
  s.monitor.loseTone();
  await answerStop(t.node, t.start, 4.4, { counts: { gaps: 1 } });
  let r = await t.handle.done;
  assert.equal(r.verdict, "fail");
  assert.equal(r.reasons[0], CHECK_TEXTS.toneLost);
  assert.ok(r.reasons.slice(1).some((x) => /stopped once/.test(x)), JSON.stringify(r.reasons));

  // CABLE Output ended before the tone was ever found: it measured nothing, and the reason says why.
  s = setup();
  t = await startTone(s, 10);
  seconds(t.node, t.start, 1, 2, () => ({ locked: false }));
  cableTracks[cableTracks.length - 1].dispatchEvent(new Event("ended"));
  await answerStop(t.node, t.start, 2.3, { locked: false });
  r = await t.handle.done;
  assert.equal(r.verdict, "no-signal");
  assert.equal(r.reasons[0], CHECK_TEXTS.cableLost);
  assert.deepEqual(r.endedEarly, { why: "cable-ended", note: CHECK_TEXTS.cableLost });
  assert.ok(r.reasons.slice(1).some((x) => /never reached/.test(x)), JSON.stringify(r.reasons));
});

test("a check you stop yourself, or the page stops, is judged on what it recorded", async () => {
  let s = setup();
  let t = await startTone(s, 10);
  seconds(t.node, t.start, 1, 5);
  const p = t.handle.stop();
  await answerStop(t.node, t.start, 5.5);
  let r = await p;
  assert.equal(r.verdict, "pass", JSON.stringify(r.reasons));
  assert.deepEqual(r.reasons, []);
  assert.equal(r.endedEarly, null);
  assert.equal(r.recordedSec, 5.5);
  assert.ok(!s.logs.some((l) => /ended early/.test(l)), s.logs.join("\n"));

  // checks.stop() (the page going away) is a stop too.
  s = setup();
  t = await startTone(s, 10);
  seconds(t.node, t.start, 1, 5);
  const stopping = s.checks.stop();
  await answerStop(t.node, t.start, 5.5);
  await stopping;
  r = await t.handle.done;
  assert.equal(r.verdict, "pass", JSON.stringify(r.reasons));
  assert.equal(r.endedEarly, null);
});

test("ending early: no summaries after the planned end (the voice never came back), the 1 s timer ends it", async () => {
  const s = setup();
  const t = await startTone(s, 0.25);
  seconds(t.node, t.start, 1, 5);
  s.graph.lost("render-error", t.start + 5_500);
  clock.now = t.start + 15_000 + 31_000;
  // The watcher answers its stop with done only (the check waits up to 3 s for that).
  await whenSent(t.node, "stop");
  t.node.port.emit({ type: "done", frame: 5 * 48000 });
  const r = await Promise.race([t.handle.done, new Promise((res) => setTimeout(() => res(null), 6000).unref())]);
  assert.ok(r, "ended by the backstop");
  assert.equal(r.verdict, "fail");
  assert.equal(r.reasons[0], CHECK_TEXTS.notBack, JSON.stringify(r.reasons));
  assert.deepEqual(r.endedEarly, { why: "not-back", note: CHECK_TEXTS.notBack });
  assert.ok(r.reasons.some((x) => /stopped once/.test(x)), JSON.stringify(r.reasons));
  assert.equal(r.outages.length, 1);
  assert.equal(r.outages[0].notOver, true);
  assert.equal(s.checks.busy, null);
});

test("a watcher that cannot be built: startLong fails, and everything it began is undone", async () => {
  const s = setup();
  env.addModuleFails = true;
  await assert.rejects(s.checks.startLong({ mode: "tone", minutes: 1 }), { name: "AbortError" });
  assert.equal(s.checks.busy, null);
  assert.deepEqual(s.graph.testSourceCalls, ["on", "off"]);
  assert.equal(s.monitor.tones[0].stopped, true);
  assert.equal(cableTracks[cableTracks.length - 1].readyState, "ended");
  assert.equal(s.graph.taps.size, 0);
});

test("checks.stop(): a running long check ends with its result; a delay measurement is cut", async () => {
  const s = setup();
  const t = await startTone(s, 10);
  seconds(t.node, t.start, 1, 3);
  const stopping = s.checks.stop();
  await flush();
  t.node.port.emit({ type: "done", frame: 3 * 48000 });
  await stopping;
  const r = await t.handle.done;
  assert.equal(r.recordedSec, 3);
  assert.equal(s.checks.busy, null);

  const before = nodes.length;
  const p = s.checks.measureDelay();
  p.catch(() => {});
  await nextNode("ac-recorder", before);
  await s.checks.stop();
  await assert.rejects(p, { name: "AbortError" });
  assert.equal(s.checks.busy, null);
});

// A worklet that is never told to stop goes on running in its context (its process() returns true until
// "stop"), however long the context lives: the voice's own context, on the context route.
test("a recorder cut short in a context that lives on is told to stop, and disconnected", async () => {
  const cuts = {
    outage: (s) => s.graph.lost("context-suspended"),
    cable: () => cableTracks[cableTracks.length - 1].dispatchEvent(new Event("ended")),
    page: (s) => s.checks.stop(),
  };
  for (const [name, cut] of Object.entries(cuts)) {
    const s = setup();
    const before = nodes.length;
    const p = s.checks.measureDelay();
    p.catch(() => {});
    const node = await nextNode("ac-recorder", before);
    assert.equal(node.context, s.graph.ctx, name);
    await answerDelay(node, delaySignals(), { chunks: 20 });
    assert.deepEqual(node.port.sent, ["start"], `${name}: still recording`);
    cut(s);
    await assert.rejects(p, name);
    assert.deepEqual(node.port.sent, ["start", "stop"], name);
    assert.equal(node.port.onmessage, null, name);
    assert.equal(s.graph.micBus.links.filter(([t]) => t === node).length, 0, `${name}: micBus disconnected`);
    assert.equal(s.graph.ctx.sources.filter((n) => n.links.some(([t]) => t === node)).length, 0, `${name}: sources disconnected`);
  }
});

test("a reading of the microphone's buffer cut by the end of the check is told to stop", async () => {
  const s = setup();
  const t = await startTone(s, 10);
  seconds(t.node, t.start, 1, 2);
  await flush();
  const rec = newest("ac-recorder");
  assert.ok(rec, "the first reading started at the 2nd summary");
  assert.deepEqual(rec.port.sent, ["start"]);
  const p = t.handle.stop();
  await answerStop(t.node, t.start, 2.5);
  const r = await p;
  assert.deepEqual(rec.port.sent, ["start", "stop"]);
  assert.equal(s.graph.micBus.links.filter(([n]) => n === rec).length, 0);
  assert.equal(r.micPath.readingsTaken, 0);
});

test("a watcher whose wiring fails is told to stop; so is one whose generation ends before it is done", async () => {
  let s = setup();
  env.cableSourceFails = true;
  const before = nodes.length;
  await assert.rejects(s.checks.startLong({ mode: "tone", minutes: 1 }), { name: "InvalidStateError" });
  const orphan = nodes.slice(before).find((n) => n.name === "ac-cablewatch");
  assert.ok(orphan, "the node was made before the wiring failed");
  assert.deepEqual(orphan.port.sent, ["stop"]);
  assert.equal(orphan.port.onmessage, null);
  assert.equal(s.checks.busy, null);

  s = setup();
  const t = await startTone(s, 1);
  seconds(t.node, t.start, 1, 5);
  await s.graph.rebuild({ backAtMs: t.start + 6_000 });
  assert.ok(t.node.port.sent.includes("stop"), JSON.stringify(t.node.port.sent));
  assert.equal(s.graph.micBus.links.length, 1, "only the new watcher hangs on the new micBus");
  const node2 = newest("ac-cablewatch");
  assert.notEqual(node2, t.node);
  const p = t.handle.stop();
  await answerStop(node2, t.start + 6_000, 2);
  await p;
  assert.deepEqual(node2.port.sent.filter((m) => m === "stop"), ["stop"], "told once");
});

// ---------------------------------------------------------------- the route note

test("a check that starts on the audio element route and records in the graph's context notes one crossing only", async () => {
  const s = setup({ method: "element", routePreference: "element" });
  env.sinkFails = true; // its own context is refused CABLE Input
  const t = await startTone(s, 1);
  assert.equal(t.node.context, s.graph.ctx);
  seconds(t.node, t.start, 1, 3);
  const p = t.handle.stop();
  await answerStop(t.node, t.start, 3.5);
  const r = await p;
  assert.equal(r.site, "graph");
  assert.equal(r.route, "element");
  assert.equal(r.routePreference, "element", "Gate 1 lists a check forced onto the audio element, and does not count it");
  assert.deepEqual(r.notes, [CHECK_TEXTS.ownCrossing]);
});

test("a check that starts on the context route and is rebuilt on the audio element route says the route changed", async () => {
  const s = setup();
  const t = await startTone(s, 1);
  seconds(t.node, t.start, 1, 5);
  await s.graph.rebuild({ backAtMs: t.start + 6_000, method: "element" });
  const node2 = newest("ac-cablewatch");
  assert.notEqual(node2, t.node);
  const p = t.handle.stop();
  await answerStop(node2, t.start + 6_000, 2);
  const r = await p;
  assert.equal(r.route, "context", "the route the check began on");
  assert.equal(r.routePreference, "auto");
  assert.deepEqual(r.notes, [CHECK_TEXTS.routeChanged]);

  // A rebuild that stays on the context route says nothing.
  const s2 = setup();
  const t2 = await startTone(s2, 1);
  seconds(t2.node, t2.start, 1, 5);
  await s2.graph.rebuild({ backAtMs: t2.start + 6_000, method: "context-after-permission" });
  const n2 = newest("ac-cablewatch");
  const p2 = t2.handle.stop();
  await answerStop(n2, t2.start + 6_000, 2);
  assert.deepEqual((await p2).notes, []);
});

test("mic mode: the speech analysis of the envelopes, a CABLE Output drop-out where it was, Analysing first", async () => {
  const s = setup();
  const progress = [];
  const handle = await s.checks.startLong({ mode: "mic", minutes: 0.5, onProgress: (p) => progress.push(p) });
  const node = newest("ac-cablewatch");
  const start = clock.now;
  assert.deepEqual(s.graph.testSourceCalls, [], "no test tone in mic mode");
  assert.equal(node.options.processorOptions.mode, "mic");
  const x = addNoise(synthSpeech({ seconds: 30, seed: 9, leadSec: 0.3, tailSec: 0.3 }).samples, -60);
  const refDb = envelopeDb(x, 48000, { hopMs: 5, winMs: 10 }).db;
  const sigDb = envelopeDb(delayed(x, 1920), 48000, { hopMs: 5, winMs: 10 }).db; // 40 ms later
  let frame0 = 0;
  const envFor = (k) => {
    const n = k === 1 ? 199 : 200;
    const e = { frame0, ref: refDb.slice(frame0, frame0 + n), sig: sigDb.slice(frame0, frame0 + n), dropped: 0 };
    frame0 += n;
    return e;
  };
  for (let k = 1; k <= 30; k++) summary(node, { mode: "mic", frame: k * 48000, at: start + k * 1000, env: envFor(k), sigRuns: k === 12 ? [{ startFrame: 11.5 * 48000, frames: 14400 }] : [] });
  node.port.emit({ type: "done", frame: 30 * 48000 });
  const r = await handle.done;
  assert.equal(r.mode, "mic");
  assert.ok(Math.abs(r.speech.lagMs - 40) <= 5, String(r.speech.lagMs));
  assert.ok(r.speech.speechSec > 5);
  assert.equal(r.speech.dropouts.length, 1);
  assert.equal(r.speech.dropouts[0].ms, 300);
  assert.equal(r.speech.dropouts[0].atSec, 11.5);
  assert.equal(r.verdict, "fail");
  const a = progress.find((p) => p.analysing);
  assert.ok(a && a.text === CHECK_TEXTS.analysing(1) && a.analysingSec === 1, JSON.stringify(a));
  assert.equal(progress[progress.length - 1], a, "Analysing is the last progress");
});

test("mic mode across a rebuild: the new watcher's envelopes go after the outage, the outage reads as silence, CABLE Output's runs around it are its own", async () => {
  const s = setup();
  const handle = await s.checks.startLong({ mode: "mic", minutes: 0.5 });
  let node = newest("ac-cablewatch");
  const start = clock.now;
  const x = addNoise(synthSpeech({ seconds: 31, seed: 9, leadSec: 0.3, tailSec: 0.3 }).samples, -60);
  const refDb = envelopeDb(x, 48000, { hopMs: 5, winMs: 10 }).db;
  const sigDb = envelopeDb(delayed(x, 1920), 48000, { hopMs: 5, winMs: 10 }).db; // 40 ms later
  // 300 ms of speech that never reached CABLE Output, at 26.8 s: after the rebuild.
  const hole = Math.round(26.8 * 200) + 8;
  sigDb.fill(-120, hole, hole + 60);
  /** The envelopes of a watcher whose frame 0 is `fromSec` into the check: one summary's worth a call. */
  const envelopes = (fromSec) => {
    let f0 = 0;
    return () => {
      const n = f0 === 0 ? 199 : 200;
      const at = fromSec * 200 + f0;
      const e = { frame0: f0, ref: refDb.slice(at, at + n), sig: sigDb.slice(at, at + n), dropped: 0 };
      f0 += n;
      return e;
    };
  };
  const first = envelopes(0);
  for (let k = 1; k <= 10; k++) summary(node, { mode: "mic", frame: k * 48000, at: start + k * 1000, env: first() });
  // The voice is lost at 10.2 s and back at 12.0 s: the new watcher's frame 0 is 12 s into the check.
  clock.now = start + 10_200;
  await s.graph.rebuild({ backAtMs: start + 12_000 });
  node = newest("ac-cablewatch");
  const second = envelopes(12);
  // Two 10 ms holes on CABLE Output, both in pauses of the speech: at 12.5 s the sound's buffers settle after
  // the outage (its own), at 24.7 s nothing explains it (a drop-out).
  const sigRuns = (k) => (k === 1 ? [{ startFrame: 24000, frames: 480 }] : k === 13 ? [{ startFrame: 609600, frames: 480 }] : []);
  for (let k = 1; k <= 18; k++) summary(node, { mode: "mic", frame: k * 48000, at: start + 12_000 + k * 1000, env: second(), sigRuns: sigRuns(k) });
  node.port.emit({ type: "done", frame: 18 * 48000 });
  const r = await handle.done;

  // What the analysis should have had: both watchers' envelopes where they were, −120 for the outage between.
  const wantRef = new Float32Array(5999).fill(-120);
  const wantSig = new Float32Array(5999).fill(-120);
  wantRef.set(refDb.subarray(0, 1999));
  wantSig.set(sigDb.subarray(0, 1999));
  wantRef.set(refDb.subarray(2400, 5999), 2400);
  wantSig.set(sigDb.subarray(2400, 5999), 2400);
  const want = analyzeSpeech({ refDb: wantRef, sigDb: wantSig, hopMs: 5 });
  assert.equal(r.speech.speechSec, Math.round(want.speechSec * 10) / 10, "the outage reads as silence, not as speech");
  assert.ok(Math.abs(r.speech.lagMs - 40) <= 5, String(r.speech.lagMs));
  assert.equal(r.speech.gaps.length, 1, JSON.stringify(r.speech.gaps));
  assert.ok(Math.abs(r.speech.gaps[0].atSec - 26.8) <= 0.3, JSON.stringify(r.speech.gaps));
  assert.deepEqual(r.speech.gaps.map((g) => g.atSec), want.gaps.map((g) => g.atSec));
  assert.deepEqual(r.speech.dropouts, [{ atSec: 24.7, phase: "visible", ms: 10 }]);
  assert.equal(r.speech.aroundOutages, 1);
  assert.deepEqual(r.outages, [{ atSec: 10.2, phase: "visible", ms: 1800, cause: "render-error" }]);
  assert.equal(r.recordedSec, 30);
});

test("results and logs hold no device names or ids", async () => {
  const s = setup();
  const t = await startTone(s, 0.25);
  seconds(t.node, t.start, 1, 15);
  s.graph.devices({ defaultOutputLabel: "Default - Priya's Headset" });
  t.node.port.emit({ type: "done", frame: 15 * 48000 });
  const r = await t.handle.done;
  assert.equal(r.defaultOutputChanges.length, 1);
  const text = JSON.stringify(r) + s.logs.join("\n");
  for (const bad of ["Priya", "Headset", "cable-in", "cable-out", "deviceId"]) assert.ok(!text.includes(bad), bad);
});

test("a gap within 2 s of a change of Windows' default playback device is listed with it, in both modes", async () => {
  const gapNotes = (r) => r.notes.filter((n) => n.startsWith("The sound stopped at"));
  // Tone mode: Windows switches its default playback device 10 s in; the tone stops at 10.5 s and at 25.5 s.
  let s = setup();
  const t = await startTone(s, 0.5);
  const gap = (sec) => ({ kind: "gap", atFrame: sec * 48000, frames: 9600, holeMs: 200 });
  seconds(t.node, t.start, 1, 30, (k) => {
    if (k === 11) {
      s.graph.devices({ defaultOutputLabel: "Default - Speakers" });
      return { counts: { gaps: 1 }, events: [gap(10.5)] };
    }
    if (k === 26) return { counts: { gaps: 2 }, events: [gap(25.5)] };
    return k > 11 ? { counts: { gaps: k > 26 ? 2 : 1 } } : {};
  });
  t.node.port.emit({ type: "done", frame: 30 * 48000 });
  let r = await t.handle.done;
  assert.deepEqual(r.defaultOutputChanges, [{ atSec: 10 }]);
  assert.deepEqual(gapNotes(r), [CHECK_TEXTS.defaultOutputGap(10.5)]);
  assert.deepEqual(r.tone.events.map((e) => e.note ?? null), [CHECK_TEXTS.defaultOutput, null]);

  // Mic mode: 300 ms with nothing on CABLE Output at 11.5 s and at 25.5 s, the same change 10 s in.
  s = setup();
  const handle = await s.checks.startLong({ mode: "mic", minutes: 0.5 });
  const node = newest("ac-cablewatch");
  const start = clock.now;
  for (let k = 1; k <= 30; k++) {
    if (k === 11) s.graph.devices({ defaultOutputLabel: "Default - Speakers" });
    const sigRuns = k === 12 ? [{ startFrame: 11.5 * 48000, frames: 14400 }] : k === 26 ? [{ startFrame: 25.5 * 48000, frames: 14400 }] : [];
    summary(node, { mode: "mic", frame: k * 48000, at: start + k * 1000, sigRuns });
  }
  node.port.emit({ type: "done", frame: 30 * 48000 });
  r = await handle.done;
  assert.deepEqual(r.speech.dropouts.map((d) => [d.atSec, d.ms, d.note ?? null]), [
    [11.5, 300, CHECK_TEXTS.defaultOutput],
    [25.5, 300, null],
  ]);
  assert.deepEqual(gapNotes(r), [CHECK_TEXTS.defaultOutputGap(11.5)]);
});

test("the element route's long check: its own context follows the microphone when the graph swaps it", async () => {
  const s = setup({ method: "element", routePreference: "element" });
  const before = nodes.length;
  const handle = await s.checks.startLong({ mode: "mic", minutes: 1 });
  const node = nodes.slice(before).find((n) => n.name === "ac-cablewatch");
  const own = node.context;
  assert.notEqual(own, s.graph.ctx);
  assert.equal(own.sinkId, "cable-in");
  const firstFresh = own.sources.find((n) => n.stream === s.graph.micStream);
  assert.ok(firstFresh && firstFresh.links.some(([t, i]) => t === node && i === 0));
  // The graph opens another microphone (a stand-in, or the headset back).
  const track = fakeTrack();
  s.graph.micStream = { id: "new", getTracks: () => [track], getAudioTracks: () => [track] };
  s.graph.dispatchEvent(new CustomEvent("mic", { detail: {} }));
  const second = own.sources.find((n) => n.stream === s.graph.micStream);
  assert.ok(second && second.links.some(([t, i]) => t === node && i === 0), "the new microphone feeds input 0");
  assert.equal(firstFresh.links.length, 0, "the old source is disconnected");
  const start = clock.now;
  seconds(node, start, 1, 3, () => ({ mode: "mic" }));
  const p = handle.stop();
  await flush();
  node.port.emit({ type: "done", frame: 3 * 48000 });
  const r = await p;
  assert.equal(r.site, "own-context");
  assert.equal(r.micPath, null);
  assert.equal(r.routePreference, "element");
  assert.equal(own.state, "closed");
});

test("a check whose analysis failed still says which route it was forced onto", async () => {
  const s = setup({ method: "element", routePreference: "element" });
  const t = await startTone(s, 1);
  s.checks._long.analyse = async () => {
    throw Object.assign(new Error("broken"), { name: "RangeError" });
  };
  seconds(t.node, t.start, 1, 3);
  const p = t.handle.stop();
  await answerStop(t.node, t.start, 3.5);
  const r = await p;
  assert.equal(r.verdict, "no-signal");
  assert.deepEqual(r.reasons, [CHECK_TEXTS.notAnalysed("RangeError")]);
  assert.equal(r.route, "element");
  assert.equal(r.routePreference, "element");
});

test("mic mode: when a run list is full, both lists stop at that moment and the result says so", async () => {
  const s = setup();
  const handle = await s.checks.startLong({ mode: "mic", minutes: 30 });
  const node = newest("ac-cablewatch");
  const start = clock.now;
  // 1100 microphone runs of 2 ms (a noisy gate), each copied to CABLE Output 10 ms later.
  let k = 0;
  for (let sec = 1; sec <= 60; sec++) {
    const refRuns = [];
    const sigRuns = [];
    for (let j = 0; j < 20 && k < 1100; j++, k++) {
      const at = Math.round((sec - 1 + j / 20 + 0.01) * 48000);
      refRuns.push({ startFrame: at, frames: 96 });
      sigRuns.push({ startFrame: at + 480, frames: 96 });
    }
    summary(node, { mode: "mic", frame: sec * 48000, at: start + sec * 1000, refRuns, sigRuns });
  }
  node.port.emit({ type: "done", frame: 60 * 48000 });
  const r = await handle.done;
  assert.ok(r.notes.some((n) => /drop-outs were checked for the first 0:50 only/.test(n)), JSON.stringify(r.notes));
  assert.equal(r.speech.dropouts.length, 0, "no CABLE Output run is left without its microphone run");
});

test("playbackStats: underruns per phase, listed next to a gap within 2 s", async () => {
  const s = setup();
  s.graph.ctx.playbackStats = { underrunEvents: 5, underrunDuration: 0.05 }; // before the check: the baseline
  const { handle, node, start } = await startTone(s, 1);
  seconds(node, start, 1, 30, (k) => {
    if (k === 12) {
      s.graph.ctx.playbackStats = { underrunEvents: 7, underrunDuration: 0.08 };
      return { counts: { gaps: 1 }, events: [{ kind: "gap", atFrame: 11.2 * 48000, frames: 9600, holeMs: 200 }] };
    }
    return k > 12 ? { counts: { gaps: 1 } } : {};
  });
  node.port.emit({ type: "done", frame: 30 * 48000 });
  const r = await handle.done;
  assert.deepEqual(r.playback.visible, { underrunEvents: 2, underrunMs: 30 });
  const gap = r.tone.events.find((e) => e.kind === "gap");
  assert.equal(gap.underrunEvents, 2);
  assert.equal(gap.underrunMs, 30);
});

test("no playbackStats (an older WebView2): playback is null", async () => {
  const s = setup();
  const { handle, node, start } = await startTone(s, 1);
  seconds(node, start, 1, 3);
  node.port.emit({ type: "done", frame: 3 * 48000 });
  const r = await handle.done;
  assert.equal(r.playback, null);
});
