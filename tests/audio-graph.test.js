// src/audio/graph.js on the fakes in tests/helpers/fake-audio.js, with node:test's mock clock:
// browser calls that never answer, rates read again after a fix in Windows, and the micBus hole count.
import test from "node:test";
import assert from "node:assert/strict";
import { advance, flush, useFakeAudio, watch } from "./helpers/fake-audio.js";
import { VoiceGraph } from "../src/audio/graph.js";
import { NO_ANSWER_MS } from "../src/audio/devices.js";

const NOTHING_SAVED = { mic: { deviceId: "", label: "" }, output: { deviceId: "", label: "" } };

/** A graph whose voice runs (first start done, rates read). */
async function runningGraph() {
  const graph = new VoiceGraph({ getSaved: () => NOTHING_SAVED });
  graph.start();
  await advance(1000);
  assert.equal(graph.state, "running");
  assert.equal(graph.debugCounts().routed, true);
  return graph;
}

const codes = (graph) => graph.warnings.map((w) => w.code);

/** stop() must finish without any more time passing; → whether it did. */
async function stopsAtOnce(graph) {
  const stopping = watch(graph.stop());
  await flush(4);
  return stopping.done;
}

test("a getUserMedia that never answers during a microphone reopen is given up and tried again", async (t) => {
  const fake = useFakeAudio(t);
  const graph = await runningGraph();
  fake.hang.gum = 1;
  fake.endMic(); // the reducer reopens the microphone; that getUserMedia never answers
  await advance(4000);
  assert.equal(graph.state, "recovering");
  graph.context.dispatchEvent(new Event("error")); // a second fault meanwhile
  await advance(NO_ANSWER_MS - 4000 + 1000);
  assert.equal(graph.state, "running", "the voice did not come back");
  assert.equal(graph.recoveries.length, 1);
  assert.equal(graph.recoveries[0].cause, "mic-ended");
  assert.equal(fake.liveTracks().length, 1, "one live microphone");
  assert.deepEqual(graph.debugCounts(), { contexts: 1, micSources: 1, taps: 0, routed: true });
  const [late] = fake.answerLate("gum");
  await flush();
  assert.equal(late.getTracks()[0].readyState, "ended", "the stream that came late is stopped");
  assert.equal(await stopsAtOnce(graph), true);
});

test("stop() does not wait for a getUserMedia that never answers", async (t) => {
  const fake = useFakeAudio(t);
  const graph = await runningGraph();
  fake.hang.gum = 1;
  fake.endMic();
  await advance(500); // the reopen-mic op now waits for getUserMedia, under the lock
  assert.equal(await stopsAtOnce(graph), true, "stop() waits behind the hung call");
  assert.equal(graph.state, "stopped");
  assert.equal(fake.graphContexts().filter((c) => c.state !== "closed").length, 0);
  assert.equal(fake.liveTracks().length, 0);
  const [late] = fake.answerLate("gum");
  await flush();
  assert.equal(late.getTracks()[0].readyState, "ended");
  assert.equal(fake.liveTracks().length, 0);
});

test("a device list that never comes during a rebuild is given up and tried again", async (t) => {
  const fake = useFakeAudio(t);
  const graph = await runningGraph();
  fake.hang.enumerate = 1;
  graph.context.close(); // a fault: the rebuild reads the devices first, and that list never comes
  await advance(4000);
  assert.equal(graph.state, "recovering");
  await advance(NO_ANSWER_MS - 4000 + 1000);
  assert.equal(graph.state, "running", "the voice did not come back");
  assert.equal(graph.recoveries.length, 1);
  assert.equal(graph.recoveries[0].cause, "context-closed");
  assert.deepEqual(graph.debugCounts(), { contexts: 1, micSources: 1, taps: 0, routed: true });
  assert.equal(await stopsAtOnce(graph), true);
  assert.equal(fake.liveTracks().length, 0, "the microphone is released");
  assert.equal(fake.graphContexts().filter((c) => c.state !== "closed").length, 0);
});

test("stop() does not wait for a device list that never comes", async (t) => {
  const fake = useFakeAudio(t);
  const graph = await runningGraph();
  fake.hang.enumerate = 1;
  graph.context.close();
  await advance(500);
  assert.equal(await stopsAtOnce(graph), true, "stop() waits behind the hung call");
  assert.equal(fake.liveTracks().length, 0);
});

test("the first start gets over a device list that never comes", async (t) => {
  const fake = useFakeAudio(t);
  fake.hang.enumerate = 1;
  const graph = new VoiceGraph({ getSaved: () => NOTHING_SAVED });
  graph.start();
  await advance(3000);
  assert.equal(graph.state, "starting");
  await advance(NO_ANSWER_MS);
  assert.equal(graph.state, "running");
  assert.equal(graph.startRecord?.attempts, 2);
  assert.equal(await stopsAtOnce(graph), true);
});

test("a microphone change whose device list never comes fails as a change: the old microphone stays", async (t) => {
  const fake = useFakeAudio(t);
  const saved = structuredClone(NOTHING_SAVED);
  const graph = new VoiceGraph({ getSaved: () => saved });
  graph.start();
  await advance(1000);
  assert.equal(graph.mic.entry.deviceId, "mic-head");
  saved.mic = { deviceId: "mic-laptop", label: "Microphone Array (Test Laptop)" }; // main.js saves the choice first
  fake.hang.enumerate = 1;
  graph.setMic("mic-laptop");
  await advance(NO_ANSWER_MS + 1000);
  assert.equal(graph.state, "running");
  assert.ok(codes(graph).includes("CHANGE_FAILED"), `warnings: ${codes(graph)}`);
  assert.equal(graph.recoveries.length, 0, "a change that failed is not a lost voice");
  assert.equal(graph.mic.entry.deviceId, "mic-head");
  assert.deepEqual(fake.liveTracks().map((tr) => tr.deviceId), ["mic-head"]);
  assert.equal(await stopsAtOnce(graph), true);
});

