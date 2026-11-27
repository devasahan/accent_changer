// Step 2 of the page (src/ui/voice.js): the status after a device or route
// choice, what counts as the graph using a choice, when a choice is settled,
// which outages the Recoveries list shows and how, and a recovery as the
// results keep it. The page itself is covered by tests/browser/app.cjs; here
// a few page elements are faked, just enough for the view.
import test from "node:test";
import assert from "node:assert/strict";
import {
  VoiceView,
  VOICE_TEXTS,
  changeOutcome,
  choiceState,
  recoveryLine,
  recoveryResult,
  routeWords,
} from "../src/ui/voice.js";
import { restartVerdict } from "../src/core/cable-check.js";
import { deviceWarnings } from "../src/core/device-choice.js";
import { redactObject } from "../src/core/redact.js";

/** A page element as the view uses it: text, children, dataset. */
function element(doc) {
  return {
    ownerDocument: doc,
    children: [],
    dataset: {},
    text: "",
    get textContent() {
      return this.children.length ? this.children.map((c) => c.textContent).join("") : this.text;
    },
    set textContent(value) {
      this.children = [];
      this.text = String(value);
    },
    replaceChildren(...nodes) {
      this.children = nodes;
      this.text = "";
    },
    append(...nodes) {
      this.children.push(...nodes.map((n) => (typeof n === "string" ? Object.assign(element(doc), { text: n }) : n)));
    },
  };
}

/** A view on a stand-in graph; $ makes the elements it asks for. */
function view(graph) {
  const doc = { createElement: () => element(doc) };
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) els.set(id, element(doc));
    return els.get(id);
  };
  const v = new VoiceView({ $, graph: { recoveries: [], ...graph }, getSettings: () => ({}) });
  return { v, $ };
}

test("changeOutcome: a choice in use while the voice runs", () => {
  assert.deepEqual(changeOutcome({ taken: true, running: true, done: "Microphone switched.", failed: "No." }), {
    text: "Microphone switched.",
    kind: "ok",
  });
  assert.deepEqual(changeOutcome({ taken: true, running: true, done: "Microphone switched.", failed: "No.", notSaved: "disk full" }), {
    text: "Microphone switched. Could not save the settings: disk full",
    kind: "warn",
  });
});

test("changeOutcome: a choice in use while the voice does not reach the meeting (no VB-CABLE yet, an outage)", () => {
  assert.deepEqual(changeOutcome({ taken: true, running: false, done: "Microphone switched.", failed: "No." }), {
    text: `Microphone switched.${VOICE_TEXTS.notReaching}`,
    kind: "warn",
  });
  assert.equal(VOICE_TEXTS.notReaching, " Your voice is not reaching the meeting yet: see step 2.");
  assert.equal(
    changeOutcome({ taken: true, running: false, done: "Switched.", failed: "No.", notSaved: "x" }).text,
    `Switched.${VOICE_TEXTS.notReaching} Could not save the settings: x`,
  );
});

test("changeOutcome: a choice not in use", () => {
  assert.deepEqual(changeOutcome({ taken: false, running: true, done: "Yes.", failed: "Could not: see step 2." }), {
    text: "Could not: see step 2.",
    kind: "warn",
  });
  assert.equal(changeOutcome({ taken: false, running: false, done: "Yes.", failed: "Could not.", notSaved: "x" }).text, "Could not. Could not save the settings: x");
});

test("usesMic: the microphone the graph has open, whether the voice runs or not", () => {
  const mic = { entry: { deviceId: "mic-2", label: "Microphone 2" } };
  assert.equal(view({ state: "no-cable", mic }).v.usesMic("mic-2"), true);
  assert.equal(view({ state: "running", mic }).v.usesMic("mic-2"), true);
  assert.equal(view({ state: "running", mic }).v.usesMic("mic-1"), false);
  assert.equal(view({ state: "no-mic", mic: null }).v.usesMic("mic-2"), false);
  assert.equal(view({ state: "running", mic: { entry: { deviceId: "" } } }).v.usesMic(""), false);
});

