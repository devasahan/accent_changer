import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  HIDDEN_NAME,
  PSEUDO_IDS,
  RENAMED_CABLE,
  WARNINGS,
  chooseMic,
  chooseOutput,
  deviceWarnings,
  findCableOutput,
  headphonesFor,
  labelFlags,
  micSettingsReport,
  pseudoTarget,
  reportLabel,
  siblingOutput,
  toneOutput,
  virtualOutputs,
} from "../src/core/device-choice.js";
import { feedbackWarnings } from "../src/core/devices-match.js";
import { rng } from "./helpers/synth.js";

// Chromium's device ids: 64 hex digits per device and origin (seeded, so the same every run).
const rand = rng(20261127);
const hexId = () => Array.from({ length: 64 }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("");
const ID = {
  headsetMic: hexId(),
  arrayMic: hexId(),
  cableOut: hexId(),
  cableOut2: hexId(),
  krisp: hexId(),
  stereoMix: hexId(),
  speakers: hexId(),
  earphone: hexId(),
  cableIn: hexId(),
  cableIn16: hexId(),
  voicemeeter: hexId(),
};
const GROUP = { headset: "group-headset", laptop: "group-laptop", cable: "group-cable", vm: "group-vm" };

const mic = (deviceId, label, groupId = "") => ({ deviceId, kind: "audioinput", label, groupId });
const out = (deviceId, label, groupId = "") => ({ deviceId, kind: "audiooutput", label, groupId });

/** A Windows laptop with a USB headset, VB-CABLE, Krisp and Stereo Mix, as Chromium lists it. */
const INPUTS = [
  mic("default", "Default - Headset Microphone (2- USB Audio Device)", GROUP.headset),
  mic("communications", "Communications - Headset Microphone (2- USB Audio Device)", GROUP.headset),
  mic(ID.arrayMic, "Microphone Array (Realtek(R) Audio)", GROUP.laptop),
  mic(ID.cableOut, "CABLE Output (VB-Audio Virtual Cable)", GROUP.cable),
  mic(ID.headsetMic, "Headset Microphone (2- USB Audio Device)", GROUP.headset),
  mic(ID.krisp, "Krisp Microphone (Krisp Audio)"),
  mic(ID.stereoMix, "Stereo Mix (Realtek(R) Audio)", GROUP.laptop),
];
const OUTPUTS = [
  out("default", "Default - Headset Earphone (2- USB Audio Device)", GROUP.headset),
  out("communications", "Communications - Headset Earphone (2- USB Audio Device)", GROUP.headset),
  out(ID.speakers, "Speakers (Realtek(R) Audio)", GROUP.laptop),
  out(ID.earphone, "Headset Earphone (2- USB Audio Device)", GROUP.headset),
  out(ID.cableIn, "CABLE Input (VB-Audio Virtual Cable)", GROUP.cable),
  out(ID.cableIn16, "CABLE In 16 Ch (VB-Audio Virtual Cable)", GROUP.cable),
  out(ID.voicemeeter, "VoiceMeeter Input (VB-Audio VoiceMeeter VAIO)", GROUP.vm),
];
const snapshot = (overrides = {}) => ({ labelsVisible: true, inputs: INPUTS, outputs: OUTPUTS, ...overrides });
const ids = (list) => list.map((d) => d.deviceId);
const withDefault = (list, label) => list.map((d) => (d.deviceId === "default" ? { ...d, label } : d));

test("constants", () => {
  assert.deepEqual([...PSEUDO_IDS], ["default", "communications"]);
  assert.equal(HIDDEN_NAME, "[name hidden]");
  assert.equal(RENAMED_CABLE, "[renamed] (VB-Audio Virtual Cable)");
});

// ---------- the cable and the virtual outputs ----------

test("findCableOutput: the exact label first, renamed endpoints too, never a pseudo or id-less entry", () => {
  assert.equal(findCableOutput(INPUTS).deviceId, ID.cableOut);
  const twice = [mic(ID.cableOut2, "CABLE Output (2- VB-Audio Virtual Cable)"), mic(ID.cableOut, "CABLE Output (VB-Audio Virtual Cable)")];
  assert.equal(findCableOutput(twice).deviceId, ID.cableOut, "the exact label wins over the numbered one");
  assert.equal(findCableOutput([twice[0]]).deviceId, ID.cableOut2);
  const renamed = [mic(ID.headsetMic, "Headset Microphone (USB Audio Device)"), mic(ID.cableOut, "Accent Mic (VB-Audio Virtual Cable)")];
  assert.equal(findCableOutput(renamed).deviceId, ID.cableOut);
  assert.equal(
    findCableOutput([mic("default", "Default - CABLE Output (VB-Audio Virtual Cable)"), mic("", "CABLE Output (VB-Audio Virtual Cable)")]),
    null,
  );
  assert.equal(findCableOutput(INPUTS.filter((d) => d.deviceId !== ID.cableOut)), null);
  assert.equal(findCableOutput(OUTPUTS), null, "an output list has no CABLE Output");
  assert.equal(findCableOutput(null), null);
  // A renamed endpoint without Windows' numbering, listed first, still loses to the exact label.
  const renamedFirst = [mic(ID.cableOut2, "Accent Mic (VB-Audio Virtual Cable)"), mic(ID.cableOut, "CABLE Output (VB-Audio Virtual Cable)")];
  assert.equal(findCableOutput(renamedFirst).deviceId, ID.cableOut);
});

test("virtualOutputs: the cable and other virtual playback devices, in order", () => {
  assert.deepEqual(ids(virtualOutputs(OUTPUTS)), [ID.cableIn, ID.cableIn16, ID.voicemeeter]);
  assert.deepEqual(ids(virtualOutputs([out(ID.cableIn, "Accent Out (VB-Audio Virtual Cable)")])), [ID.cableIn], "renamed");
  assert.deepEqual(virtualOutputs([out("default", "Default - CABLE Input (VB-Audio Virtual Cable)"), out("", "CABLE Input")]), []);
  assert.deepEqual(virtualOutputs([out(ID.speakers, "Speakers (Realtek(R) Audio)")]), []);
});

test("pseudoTarget: the real entry behind Windows' default, in any language", () => {
  assert.equal(pseudoTarget(OUTPUTS).deviceId, ID.earphone);
  assert.equal(pseudoTarget(OUTPUTS, "communications").deviceId, ID.earphone);
  assert.equal(pseudoTarget(INPUTS).deviceId, ID.headsetMic);
  // Normalized: Windows' "(2- " numbering and Chromium's USB id differ between the pseudo and the real entry.
  const usb = [out("default", "Default - Headset Earphone (Jabra EVOLVE 20 MS)"), out(ID.earphone, "Headset Earphone (2- Jabra EVOLVE 20 MS) (0b0e:0348)")];
  assert.equal(pseudoTarget(usb).deviceId, ID.earphone);
  const german = [out("default", "Standard - Lautsprecher (Realtek(R) Audio)"), out(ID.speakers, "Lautsprecher (Realtek(R) Audio)")];
  assert.equal(pseudoTarget(german).deviceId, ID.speakers);
  assert.equal(pseudoTarget(OUTPUTS.filter((d) => d.deviceId !== "default")), null, "no pseudo-device");
  assert.equal(pseudoTarget(withDefault(OUTPUTS, "Default - Gone Headphones (USB Audio Device)")), null, "it names nothing");
  const hidden = OUTPUTS.map((d) => ({ ...d, label: "" }));
  assert.equal(pseudoTarget(hidden), null, "labels hidden: nothing can be matched");
});

test("siblingOutput: the earpiece of the microphone's own device", () => {
  const headsetMic = INPUTS.find((d) => d.deviceId === ID.headsetMic);
  assert.equal(siblingOutput(OUTPUTS, headsetMic).deviceId, ID.earphone);
  const laptopMic = INPUTS.find((d) => d.deviceId === ID.arrayMic);
  assert.equal(siblingOutput(OUTPUTS, laptopMic).deviceId, ID.speakers);
  const cableMic = INPUTS.find((d) => d.deviceId === ID.cableOut);
  assert.equal(siblingOutput(OUTPUTS, cableMic), null, "the cable's own outputs are skipped");
  const vmSibling = [out(ID.voicemeeter, "VoiceMeeter Input (VB-Audio VoiceMeeter VAIO)", "g1")];
  assert.equal(siblingOutput(vmSibling, mic("x", "Mic", "g1")), null, "another virtual output is skipped");
  const numbered = [out("a", "Headset Earphone (2- USB Audio Device)", "g"), out("b", "Headset Earphone (USB Audio Device)", "g")];
  assert.equal(siblingOutput(numbered, mic("m", "Headset Microphone", "g")).deviceId, "b", "a label without (2- first");
  assert.equal(siblingOutput(OUTPUTS, mic(ID.krisp, "Krisp Microphone (Krisp Audio)", "")), null, "no groupId");
  assert.equal(siblingOutput(OUTPUTS, null), null);
  const pseudoOnly = [out("default", "Default - Headset Earphone (2- USB Audio Device)", GROUP.headset)];
  assert.equal(siblingOutput(pseudoOnly, headsetMic), null, "never a pseudo-device");
});

// ---------- monitor and tone sinks ----------

test("headphonesFor: names hidden, stand-in, the mic's earpiece, Windows' default, refusals, in that order", () => {
  const headsetMic = INPUTS.find((d) => d.deviceId === ID.headsetMic);
  const krisp = INPUTS.find((d) => d.deviceId === ID.krisp);
  assert.deepEqual(headphonesFor(snapshot({ labelsVisible: false }), { mic: headsetMic }), { entry: null, how: null, refusal: "NAMES_HIDDEN" });
  assert.equal(headphonesFor(null).refusal, "NAMES_HIDDEN", "no snapshot yet");
  assert.equal(headphonesFor(snapshot({ labelsVisible: false }), { mic: headsetMic, standIn: true }).refusal, "NAMES_HIDDEN", "names hidden comes first");
  assert.equal(headphonesFor(snapshot(), { mic: headsetMic, standIn: true }).refusal, "STAND_IN_QUIET");
  const sib = headphonesFor(snapshot(), { mic: headsetMic });
  assert.equal(sib.how, "mic-sibling");
  assert.equal(sib.entry.deviceId, ID.earphone);
  assert.equal(sib.refusal, null);
  const def = headphonesFor(snapshot(), { mic: krisp });
  assert.equal(def.how, "default");
  assert.equal(def.entry.deviceId, ID.earphone);
  const cableDefault = snapshot({ outputs: withDefault(OUTPUTS, "Default - CABLE Input (VB-Audio Virtual Cable)") });
  assert.equal(headphonesFor(cableDefault, { mic: krisp }).refusal, "OUTPUT_IS_CABLE");
  assert.equal(headphonesFor(cableDefault, { mic: headsetMic }).how, "mic-sibling", "the earpiece comes before the default");
  const vmDefault = snapshot({ outputs: withDefault(OUTPUTS, "Default - VoiceMeeter Input (VB-Audio VoiceMeeter VAIO)") });
  assert.equal(headphonesFor(vmDefault, { mic: krisp }).refusal, "DEFAULT_IS_VIRTUAL");
  const nothing = snapshot({ outputs: OUTPUTS.filter((d) => d.deviceId !== "default") });
  assert.deepEqual(headphonesFor(nothing, { mic: krisp }), { entry: null, how: null, refusal: "NO_HEADPHONES" });
});

test("toneOutput: the real device behind Windows' default, or a refusal", () => {
  assert.deepEqual(toneOutput(snapshot()), { entry: OUTPUTS.find((d) => d.deviceId === ID.earphone), refusal: null });
  assert.equal(toneOutput(snapshot({ labelsVisible: false })).refusal, "NAMES_HIDDEN");
  assert.equal(toneOutput(snapshot({ outputs: withDefault(OUTPUTS, "Default - CABLE Input (VB-Audio Virtual Cable)") })).refusal, "OUTPUT_IS_CABLE");
  assert.equal(toneOutput(snapshot({ outputs: withDefault(OUTPUTS, "Default - CABLE In 16 Ch (VB-Audio Virtual Cable)") })).refusal, "DEFAULT_IS_VIRTUAL");
  assert.equal(toneOutput(snapshot({ outputs: OUTPUTS.filter((d) => d.deviceId !== "default") })).refusal, "NO_DEFAULT_OUTPUT");
  assert.equal(toneOutput(snapshot({ outputs: withDefault(OUTPUTS, "Default - Unknown (USB Audio Device)") })).refusal, "NO_DEFAULT_OUTPUT");
  assert.equal(toneOutput(null).refusal, "NAMES_HIDDEN");
});

// ---------- the microphone ----------

test("chooseMic: the saved microphone by id, then by label", () => {
  const byId = chooseMic(INPUTS, { saved: { deviceId: ID.arrayMic, label: "Microphone Array (Realtek(R) Audio)" } });
  assert.deepEqual({ id: byId.entry.deviceId, how: byId.how, standIn: byId.standIn, wantedMissing: byId.wantedMissing }, {
    id: ID.arrayMic,
    how: "saved-id",
    standIn: false,
    wantedMissing: false,
  });
  // New ids (site data cleared), the headset on another USB port ("(2- ") and Chromium's USB id.
  const replugged = [mic("default", "Default - Headset Microphone (3- Jabra EVOLVE 20 MS)"), mic("new-id", "Headset Microphone (3- Jabra EVOLVE 20 MS) (0b0e:0348)")];
  const byLabel = chooseMic(replugged, { saved: { deviceId: "old-id", label: "Headset Microphone (Jabra EVOLVE 20 MS)" } });
  assert.equal(byLabel.entry.deviceId, "new-id");
  assert.equal(byLabel.how, "saved-label");
  assert.equal(byLabel.standIn, false);
  const exact = chooseMic(INPUTS, { saved: { deviceId: "stale", label: "Microphone Array (Realtek(R) Audio)" } });
  assert.equal(exact.how, "saved-label");
  const german = chooseMic(INPUTS, { saved: { deviceId: "default", label: "Standard - Microphone Array (Realtek(R) Audio)" } });
  assert.equal(german.entry.deviceId, ID.arrayMic, "a label saved from a pseudo-device, in German");
});

test("chooseMic: the mic in use before when nothing is saved", () => {
  const wanted = INPUTS.find((d) => d.deviceId === ID.arrayMic);
  const same = chooseMic(INPUTS, { wanted });
  assert.equal(same.entry.deviceId, ID.arrayMic);
  assert.equal(same.how, "same");
  const sameByLabel = chooseMic(INPUTS, { wanted: { deviceId: "gone", label: "Microphone Array (Realtek(R) Audio)" } });
  assert.equal(sameByLabel.how, "same");
  assert.equal(sameByLabel.entry.deviceId, ID.arrayMic);
});

test("chooseMic: nothing saved → Windows' default, else the first usable one", () => {
  const def = chooseMic(INPUTS);
  assert.deepEqual([def.entry.deviceId, def.how, def.standIn, def.wantedMissing], [ID.headsetMic, "default", false, false]);
  const noPseudo = INPUTS.filter((d) => !PSEUDO_IDS.includes(d.deviceId));
  const first = chooseMic(noPseudo, { saved: { deviceId: "", label: "" }, wanted: null });
  assert.deepEqual([first.entry.deviceId, first.how], [ID.arrayMic, "first"]);
  // Windows' default microphone is the cable: never used; the communications one is, and it is "first", not "default".
  const cableDefault = INPUTS.map((d) => (d.deviceId === "default" ? { ...d, label: "Default - CABLE Output (VB-Audio Virtual Cable)" } : d));
  const comms = chooseMic(cableDefault);
  assert.equal(comms.entry.deviceId, ID.headsetMic);
  assert.equal(comms.how, "first");
});

test("chooseMic: the saved microphone is missing → a stand-in", () => {
  const gone = INPUTS.filter((d) => d.deviceId !== ID.arrayMic);
  const r = chooseMic(gone, { saved: { deviceId: ID.arrayMic, label: "Microphone Array (Realtek(R) Audio)" } });
  assert.deepEqual([r.entry.deviceId, r.how, r.standIn, r.wantedMissing], [ID.headsetMic, "stand-in", true, true]);
  const wantedGone = chooseMic(gone, { wanted: { deviceId: ID.arrayMic, label: "Microphone Array (Realtek(R) Audio)" } });
  assert.equal(wantedGone.how, "stand-in");
});

test("chooseMic: CABLE Output saved by hand is never used: a stand-in instead", () => {
  const r = chooseMic(INPUTS, { saved: { deviceId: ID.cableOut, label: "CABLE Output (VB-Audio Virtual Cable)" } });
  assert.deepEqual([r.entry.deviceId, r.how, r.standIn, r.wantedMissing], [ID.headsetMic, "stand-in", true, true]);
  const byIdOnly = chooseMic(INPUTS, { saved: { deviceId: ID.cableOut, label: "" } });
  assert.equal(byIdOnly.how, "stand-in", "found by id: still the cable");
  const loopback = chooseMic(INPUTS, { saved: { deviceId: ID.stereoMix, label: "Stereo Mix (Realtek(R) Audio)" } });
  assert.equal(loopback.how, "stand-in");
});

test("chooseMic: no usable microphone → none", () => {
  const virtualOnly = INPUTS.filter((d) => [ID.cableOut, ID.krisp, ID.stereoMix].includes(d.deviceId));
  assert.deepEqual(chooseMic(virtualOnly), { entry: null, how: "none", standIn: false, wantedMissing: false });
  assert.deepEqual(chooseMic(virtualOnly, { saved: { deviceId: ID.arrayMic, label: "x" } }), {
    entry: null,
    how: "none",
    standIn: false,
    wantedMissing: true,
  });
  assert.deepEqual(chooseMic([]), { entry: null, how: "none", standIn: false, wantedMissing: false });
});

test("chooseMic never returns a virtual microphone or a pseudo-device", () => {
  const stereoMixDefault = INPUTS.map((d) => (d.deviceId === "default" ? { ...d, label: "Default - Stereo Mix (Realtek(R) Audio)" } : d));
  const cases = [
    chooseMic(stereoMixDefault),
    chooseMic(INPUTS, { saved: { deviceId: ID.stereoMix, label: "Stereo Mix (Realtek(R) Audio)" } }),
    chooseMic(INPUTS.filter((d) => d.deviceId !== ID.headsetMic && d.deviceId !== ID.arrayMic)),
    chooseMic(INPUTS, { saved: { deviceId: "default", label: "Default - Stereo Mix (Realtek(R) Audio)" } }),
  ];
  for (const r of cases) {
    if (!r.entry) continue;
    assert.notEqual(r.entry.label, "Stereo Mix (Realtek(R) Audio)");
    assert.ok(!PSEUDO_IDS.includes(r.entry.deviceId));
    assert.ok(![ID.cableOut, ID.krisp, ID.stereoMix].includes(r.entry.deviceId));
  }
  assert.equal(cases[2].entry, null, "only virtual microphones left");
});

// ---------- the output ----------

test("chooseOutput: automatic, a saved override by id or label, a missing override", () => {
  const auto = chooseOutput(OUTPUTS);
  assert.deepEqual([auto.entry.deviceId, auto.how, auto.savedMissing], [ID.cableIn, "auto", false]);
  const byId = chooseOutput(OUTPUTS, { saved: { deviceId: ID.voicemeeter, label: "VoiceMeeter Input (VB-Audio VoiceMeeter VAIO)" } });
  assert.deepEqual([byId.entry.deviceId, byId.how], [ID.voicemeeter, "saved-id"]);
  const byLabel = chooseOutput(OUTPUTS, { saved: { deviceId: "old", label: "CABLE In 16 Ch (2- VB-Audio Virtual Cable)" } });
  assert.deepEqual([byLabel.entry.deviceId, byLabel.how], [ID.cableIn16, "saved-label"]);
  const missing = chooseOutput(OUTPUTS, { saved: { deviceId: "gone", label: "Other Cable (Some Driver)" } });
  assert.deepEqual([missing.entry.deviceId, missing.how, missing.savedMissing], [ID.cableIn, "auto", true]);
  const none = chooseOutput(OUTPUTS.filter((d) => d.deviceId !== ID.cableIn));
  assert.deepEqual(none, { entry: null, how: "none", savedMissing: false });
  const noneMissing = chooseOutput([], { saved: { deviceId: "gone", label: "" } });
  assert.deepEqual(noneMissing, { entry: null, how: "none", savedMissing: true });
  const pseudo = chooseOutput(OUTPUTS, { saved: { deviceId: "default", label: "Default - Headset Earphone (2- USB Audio Device)" } });
  assert.equal(pseudo.entry.deviceId, ID.earphone, "never the pseudo-device itself");
});

// ---------- names in results ----------

const REPORT = [
  ["Headset Microphone (Jabra EVOLVE 20 MS) (0b0e:0348)", "Headset Microphone ([name hidden])"],
  ["Microphone (2- USB Audio Device)", "Microphone (2- USB Audio Device)"],
  ["Priya's AirPods", "[name hidden]"],
  ["Default - CABLE Input (VB-Audio Virtual Cable)", "Default - CABLE Input (VB-Audio Virtual Cable)"],
  ["CABLE Output (2- VB-Audio Virtual Cable)", "CABLE Output (2- VB-Audio Virtual Cable)"],
  ["CABLE In 16 Ch (VB-Audio Virtual Cable)", "CABLE In 16 Ch (VB-Audio Virtual Cable)"],
  ["Priya mic (VB-Audio Virtual Cable)", RENAMED_CABLE],
  ["Default - Priya mic (VB-Audio Virtual Cable)", `Default - ${RENAMED_CABLE}`],
  ["Communications - Priya mic (2- VB-Audio Virtual Cable)", `Communications - ${RENAMED_CABLE}`],
  ["Fake Audio Input 1", "[name hidden]"],
  ["Default - Fake Audio Input 1", "Default - [name hidden]"],
  ["Speakers (Realtek(R) Audio)", "Speakers (Realtek(R) Audio)"],
  ["Speakers/Headphones (Realtek High Definition Audio)", "Speakers/Headphones (Realtek High Definition Audio)"],
  ["Digital Audio (S/PDIF) (High Definition Audio Device)", "Digital Audio (S/PDIF) (High Definition Audio Device)"],
  ["Microphone Array (Intel® Smart Sound Technology for Digital Microphones)", "Microphone Array (Intel® Smart Sound Technology for Digital Microphones)"],
  ["Headset (Priya's Buds2 Hands-Free AG Audio)", "Headset ([name hidden])"],
  ["Headphones (2- Priya's AirPods Stereo)", "Headphones (2- [name hidden])"],
  ["Priya's Room Mic (USB Audio Device)", "[name hidden] (USB Audio Device)"],
  ["Microphone (Realtek(R) Audio) (2)", "Microphone (Realtek(R) Audio) (2)"],
  ["Stereo Mix (Realtek(R) Audio)", "Stereo Mix (Realtek(R) Audio)"],
  ["Microphone", "Microphone"],
  ["Standard - Headset Microphone (USB Audio Device)", "[name hidden] (USB Audio Device)"],
  ["", "(no name)"],
  [null, "(no name)"],
  [undefined, "(no name)"],
];

test("reportLabel keeps VB-CABLE's and Windows' generic names and hides the rest", () => {
  for (const [label, want] of REPORT) assert.equal(reportLabel(label), want, JSON.stringify(label));
});

test("reportLabel never lets a device id or a hidden word through", () => {
  const id = hexId();
  const nasty = [
    `Headset (${id})`,
    `${id}`,
    `Microphone (Conexant ${id})`,
    `Priya ${id} (VB-Audio Virtual Cable)`,
    "Priya mic (VB-Audio Virtual Cable)",
    "Default - Priya mic (VB-Audio Virtual Cable)",
    "Priya's AirPods",
    "Headset Earphone (Priya's Jabra) (0b0e:0348)",
  ];
  for (const label of nasty) {
    const got = reportLabel(label);
    assert.ok(!/[0-9a-f]{64}/i.test(got), `${label} → ${got}`);
    assert.ok(!/priya|jabra|airpods/i.test(got), `${label} → ${got}`);
  }
});

test("labelFlags", () => {
  assert.deepEqual(labelFlags("CABLE Input (VB-Audio Virtual Cable)"), { cable: true, virtual: true, usb: false, bluetooth: false });
  assert.deepEqual(labelFlags("Accent Mic (VB-Audio Virtual Cable)"), { cable: true, virtual: true, usb: false, bluetooth: false });
  assert.deepEqual(labelFlags("CABLE In 16 Ch (VB-Audio Virtual Cable)").cable, true);
  assert.deepEqual(labelFlags("Headset Microphone (2- USB Audio Device)"), { cable: false, virtual: false, usb: true, bluetooth: false });
  assert.equal(labelFlags("Headset (WH-1000XM4 Hands-Free AG Audio)").bluetooth, true);
  assert.equal(labelFlags("Headset (Bluetooth Headset)").bluetooth, true);
  assert.equal(labelFlags("Headphones (Priya's AirPods)").bluetooth, true);
  assert.equal(labelFlags("Headset (Galaxy Buds)").bluetooth, true);
  assert.equal(labelFlags("Microphone (BT Headset)").bluetooth, true);
  assert.equal(labelFlags("Microphone (Subtle Audio)").bluetooth, false, "\\bbt\\b needs a whole word");
  assert.equal(labelFlags("Krisp Microphone (Krisp Audio)").virtual, true);
  assert.equal(labelFlags("VoiceMeeter Input (VB-Audio VoiceMeeter VAIO)").virtual, true);
  assert.equal(labelFlags("Line 1 (Virtual Audio Cable)").virtual, true);
  assert.equal(labelFlags("Stereo Mix (Realtek(R) Audio)").virtual, true);
  assert.deepEqual(labelFlags(null), { cable: false, virtual: false, usb: false, bluetooth: false });
});

test("micSettingsReport: allOff only when every processing is exactly false", () => {
  const off = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: 48000, channelCount: 1, latency: 0.01 };
  assert.deepEqual(micSettingsReport(off), {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    voiceIsolation: null,
    sampleRateHz: 48000,
    channelCount: 1,
    latencyMs: 10,
    allOff: true,
  });
  assert.equal(micSettingsReport({ ...off, voiceIsolation: false }).allOff, true);
  assert.equal(micSettingsReport({ ...off, voiceIsolation: true }).allOff, false);
  assert.equal(micSettingsReport({ ...off, echoCancellation: "remote-only" }).allOff, false, "a string means some echo cancellation is on");
  assert.equal(micSettingsReport({ ...off, echoCancellation: "all" }).echoCancellation, "all");
  assert.equal(micSettingsReport({ ...off, autoGainControl: undefined }).allOff, false, "not reported is not off");
  assert.equal(micSettingsReport({ ...off, latency: 0.0123 }).latencyMs, 12.3);
  assert.equal(micSettingsReport({ ...off, latency: undefined }).latencyMs, null);
  assert.deepEqual(micSettingsReport(null), {
    echoCancellation: null,
    noiseSuppression: null,
    autoGainControl: null,
    voiceIsolation: null,
    sampleRateHz: null,
    channelCount: null,
    latencyMs: null,
    allOff: false,
  });
});

