// src/audio/graph.js on the fakes in tests/helpers/fake-audio.js, with node:test's mock clock:
// browser calls that never answer, rates read again after a fix in Windows, the micBus hole count,
// once-taps that fail, and processor nodes that cannot be wired.
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

/** The nodes that feed outBus (the node the route connects to the destination): the processor slot. */
function slotNodes(graph) {
  const ctx = graph.context;
  const outBus = ctx.nodes.find((n) => n.links.includes(ctx.destination));
  return outBus ? ctx.nodes.filter((n) => n.links.includes(outBus)) : [];
}

const slotKinds = (graph) => slotNodes(graph).map((n) => n.kind);

/** The way from the microphone's newest source to the context's destination, as node kinds ("" when there is none). */
function voicePath(fake, graph) {
  const ctx = graph.context;
  const from = fake.sources.findLast((s) => s.context === ctx && s.mediaStream === graph.micStream);
  if (!from) return "";
  const before = new Map([[from, null]]);
  const queue = [from];
  while (queue.length > 0) {
    const node = queue.shift();
    if (node === ctx.destination) {
      const kinds = [];
      for (let n = node; n; n = before.get(n)) kinds.unshift(n.kind);
      return kinds.join(">");
    }
    for (const next of node.links) {
      if (!before.has(next)) {
        before.set(next, node);
        queue.push(next);
      }
    }
  }
  return "";
}

const PASSTHROUGH_PATH = "source>gain>gain>ac-passthrough>gain>destination";

/** Processor nodes that cannot sit in the slot: the browser refuses to connect them. */
const UNWIRABLE = {
  "no output": (ctx) => new AudioWorkletNode(ctx, "ac-test-sink", { numberOfInputs: 2, numberOfOutputs: 0 }),
  "another context's node": () => new AudioContext({ sampleRate: 48000 }).createGain(),
  "not an audio node": (ctx) => ({ context: ctx, numberOfInputs: 2, numberOfOutputs: 1, connect() {}, disconnect() {} }),
};

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
  const RATE = 48000;
  // The microphone's newest source, and how long ago (in seconds) it started.
  const source = () => fake.sources.findLast((s) => s.mediaStream === graph.micStream);
  const sinceSource = () => (graph.context.frameNow() - source().startFrame) / RATE;
  /** A micBus hole `sec` seconds after the newest source started; the meter sends it in its first message after it. */
  const holeAt = (sec, frames = 480) => fake.meters.at(-1).queueHole(source().startFrame + Math.round(sec * RATE), frames);
  /** Let the clock run on until `sec` seconds after the newest source started. */
  const runTo = (sec) => advance(Math.ceil((sec - sinceSource()) * 1000));

  /**
   * A new source's own start-up holes are left out: 10 ms holes 0.5 s and 9.5 s after it (in Chromium
   * they came up to about 7 s after it). A hole 10.5 s after it is a clock-crossing hole and counts.
   */
  async function newSourceHoles(total, when) {
    holeAt(0.5);
    holeAt(9.5);
    holeAt(10.5);
    await runTo(10.4);
    assert.equal(graph.levels.micHolesTotal, total, `${when}: a hole in the first 10 s of the source was counted`);
    await runTo(10.7);
    assert.equal(graph.levels.micHolesTotal, total + 1, `${when}: a hole 10.5 s after the source was not counted`);
  }

  // The first start.
  await newSourceHoles(0, "first start");
  holeAt(11, 2400); // 50 ms: not a clock-crossing hole
  await runTo(11.3);
  assert.equal(graph.levels.micHolesTotal, 1);

  // A microphone swap (the microphone ended and came back): a new source in the same context.
  fake.endMic();
  await advance(800);
  assert.equal(graph.state, "running");
  assert.equal(graph.recoveries.length, 1);
  assert.ok(sinceSource() < 1, "no new source after the swap");
  await newSourceHoles(1, "swap");

  // A rebuild: a new context and a new source.
  graph.context.close();
  await advance(800);
  assert.equal(graph.state, "running");
  assert.equal(graph.recoveries.length, 2);
  assert.ok(sinceSource() < 1, "no new source after the rebuild");
  await newSourceHoles(2, "rebuild");
  assert.equal(await stopsAtOnce(graph), true);
});

test("a once-tap whose build fails is gone: later recoveries do not build it again", async (t) => {
  useFakeAudio(t);
  const graph = await runningGraph();
  const tapErrors = [];
  graph.addEventListener("tap-error", (ev) => tapErrors.push(ev.detail.message));
  const builds = { rejects: 0, throws: 0, kept: 0 };
  graph.addTap(
    async () => {
      builds.rejects++;
      throw new Error("The delay recorder could not start.");
    },
    { once: true },
  );
  graph.addTap(
    () => {
      builds.throws++;
      throw new Error("The mic-path recorder could not start.");
    },
    { once: true },
  );
  // A tap that is not once is built again after every rebuild, also after a build that failed.
  graph.addTap(async () => {
    builds.kept++;
    if (builds.kept === 1) throw new Error("The long check's recorder could not start.");
    return { dispose() {} };
  });
  await advance(100);
  assert.deepEqual(builds, { rejects: 1, throws: 1, kept: 1 });
  assert.equal(tapErrors.length, 3);
  assert.equal(graph.debugCounts().taps, 0);

  graph.context.close(); // a fault: a new context
  await advance(800);
  assert.equal(graph.state, "running");
  graph.context.dispatchEvent(new Event("error")); // another fault: the context is resumed
  await advance(1000);
  assert.equal(graph.state, "running");
  assert.equal(graph.recoveries.length, 2);
  assert.deepEqual(builds, { rejects: 1, throws: 1, kept: 2 }, "a once-tap that failed was built again");
  assert.equal(tapErrors.length, 3);
  assert.equal(graph.debugCounts().taps, 1);
  assert.equal(await stopsAtOnce(graph), true);
});