test("usesOutput: checked against the route while the voice runs; taken while it does not", () => {
  const out = (entry, how) => ({ entry, how, routePreference: "auto" });
  const cable = { deviceId: "cable-in", label: "CABLE Input (VB-Audio Virtual Cable)" };
  assert.equal(view({ state: "running", output: out(cable, "saved-id") }).v.usesOutput("cable-in"), true);
  assert.equal(view({ state: "running", output: out(cable, "saved-id") }).v.usesOutput("other"), false);
  assert.equal(view({ state: "running", output: out(cable, "auto") }).v.usesOutput(""), true);
  assert.equal(view({ state: "running", output: out(cable, "saved-id") }).v.usesOutput(""), false);
  // Not running: every try reads the saved choice (a try that failed on the microphone never got to the output).
  assert.equal(view({ state: "no-mic", output: null }).v.usesOutput("cable-in"), true);
  assert.equal(view({ state: "sink-refused", output: out(cable, "saved-id") }).v.usesOutput("cable-in"), true);
});

test("usesRoute: the graph's route preference while the voice runs; taken while it does not", () => {
  const output = (routePreference) => ({ entry: null, how: "auto", routePreference });
  assert.equal(view({ state: "running", output: output("element") }).v.usesRoute("element"), true);
  assert.equal(view({ state: "running", output: output("auto") }).v.usesRoute("element"), false);
  assert.equal(view({ state: "running", output: output("auto") }).v.usesRoute("auto"), true);
  assert.equal(view({ state: "sink-refused", output: output("auto") }).v.usesRoute("element"), true);
});

test("Recoveries: the first start's 'still trying' is not listed (step 2's status shows it)", () => {
  const { v, $ } = view({ state: "no-cable" });
  v.renderRecoveries();
  assert.equal($("recoveryLog").textContent, VOICE_TEXTS.noRecoveries);
  v.onRecovery({ kind: "still-trying", outage: { kind: "start", cause: "start", lostAtMs: performance.now() - 8000 }, sinceMs: 8000 });
  assert.equal($("recoveryLog").textContent, VOICE_TEXTS.noRecoveries);
  // Then the start ends: still nothing listed.
  v.onRecovery({ kind: "started", record: { ms: 9000, attempts: 6, steps: ["rebuild"] } });
  assert.equal($("recoveryLog").textContent, VOICE_TEXTS.noRecoveries);
});

test("Recoveries: a fault outage is listed while it lasts, with 'still trying'", () => {
  const { v, $ } = view({ state: "recovering" });
  const lostAtMs = performance.now();
  v.onRecovery({ kind: "lost", outage: { kind: "fault", cause: "render-error", lostAtMs } });
  assert.match($("recoveryLog").textContent, /^\d\d:\d\d:\d\d · the audio device reported an error: bringing it back…$/);
  v.onRecovery({ kind: "still-trying", outage: { kind: "fault", cause: "render-error", lostAtMs }, sinceMs: 12000 });
  assert.match($("recoveryLog").textContent, /^\d\d:\d\d:\d\d · the audio device reported an error: still trying \(12 s\)$/);
  v.onRecovery({ kind: "back", record: { cause: "render-error", lostAtMs, outageMs: 13000 } });
  assert.equal($("recoveryLog").textContent, VOICE_TEXTS.noRecoveries); // the graph's log (empty here) lists it once back
});

test("Recoveries: an outage that waits for the user says so, not that the voice is being brought back", () => {
  const graph = { state: "recovering", stateInfo: { state: "recovering", text: "", kind: "warn" }, recoveries: [] };
  const { v, $ } = view(graph);
  const lostAtMs = performance.now();
  const outage = { kind: "fault", cause: "mic-ended", lostAtMs };
  v.onRecovery({ kind: "lost", outage });
  assert.match($("recoveryLog").textContent, /^\d\d:\d\d:\d\d · the microphone stopped: bringing it back…$/);
  // The microphone is refused (Windows' privacy switch, say): the app stops trying until the user acts.
  v.graph.state = "mic-blocked";
  v.onRecovery({ kind: "blocked", outage, reason: "blocked", error: { name: "MicError", code: "blocked" } });
  const line = $("recoveryLog").textContent;
  assert.match(line, /^\d\d:\d\d:\d\d · the microphone stopped: waiting for you \(see step 2\)$/);
  assert.ok(!line.includes(VOICE_TEXTS.bringingBack), line);
  assert.equal(VOICE_TEXTS.waitingForYou, "waiting for you (see step 2)");
  // The same while VB-CABLE is refused, or while Edge waits for a click.
  for (const state of ["sink-refused", "needs-gesture"]) {
    v.graph.state = state;
    v.renderRecoveries();
    assert.match($("recoveryLog").textContent, /: waiting for you \(see step 2\)$/, state);
  }
  // The user acted ("Check the microphone"): the app tries again, and the line says so at the state's change.
  v.graph.state = "recovering";
  v.onState({ state: "recovering" });
  assert.match($("recoveryLog").textContent, /^\d\d:\d\d:\d\d · the microphone stopped: bringing it back…$/);
  v.graph.state = "mic-blocked";
  v.onState({ state: "mic-blocked" });
  assert.match($("recoveryLog").textContent, /waiting for you/);
  v.graph.state = "running";
  v.onRecovery({ kind: "back", record: { cause: "mic-ended", lostAtMs, outageMs: 30000 } });
  assert.equal($("recoveryLog").textContent, VOICE_TEXTS.noRecoveries); // the graph's log (empty here) lists it once back
});