// ---------- warnings ----------

test("WARNINGS: the feedback texts are devices-match's own; the rest are plain texts or functions", () => {
  assert.equal(WARNINGS.MIC_IS_CABLE, feedbackWarnings({ micLabel: "CABLE Output (VB-Audio Virtual Cable)" })[0]);
  assert.equal(WARNINGS.OUTPUT_IS_CABLE, feedbackWarnings({ defaultOutputLabel: "CABLE Input (VB-Audio Virtual Cable)" })[0]);
  assert.equal(WARNINGS.INPUT_IS_CABLE, feedbackWarnings({ defaultInputLabel: "CABLE Output (VB-Audio Virtual Cable)" })[0]);
  assert.equal(WARNINGS.INPUT_IS_LOOPBACK, feedbackWarnings({ defaultInputLabel: "Stereo Mix (Realtek(R) Audio)" })[0]);
  for (const [code, value] of Object.entries(WARNINGS)) {
    const text = typeof value === "function" ? value("A", "B") : value;
    assert.equal(typeof text, "string", code);
    assert.ok(text.length > 20, code);
    assert.ok(!/[0-9a-f]{64}/.test(text), code);
    const sentences = text.split(/[.!?](?:\s|$)/).filter((s) => s.trim()).length;
    assert.ok(sentences <= 3, `${code}: ${sentences} sentences`);
  }
  assert.ok(Object.isFrozen(WARNINGS));
  assert.equal(WARNINGS.DEFAULT_RATE_LOW(16000).includes("16 kHz"), true);
  assert.equal(WARNINGS.CABLE_RATE(44100).includes("44.1 kHz"), true);
  assert.equal(
    WARNINGS.STAND_IN("Headset Microphone (USB Audio Device)", "Microphone Array (Realtek(R) Audio)"),
    "Your microphone “Headset Microphone (USB Audio Device)” is not connected, so the app uses “Microphone Array (Realtek(R) Audio)” for now. Plug it back in: the app switches back by itself.",
  );
});