for (const [what, makeNode] of Object.entries(UNWIRABLE)) {
  test(`a processor factory whose node cannot be wired (${what}): the voice starts through ac-passthrough`, async (t) => {
    const fake = useFakeAudio(t);
    const causes = [];
    const graph = new VoiceGraph({
      getSaved: () => NOTHING_SAVED,
      processor: async (ctx, info) => {
        causes.push(info.cause);
        return { node: makeNode(ctx) };
      },
    });
    graph.start();
    await advance(1000);
    assert.equal(graph.state, "running", graph.stateInfo.text);
    assert.equal(graph.startRecord?.attempts, 1);
    assert.ok(codes(graph).includes("PROCESSOR_FAILED"), `warnings: ${codes(graph)}`);
    assert.equal(graph.output.processor, "worklet");
    assert.deepEqual(slotKinds(graph), ["ac-passthrough"]);
    assert.equal(voicePath(fake, graph), PASSTHROUGH_PATH);
    assert.equal(graph.context.sinkId, "cable-in");

    // A rebuild asks the factory again, and falls back again.
    graph.context.close();
    await advance(800);
    assert.equal(graph.state, "running");
    assert.deepEqual(causes, ["start", "context-closed"]);
    assert.ok(codes(graph).includes("PROCESSOR_FAILED"));
    assert.equal(voicePath(fake, graph), PASSTHROUGH_PATH);
    assert.equal(await stopsAtOnce(graph), true);
  });
}

test("setProcessor with a node that cannot be wired keeps the voice going", async (t) => {
  const fake = useFakeAudio(t);
  const graph = await runningGraph();
  const converted = graph.context.createMediaStreamDestination().stream; // Step 7's converted voice
  await graph.setConvertedSource(converted);
  /** The converted voice goes to the processor in the slot (its input 1), and nowhere else. */
  const convertedToSlot = () => {
    const targets = fake.sources.filter((s) => s.mediaStream === converted).flatMap((s) => s.links);
    const slot = slotNodes(graph);
    return targets.length === 1 && slot.length === 1 && targets[0] === slot[0];
  };
  const swap = async (factory) => {
    const swapping = watch(graph.setProcessor(factory));
    await advance(100);
    assert.equal(swapping.done, true, "setProcessor did not finish");
    assert.equal(swapping.error, undefined, `setProcessor rejected: ${swapping.error?.name}`);
  };
  assert.equal(voicePath(fake, graph), PASSTHROUGH_PATH);
  assert.ok(convertedToSlot());

  for (const [what, makeNode] of Object.entries(UNWIRABLE)) {
    await swap(async (ctx) => ({ node: makeNode(ctx) }));
    assert.equal(graph.state, "running", what);
    assert.ok(codes(graph).includes("PROCESSOR_FAILED"), `${what}: warnings ${codes(graph)}`);
    assert.deepEqual(slotKinds(graph), ["ac-passthrough"], `${what}: one processor in the slot`);
    assert.equal(voicePath(fake, graph), PASSTHROUGH_PATH, `${what}: the voice does not reach the cable`);
    assert.ok(convertedToSlot(), `${what}: the converted voice does not go to the new processor only`);
  }

  // A factory whose node works takes the slot, and the warning goes.
  await swap(async (ctx) => ({ node: new AudioWorkletNode(ctx, "ac-test-mixer", { numberOfInputs: 2, numberOfOutputs: 1 }) }));
  assert.ok(!codes(graph).includes("PROCESSOR_FAILED"), `warnings: ${codes(graph)}`);
  assert.equal(voicePath(fake, graph), "source>gain>gain>ac-test-mixer>gain>destination");
  assert.ok(convertedToSlot());
  // A failed factory, then no factory: ac-passthrough was asked for, so nothing failed.
  await swap(async () => {
    throw new Error("The mixer could not start.");
  });
  assert.ok(codes(graph).includes("PROCESSOR_FAILED"));
  await swap(null);
  assert.ok(!codes(graph).includes("PROCESSOR_FAILED"), `warnings: ${codes(graph)}`);
  assert.equal(voicePath(fake, graph), PASSTHROUGH_PATH);
  assert.equal(graph.state, "running");
  assert.equal(graph.generation, 1, "a processor swap rebuilt the context");
  assert.equal(graph.recoveries.length, 0);
  assert.equal(await stopsAtOnce(graph), true);
});