test("Recoveries: a 'still trying' line becomes 'waiting for you' when the outage is blocked", () => {
  const graph = { state: "recovering", stateInfo: { state: "recovering", text: "", kind: "warn" }, recoveries: [] };
  const { v, $ } = view(graph);
  const lostAtMs = performance.now() - 15000;
  const outage = { kind: "fault", cause: "sink-changed", lostAtMs };
  v.onRecovery({ kind: "lost", outage });
  v.onRecovery({ kind: "still-trying", outage, sinceMs: 15000 });
  assert.match($("recoveryLog").textContent, /the playback device changed: still trying \(15 s\)$/);
  v.graph.state = "sink-refused";
  v.onRecovery({ kind: "blocked", outage, reason: "blocked", error: { kind: "blocked" } });
  assert.match($("recoveryLog").textContent, /the playback device changed: waiting for you \(see step 2\)$/);
});

/** A fault record as OutputRecovery.log keeps it (a Windows Audio restart: the context and the microphone both lost). */
function restartRecord(lostAtMs) {
  return {
    cause: "render-error",
    lostAtMs,
    backAtMs: lostAtMs + 2672.4,
    outageMs: 2672.4,
    attempts: 12,
    steps: ["resume", "rebuild", "rebuild"],
    devicesGoneAtMs: lostAtMs + 3,
    devicesBackAtMs: lostAtMs + 2520.2,
    afterDevicesBackMs: 152.2,
    serviceBackAtMs: lostAtMs + 2520.2,
    appMs: 152.2,
    waitMs: 196.6,
    micToo: true,
  };
}