const QUIET = {
  micLabel: "Headset Microphone (2- USB Audio Device)",
  savedMicLabel: "Headset Microphone (2- USB Audio Device)",
  standIn: false,
  outputFound: true,
  savedOutputMissing: false,
  savedOutputLabel: "",
  defaultInputLabel: "Default - Headset Microphone (2- USB Audio Device)",
  defaultOutputLabel: "Default - Headset Earphone (2- USB Audio Device)",
  commsInputLabel: "Communications - Headset Microphone (2- USB Audio Device)",
  commsOutputLabel: "Communications - Headset Earphone (2- USB Audio Device)",
  defaultOutputRateHz: 48000,
  cableRateHz: 48000,
};
const codes = (list) => list.map((w) => w.code);

test("deviceWarnings: none for a good set-up", () => {
  assert.deepEqual(deviceWarnings(QUIET), []);
});

test("deviceWarnings: every warning, in order, with its own text", () => {
  const all = deviceWarnings({
    micLabel: "Headset (Priya's WH-1000XM4 Hands-Free AG Audio)",
    savedMicLabel: "CABLE Output (VB-Audio Virtual Cable)",
    standIn: true,
    outputFound: false,
    savedOutputMissing: true,
    savedOutputLabel: "Priya's Speakers (USB Audio Device)",
    defaultInputLabel: "Default - CABLE Output (VB-Audio Virtual Cable)",
    defaultOutputLabel: "Default - CABLE Input (VB-Audio Virtual Cable)",
    commsInputLabel: "Communications - CABLE Output (VB-Audio Virtual Cable)",
    commsOutputLabel: "Communications - CABLE Input (VB-Audio Virtual Cable)",
    defaultOutputRateHz: 16000,
    cableRateHz: 44100,
  });
  assert.deepEqual(codes(all), [
    "MIC_IS_CABLE",
    "OUTPUT_IS_CABLE",
    "INPUT_IS_CABLE",
    "COMMS_OUTPUT_IS_CABLE",
    "COMMS_INPUT_IS_CABLE",
    "STAND_IN",
    "OUTPUT_OVERRIDE_MISSING",
    "NO_CABLE",
    "DEFAULT_RATE_LOW",
    "CABLE_RATE",
    "BLUETOOTH_MIC",
  ]);
  for (const w of all) {
    const constant = WARNINGS[w.code];
    if (typeof constant === "string") assert.equal(w.text, constant, w.code);
  }
  assert.ok(all.find((w) => w.code === "DEFAULT_RATE_LOW").text.includes("16 kHz"));
  assert.ok(all.find((w) => w.code === "CABLE_RATE").text.includes("44.1 kHz"));
  assert.ok(all.find((w) => w.code === "STAND_IN").text.includes("Priya's WH-1000XM4"), "the page shows real names");
});

