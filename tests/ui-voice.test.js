// Step 2 of the page (src/ui/voice.js): the status after a device or route
// choice, what counts as the graph using a choice, and which outages the
// Recoveries list shows. The page itself is covered by tests/browser/app.cjs;
// here a few page elements are faked, just enough for the view.
import test from "node:test";
import assert from "node:assert/strict";
import { VoiceView, VOICE_TEXTS, changeOutcome } from "../src/ui/voice.js";

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