test("recoveryResult: a Windows Audio restart keeps the timings and the restart verdict Gate 1 reads", () => {
  const lostAtMs = performance.now() - 10000;
  const out = recoveryResult(restartRecord(lostAtMs));
  assert.deepEqual(
    { ...out, at: null },
    {
      cause: "render-error",
      at: null,
      outageMs: 2672,
      serviceBackAfterMs: 2520,
      appMs: 152,
      waitMs: 197,
      afterDevicesBackMs: 152,
      attempts: 12,
      steps: ["resume", "rebuild", "rebuild"],
      micToo: true,
      restart: { verdict: "pass", text: "pass (Windows itself took about 2.5 s)" },
    },
  );
  assert.match(out.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.ok(Math.abs(Date.parse(out.at) - (Date.now() - 10000)) < 1000, out.at);
  // The checklist reads the results' own form: the same verdict from it.
  assert.deepEqual(restartVerdict(out), out.restart);
  assert.ok(out.serviceBackAfterMs <= out.outageMs);
  // The app's own part too slow: the verdict fails, and says why.
  const slow = recoveryResult({ ...restartRecord(lostAtMs), outageMs: 4000, serviceBackAtMs: lostAtMs + 2800, appMs: 900, waitMs: 300 });
  assert.equal(slow.restart.verdict, "fail");
  assert.equal(slow.restart.text, "fail (back after 4.0 s; the app's own part took 1200 ms: it waited 300 ms before trying again, then took 900 ms to bring the voice back)");
  assert.equal(slow.serviceBackAfterMs, 2800);
});

test("recoveryResult: a microphone alone (or the context alone) is no Windows Audio restart", () => {
  const lostAtMs = performance.now() - 2000;
  const mic = recoveryResult({ cause: "mic-ended", lostAtMs, outageMs: 312.6, attempts: 1, steps: ["reopen-mic"], serviceBackAtMs: lostAtMs + 1, appMs: 311.6, waitMs: 0, afterDevicesBackMs: null, micToo: false });
  assert.equal(mic.micToo, false);
  assert.ok(!("restart" in mic), JSON.stringify(mic));
  assert.equal(mic.outageMs, 313);
  assert.equal(mic.afterDevicesBackMs, null);
  assert.deepEqual(mic.steps, ["reopen-mic"]);
  const ctx = recoveryResult({ cause: "context-closed", lostAtMs, outageMs: 400, attempts: 1, steps: ["rebuild"], micToo: false });
  assert.ok(!("restart" in ctx));
  assert.equal(ctx.serviceBackAfterMs, null); // no first op that worked was recorded
});

test("recoveryLine: the Windows Audio restart verdict only when the microphone was lost too", () => {
  const lostAtMs = performance.now() - 10000;
  assert.match(
    recoveryLine(restartRecord(lostAtMs)),
    /^\d\d:\d\d:\d\d · the audio device reported an error: back after 2\.7 s · Windows Audio restart\? pass \(Windows itself took about 2\.5 s\)$/,
  );
  const mic = recoveryLine({ cause: "mic-ended", lostAtMs, outageMs: 312.6, micToo: false });
  assert.match(mic, /^\d\d:\d\d:\d\d · the microphone stopped: back after 0\.3 s$/);
  assert.ok(!mic.includes("Windows Audio restart"), mic);
});

// ---------- device and route choices ----------

test("choiceState: pending while a switch goes on, or while the voice starts or recovers without it", () => {
  // A change in progress: pending, even if the choice looks taken (the output while not running, say).
  assert.equal(choiceState({ taken: true, state: "switching" }), "pending");
  assert.equal(choiceState({ taken: false, state: "switching" }), "pending");
  for (const state of ["running", "recovering", "starting", "no-cable", "no-mic", "sink-refused"]) {
    assert.equal(choiceState({ taken: true, state }), "taken", state);
  }
  assert.equal(choiceState({ taken: false, state: "recovering" }), "pending");
  assert.equal(choiceState({ taken: false, state: "starting" }), "pending");
  for (const state of ["running", "no-mic", "mic-blocked", "mic-busy", "no-cable", "sink-refused", "needs-gesture", "stopped"]) {
    assert.equal(choiceState({ taken: false, state }), "failed", state);
  }
});

/** A stand-in graph for the choices: its state, microphone and output can be changed by the test. */
function choiceGraph() {
  const mic = (deviceId) => ({ entry: { deviceId, label: deviceId }, track: { readyState: "live" } });
  const snapshot = {
    usable: [
      { deviceId: "mic-1", label: "Microphone 1" },
      { deviceId: "mic-2", label: "Microphone 2" },
      { deviceId: "mic-3", label: "Microphone 3" },
    ],
    outputs: [],
    cableIn: null,
  };
  return {
    state: "running",
    stateInfo: { state: "running", text: "", kind: "ok" },
    mic: mic("mic-1"),
    output: { entry: { deviceId: "cable-in" }, how: "auto", routePreference: "auto" },
    snapshot,
    warnings: [],
    rates: {},
    recoveries: [],
    useMic(id) {
      this.mic = mic(id);
    },
  };
}

test("follow: a microphone that opens after the graph answered (it answers within 10 s, opening may take 15 s)", async () => {
  const { v, $ } = view(choiceGraph());
  const g = v.graph;
  const choice = v.follow("mic", "mic-2");
  // Until the graph answers, the graph's events settle nothing.
  g.state = "switching";
  v.onState({ state: "switching" });
  v.renderSelects();
  assert.equal($("micSelect").value, "mic-2", "the list shows the chosen microphone meanwhile");
  // The graph answers after 10 s: the switch is still going on.
  assert.equal(choice.answered(), "pending");
  let outcome;
  choice.settled.then((o) => {
    outcome = o;
  });
  // The new microphone is in place, but the switch is not over until the graph runs again.
  g.useMic("mic-2");
  v.checkChoices();
  await Promise.resolve();
  assert.equal(outcome, undefined);
  g.state = "running";
  v.onState({ state: "running" });
  assert.equal(await choice.settled, "taken");
  assert.equal(v.choices.size, 0);
  assert.equal($("micSelect").value, "mic-2");
});

test("follow: a switch that ends with the old microphone fails, and the list shows the microphone in use", async () => {
  const { v, $ } = view(choiceGraph());
  const g = v.graph;
  const choice = v.follow("mic", "mic-2");
  g.state = "switching";
  assert.equal(choice.answered(), "pending");
  v.renderSelects();
  assert.equal($("micSelect").value, "mic-2");
  // "change-failed": the old microphone goes on.
  g.state = "running";
  v.onState({ state: "running" });
  assert.equal(await choice.settled, "failed");
  assert.equal($("micSelect").value, "mic-1");
});

test("follow: a refused microphone (the graph waits for the user) fails", async () => {
  const { v } = view(choiceGraph());
  const g = v.graph;
  const choice = v.follow("mic", "mic-2");
  g.state = "recovering"; // the change broke the voice: a fault, retried with the saved choice
  assert.equal(choice.answered(), "pending");
  g.state = "mic-blocked";
  v.onState({ state: "mic-blocked" });
  assert.equal(await choice.settled, "failed");
});

test("follow: during an outage, a microphone in use is taken at once; one not open yet is taken when it opens", async () => {
  const { v } = view(choiceGraph());
  const g = v.graph;
  g.state = "recovering";
  const first = v.follow("mic", "mic-2");
  g.useMic("mic-2");
  assert.equal(first.answered(), "taken");
  assert.equal(await first.settled, "taken");
  const second = v.follow("mic", "mic-1");
  assert.equal(second.answered(), "pending");
  g.useMic("mic-1");
  v.checkChoices(); // the graph's "mic" event
  assert.equal(await second.settled, "taken");
});

test("follow: an output or a route is pending while the switch goes on, then checked against the graph", async () => {
  const { v } = view(choiceGraph());
  const g = v.graph;
  g.state = "switching";
  const out = v.follow("output", "");
  assert.equal(out.answered(), "pending", "not taken while switching, though usesOutput says so while the voice does not run");
  g.state = "running";
  g.output = { entry: { deviceId: "cable-in" }, how: "auto", routePreference: "auto" };
  v.onState({ state: "running" });
  assert.equal(await out.settled, "taken");

  g.state = "switching";
  const route = v.follow("route", "element");
  assert.equal(route.answered(), "pending");
  g.state = "running"; // the graph runs on the old route
  v.onState({ state: "running" });
  assert.equal(await route.settled, "failed");

  // Settled at once when the graph's answer already shows it.
  const now = v.follow("output", "cable-in");
  g.output = { entry: { deviceId: "cable-in" }, how: "saved-id", routePreference: "auto" };
  assert.equal(now.answered(), "taken");
  assert.equal(await now.settled, "taken");
});

test("follow: a newer choice of the same kind replaces a pending one; other kinds are followed side by side", async () => {
  const { v, $ } = view(choiceGraph());
  const g = v.graph;
  g.state = "switching";
  const a = v.follow("mic", "mic-2");
  assert.equal(a.answered(), "pending");
  v.renderSelects();
  assert.equal($("micSelect").value, "mic-2");
  const out = v.follow("output", "");
  $("micSelect").value = "mic-3"; // the user picks another microphone in the list
  const b = v.follow("mic", "mic-3");
  assert.equal(await a.settled, null, "replaced");
  assert.equal(a.answered(), null);
  assert.equal($("micSelect").value, "mic-3", "the list stays on the newest choice (not on the microphone in use)");
  assert.equal(b.answered(), "pending");
  assert.equal(out.answered(), "pending");
  g.state = "running";
  g.useMic("mic-3");
  v.onState({ state: "running" });
  assert.equal(await b.settled, "taken");
  assert.equal(await out.settled, "taken");
  assert.equal($("micSelect").value, "mic-3");
});

test("follow: a choice is not settled by the graph's events before the graph has answered it", async () => {
  const { v } = view(choiceGraph());
  const g = v.graph;
  const choice = v.follow("output", "cable-in"); // saved, not asked yet: the graph still runs on Automatic
  let outcome;
  choice.settled.then((o) => {
    outcome = o;
  });
  v.onState({ state: "running" });
  v.checkChoices();
  await Promise.resolve();
  assert.equal(outcome, undefined);
  g.output = { entry: { deviceId: "cable-in" }, how: "saved-id", routePreference: "auto" };
  assert.equal(choice.answered(), "taken");
});

// ---------- what step 2 shows, and what the results keep ----------

/**
 * A stand-in graph for results(): a personal word ("Zelda") in every device
 * name and a 64-hex id for every device, as on a PC where the user renamed
 * their devices (VB-CABLE's endpoints and a Voicemeeter output included).
 */
function personalGraph() {
  const hex = (c) => c.repeat(64);
  const mic = { deviceId: hex("a"), groupId: hex("1"), kind: "audioinput", label: "Headset (Zelda's AirPods Hands-Free AG Audio)" };
  const laptop = { deviceId: hex("b"), groupId: hex("2"), kind: "audioinput", label: "Microphone Array (Zelda's laptop)" };
  const cableOut = { deviceId: hex("c"), groupId: hex("3"), kind: "audioinput", label: "Zelda cable (VB-Audio Virtual Cable)" };
  const cableIn = { deviceId: hex("d"), groupId: hex("3"), kind: "audiooutput", label: "Zelda speakers (VB-Audio Virtual Cable)" };
  const ear = { deviceId: hex("e"), groupId: hex("1"), kind: "audiooutput", label: "Headphones (Zelda's AirPods Stereo)" };
  const snapshot = {
    labelsVisible: true,
    inputs: [{ deviceId: "default", groupId: hex("1"), kind: "audioinput", label: `Default - ${mic.label}` }, mic, laptop, cableOut],
    outputs: [{ deviceId: "default", groupId: hex("1"), kind: "audiooutput", label: `Default - ${ear.label}` }, ear, cableIn],
    usable: [mic, laptop],
    cableIn,
    cableOut,
    defaultInputLabel: `Default - ${mic.label}`,
    defaultOutputLabel: `Default - ${ear.label}`,
    commsInputLabel: `Communications - ${mic.label}`,
    commsOutputLabel: `Communications - ${ear.label}`,
    cableEndpoints: [cableOut.label, cableIn.label],
  };
  const warnInput = {
    micLabel: laptop.label,
    savedMicLabel: mic.label,
    standIn: true,
    outputFound: true,
    savedOutputMissing: true,
    savedOutputLabel: "Zelda's Voicemeeter (VB-Audio Voicemeeter VAIO)",
  };
  return {
    state: "running",
    stateInfo: { state: "running", text: "x", kind: "ok" },
    snapshot,
    mic: {
      entry: laptop,
      how: "stand-in",
      standIn: true,
      settings: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRateHz: 48000 },
      openedInMs: 40,
      unlockMs: 120,
      mutedCount: 0,
      track: { readyState: "live", stats: null, getSettings: () => ({}) },
    },
    output: {
      entry: cableIn,
      how: "saved-id",
      method: "element",
      routePreference: "auto",
      tried: [
        { method: "context", ok: false, errorName: "NotAllowedError", errorMessage: `access to the device ${hex("d")} is not permitted.` },
        { method: "element", ok: true },
      ],
      routeChanges: [],
      contextSink: "mic-sibling",
    },
    rates: { defaultOutputHz: 48000, cableInputHz: 48000 },
    startRecord: { ms: 100, attempts: 1, steps: ["rebuild"] },
    levels: { micHolesTotal: 0 },
    recoveries: [],
    debugCounts: () => ({ contexts: 1, micSources: 1, taps: 0, routed: true }),
    warningsWith: (nameOf) => deviceWarnings(warnInput, nameOf),
    get warnings() {
      return deviceWarnings(warnInput);
    },
  };
}