test("deviceWarnings: nameOf masks every label put into a text", () => {
  const list = deviceWarnings(
    {
      ...QUIET,
      micLabel: "Microphone Array (Realtek(R) Audio)",
      savedMicLabel: "Headset Microphone (Priya's Jabra)",
      standIn: true,
      savedOutputMissing: true,
      savedOutputLabel: "Priya's Cable (Priya Audio)",
    },
    reportLabel,
  );
  assert.deepEqual(codes(list), ["STAND_IN", "OUTPUT_OVERRIDE_MISSING"]);
  for (const w of list) assert.ok(!/priya|jabra/i.test(w.text), w.text);
  assert.ok(list[0].text.includes("“Headset Microphone ([name hidden])”"));
  assert.ok(list[0].text.includes("“Microphone Array (Realtek(R) Audio)”"));
});

test("deviceWarnings: the stand-in names the microphone that is missing, saved or in use before", () => {
  const standIn = (fields, nameOf) =>
    deviceWarnings({ ...QUIET, micLabel: "Microphone Array (Realtek(R) Audio)", standIn: true, ...fields }, nameOf).find(
      (w) => w.code === "STAND_IN",
    ).text;
  const after = "is not connected, so the app uses “Microphone Array (Realtek(R) Audio)” for now. Plug it back in: the app switches back by itself.";
  // Nothing saved (the user never picked a microphone): the one in use before is the missing one.
  assert.equal(
    standIn({ savedMicLabel: "", wantedMicLabel: "Headset Microphone (2- USB Audio Device)" }),
    `Your microphone “Headset Microphone (2- USB Audio Device)” ${after}`,
  );
  assert.equal(
    standIn({ savedMicLabel: "", wantedMicLabel: "Headset Microphone (Priya's Jabra)" }, reportLabel),
    `Your microphone “Headset Microphone ([name hidden])” ${after}`,
    "masked for results",
  );
  // The saved one comes first.
  assert.ok(standIn({ savedMicLabel: "Microphone (USB Audio Device)", wantedMicLabel: "Headset (USB Audio Device)" }).startsWith("Your microphone “Microphone (USB Audio Device)”"));
  // No name known: no empty quotes, and no "(no name)" in results.
  for (const nameOf of [undefined, reportLabel]) {
    assert.equal(standIn({ savedMicLabel: "", wantedMicLabel: "  " }, nameOf), `Your microphone ${after}`);
    assert.equal(standIn({ savedMicLabel: "" }, nameOf), `Your microphone ${after}`);
  }
  assert.equal(WARNINGS.STAND_IN("", "B"), "Your microphone is not connected, so the app uses “B” for now. Plug it back in: the app switches back by itself.");
});