test("device changes are still read after one device list never came", async (t) => {
  const fake = useFakeAudio(t);
  const graph = await runningGraph();
  fake.hang.enumerate = 1;
  fake.devicechange(); // the device-change reader's list never comes
  await advance(300);
  fake.defaultOutputIsCable = true;
  fake.devicechange(); // a real change afterwards
  await advance(NO_ANSWER_MS + 1000);
  assert.ok(codes(graph).includes("OUTPUT_IS_CABLE"), `warnings: ${codes(graph)}`);
  fake.defaultOutputIsCable = false;
  fake.devicechange();
  await advance(200);
  assert.ok(!codes(graph).includes("OUTPUT_IS_CABLE"));
  assert.equal(await stopsAtOnce(graph), true);
});

test("Check the microphone reads CABLE Input's rate again (the user fixed it in Windows)", async (t) => {
  const fake = useFakeAudio(t, { cableRateHz: 44100 });
  const graph = await runningGraph();
  assert.equal(graph.rates.cableInputHz, 44100);
  assert.equal(graph.output.sinkRateHz, 44100);
  assert.ok(codes(graph).includes("CABLE_RATE"));
  fake.rates["cable-in"] = 48000; // Windows: CABLE Input set to 48000 Hz; nothing else happens
  const checking = watch(graph.retry());
  await flush(4);
  assert.equal(checking.done, true);
  assert.deepEqual(checking.value, { ok: true, state: "running" });
  assert.equal(graph.rates.cableInputHz, 48000, "retry() resolved before CABLE Input's rate was read again");
  assert.equal(graph.output.sinkRateHz, 48000);
  assert.ok(!codes(graph).includes("CABLE_RATE"));
  assert.equal(await stopsAtOnce(graph), true);
});

test("a device change reads CABLE Input's rate again", async (t) => {
  const fake = useFakeAudio(t);
  const graph = await runningGraph();
  assert.equal(graph.rates.cableInputHz, 48000);
  assert.ok(!codes(graph).includes("CABLE_RATE"));
  fake.rates["cable-in"] = 44100;
  fake.devicechange();
  await advance(100);
  assert.equal(graph.rates.cableInputHz, 44100);
  assert.ok(codes(graph).includes("CABLE_RATE"));
  assert.equal(await stopsAtOnce(graph), true);
});

test("Check the microphone during a rates read waits for one more read, made after the fix", async (t) => {
  const fake = useFakeAudio(t, { cableRateHz: 44100 });
  const graph = await runningGraph();
  // A device change starts a rates read; its CABLE Input probe (made at 44100 Hz) is slow to close.
  let once = true;
  fake.hangIf.close = (ctx) => {
    const hit = once && !ctx.explicitRate && ctx.sinkId === "cable-in";
    if (hit) once = false;
    return hit;
  };
  fake.devicechange();
  await advance(100);
  assert.equal(once, false, "the rates read did not reach the CABLE Input probe");
  fake.rates["cable-in"] = 48000; // the user fixes CABLE Input meanwhile, then presses Check the microphone
  const checking = watch(graph.retry());
  await advance(1000);
  assert.equal(checking.done, false, "retry() did not wait for the rates");
  await advance(1500); // the probe's close is given up after 2 s; one more read follows
  assert.equal(checking.done, true);
  assert.equal(graph.rates.cableInputHz, 48000);
  assert.ok(!codes(graph).includes("CABLE_RATE"));
  assert.equal(await stopsAtOnce(graph), true);
});

test("micBus holes in the first 10 s of a new microphone source are not counted", async (t) => {
  const fake = useFakeAudio(t);
  const graph = await runningGraph();
  const meter = () => fake.meters.at(-1);
  const now = () => graph.context.frameNow();

  // The first start: a 10 ms hole 0.5 s after the source started is the source's own.
  meter().queueHole(24000);
  await advance(200);
  assert.equal(graph.levels.micHolesTotal, 0);
  // Later holes count (a clock-crossing event), the 8-11 ms ones only.
  await advance(10000);
  meter().queueHole(now() - 4800);
  meter().queueHole(now() - 2400, 2400); // 50 ms: not a crossing hole
  await advance(200);
  assert.equal(graph.levels.micHolesTotal, 1);

  // A microphone swap (the microphone ended and came back): a new source.
  fake.endMic();
  await advance(800);
  assert.equal(graph.state, "running");
  assert.equal(graph.recoveries.length, 1);
  meter().queueHole(now() - 1200);
  await advance(200);
  assert.equal(graph.levels.micHolesTotal, 1, "a hole right after the swap was counted");
  await advance(10000);
  meter().queueHole(now() - 1200);
  await advance(200);
  assert.equal(graph.levels.micHolesTotal, 2);

  // A rebuild: a new context and a new source.
  graph.context.close();
  await advance(800);
  assert.equal(graph.state, "running");
  assert.equal(graph.recoveries.length, 2);
  meter().queueHole(now() - 1200);
  await advance(200);
  assert.equal(graph.levels.micHolesTotal, 2, "a hole right after the rebuild was counted");
  await advance(10000);
  meter().queueHole(now() - 1200);
  await advance(200);
  assert.equal(graph.levels.micHolesTotal, 3);
  assert.equal(await stopsAtOnce(graph), true);
});