test("U11: no device name or id reaches the results, whatever the user named their devices", () => {
  const { v, $ } = view(personalGraph());
  v.started();
  const copied = JSON.stringify(redactObject({ microphone: v.microphoneCheck(), voice: v.results() }));
  // As "Copy results" gives them (main.js renders them through redactObject).
  assert.doesNotMatch(copied, /zelda|airpods/i);
  assert.doesNotMatch(copied, /[0-9a-f]{64}/i);
  // Every field that holds a name is there, masked: the renamed CABLE Input is still known as VB-CABLE's.
  const voice = JSON.parse(copied).voice;
  assert.equal(voice.output.label, "[renamed] (VB-Audio Virtual Cable)");
  assert.deepEqual(voice.devices.cableEndpoints, ["[renamed] (VB-Audio Virtual Cable)", "[renamed] (VB-Audio Virtual Cable)"]);
  assert.ok(voice.mic.label && voice.warnings.length >= 2, copied);
  // The page itself (it stays on this PC) shows the real names.
  assert.match($("micInfo").textContent, /Zelda's laptop/);
});

test("U12: the results keep the launch's first microphone open, whatever reopens came later", () => {
  const { v } = view(personalGraph());
  const g = v.graph;
  // The graph's first start, with that start's own open and unlock times (the latest reopen took 40 ms).
  g.startRecord = { ms: 812.4, attempts: 2, steps: ["rebuild", "rebuild"], openedInMs: 2100, unlockMs: 340 };
  assert.deepEqual(v.results().start, { ms: 812, attempts: 2, steps: ["rebuild", "rebuild"], openedInMs: 2100, unlockMs: 340 });
  assert.equal(v.results().mic.openedInMs, 40, "mic keeps the latest open");
  // A graph that does not keep the first open: the open time is not known, never the latest one.
  g.startRecord = { ms: 812.4, attempts: 1, steps: ["rebuild"] };
  assert.deepEqual(v.results().start, { ms: 812, attempts: 1, steps: ["rebuild"], openedInMs: null, unlockMs: 120 });
  g.startRecord = null;
  assert.equal(v.results().start, null);
});

test("U15: step 2 names the route in plain words", () => {
  assert.equal(routeWords("context"), "the normal route");
  assert.equal(routeWords("element"), "a slower backup route");
  assert.equal(routeWords("context-after-permission"), "the normal route, after a permission fix");
  assert.equal(routeWords("element-after-permission"), "a slower backup route, after a permission fix");
  assert.equal(routeWords(null), VOICE_TEXTS.notYet);
  const { v, $ } = view(personalGraph());
  v.renderInfo();
  const shown = $("voiceInfo").textContent;
  assert.match(shown, /Sent througha slower backup route/);
  assert.doesNotMatch(shown, /audio element|fallback|\+/);
});

test("U18: step 2 says each sentence once: a warning that is the status line is not listed under it", () => {
  const { v, $ } = view(personalGraph());
  const g = v.graph;
  const warnings = g.warnings;
  const standIn = warnings.find((w) => w.code === "STAND_IN");
  assert.ok(standIn && warnings.length >= 2, JSON.stringify(warnings));
  // Running on a stand-in microphone: the status line is the STAND_IN warning's own text.
  g.stateInfo = { state: "running", text: standIn.text, kind: "warn", code: "STAND_IN" };
  v.renderStatus();
  assert.equal($("voiceStatus").textContent, standIn.text);
  const listed = () => $("voiceWarnings").children.map((li) => li.textContent);
  assert.deepEqual(listed(), warnings.filter((w) => w.code !== "STAND_IN").map((w) => w.text));
  // The same on a warnings event.
  v.renderWarnings();
  assert.ok(!listed().includes(standIn.text));
  // Once the status line says something else, the warning is listed again.
  g.stateInfo = { state: "running", text: "Your voice goes into “CABLE Input”.", kind: "ok" };
  v.onState({ state: "running" });
  assert.ok(listed().includes(standIn.text));
  // The results keep every warning.
  g.stateInfo = { state: "running", text: standIn.text, kind: "warn", code: "STAND_IN" };
  assert.ok(v.results().warnings.some((w) => w.code === "STAND_IN"));
});

test("U22: without CABLE Input the output list says what it did not find", () => {
  const { v, $ } = view(personalGraph());
  const g = v.graph;
  v.renderSelects();
  assert.equal($("outSelect").children[0].textContent, "Automatic: CABLE Input");
  g.snapshot = { ...g.snapshot, cableIn: null, outputs: g.snapshot.outputs.filter((d) => !/Virtual Cable/.test(d.label)) };
  v.renderSelects();
  assert.equal($("outSelect").children[0].textContent, "Automatic: CABLE Input not found");
  assert.equal(VOICE_TEXTS.autoMissing, "Automatic: CABLE Input not found");
});