test("deviceWarnings: Windows' defaults, in any language, and loopbacks", () => {
  const w = (overrides) => codes(deviceWarnings({ ...QUIET, ...overrides }));
  assert.deepEqual(w({ defaultOutputLabel: "Default - CABLE Input (VB-Audio Virtual Cable)" }), ["OUTPUT_IS_CABLE"]);
  assert.deepEqual(w({ defaultInputLabel: "Standard - CABLE Output (VB-Audio Virtual Cable)" }), ["INPUT_IS_CABLE"]);
  assert.deepEqual(w({ commsInputLabel: "Communications - CABLE Output (VB-Audio Virtual Cable)" }), ["COMMS_INPUT_IS_CABLE"]);
  assert.deepEqual(w({ commsOutputLabel: "Communications - Accent Out (VB-Audio Virtual Cable)" }), ["COMMS_OUTPUT_IS_CABLE"]);
  assert.deepEqual(w({ defaultInputLabel: "Default - Stereo Mix (Realtek(R) Audio)" }), ["INPUT_IS_LOOPBACK"]);
  assert.deepEqual(w({ savedMicLabel: "CABLE Output (VB-Audio Virtual Cable)" }), ["MIC_IS_CABLE"]);
  assert.deepEqual(w({ defaultInputLabel: "", defaultOutputLabel: "", commsInputLabel: "", commsOutputLabel: "" }), [], "no pseudo-devices");
});

test("deviceWarnings: rates", () => {
  const w = (overrides) => codes(deviceWarnings({ ...QUIET, ...overrides }));
  assert.deepEqual(w({ defaultOutputRateHz: 16000 }), ["DEFAULT_RATE_LOW"]);
  assert.deepEqual(w({ defaultOutputRateHz: 44100 }), []);
  assert.deepEqual(w({ defaultOutputRateHz: null }), [], "not read yet");
  assert.deepEqual(w({ cableRateHz: 44100 }), ["CABLE_RATE"]);
  assert.deepEqual(w({ cableRateHz: null }), []);
  assert.deepEqual(w({ outputFound: false }), ["NO_CABLE"]);
});

test("device-choice.js is pure: no clock, timer, console or DOM", () => {
  const code = readFileSync(new URL("../src/core/device-choice.js", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.doesNotMatch(code, /Date\.now|performance\.|new Date|setTimeout|setInterval|requestAnimationFrame|console\.|document\.|window\.|navigator\.|globalThis/);
});
