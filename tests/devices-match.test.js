import test from "node:test";
import assert from "node:assert/strict";
import {
  VIRTUAL_MIC,
  feedbackWarnings,
  findCableInput,
  isCableInput,
  isCableOutput,
  normalizeLabel,
  pickMic,
  usableMics,
} from "../src/core/devices-match.js";
import { rng } from "./helpers/synth.js";

// Chromium's device ids: 64 hex digits per device and origin (seeded, so the same every run).
const rand = rng(20261126);
const hexId = () => Array.from({ length: 64 }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("");
const ID = {
  jabra: hexId(),
  jabra2: hexId(),
  array: hexId(),
  cableOut: hexId(),
  krisp: hexId(),
  sanas: hexId(),
  speakers: hexId(),
  earphone: hexId(),
  cableIn: hexId(),
};

const mic = (deviceId, label) => ({ deviceId, kind: "audioinput", label, groupId: "g" });
const out = (deviceId, label) => ({ deviceId, kind: "audiooutput", label, groupId: "g" });

/** A Windows laptop with a USB headset, VB-CABLE, Krisp and the Sanas desktop app, as Chromium lists it. */
const INPUTS = [
  mic("default", "Default - Headset Microphone (Jabra EVOLVE 20 MS)"),
  mic("communications", "Communications - Headset Microphone (Jabra EVOLVE 20 MS)"),
  mic(ID.array, "Microphone Array (Realtek(R) Audio)"),
  mic(ID.cableOut, "CABLE Output (VB-Audio Virtual Cable)"),
  mic(ID.jabra, "Headset Microphone (Jabra EVOLVE 20 MS)"),
  mic(ID.krisp, "Krisp Microphone (Krisp Audio)"),
  mic(ID.sanas, "Microphone (Sanas Microphone)"),
];
const OUTPUTS = [
  out("default", "Default - Speakers (Realtek(R) Audio)"),
  out("communications", "Communications - Headset Earphone (Jabra EVOLVE 20 MS)"),
  out(ID.speakers, "Speakers (Realtek(R) Audio)"),
  out(ID.earphone, "Headset Earphone (Jabra EVOLVE 20 MS)"),
  out(ID.cableIn, "CABLE Input (VB-Audio Virtual Cable)"),
];

const ids = (list) => list.map((d) => d.deviceId);

test("VIRTUAL_MIC: other apps' virtual microphones, never a real one", () => {
  const virtual = [
    "CABLE Output (VB-Audio Virtual Cable)",
    "Default - CABLE Output (VB-Audio Virtual Cable)",
    "Krisp Microphone (Krisp Audio)",
    "Microphone (Sanas Microphone)",
    "VoiceMeeter Output (VB-Audio VoiceMeeter VAIO)",
    "Microphone (Steam Streaming Microphone)",
    "CABLE-A Output (VB-Audio Cable A)",
  ];
  const real = [
    "Headset Microphone (Jabra EVOLVE 20 MS)",
    "Headset Microphone (2- Jabra EVOLVE 20 MS)",
    "Microphone Array (Realtek(R) Audio)",
    "Microphone (HD Pro Webcam C920) (046d:082d)",
    "Microphone (USB Audio Device)",
    "Headset (WH-1000XM4 Hands-Free AG Audio)",
  ];
  for (const label of virtual) assert.ok(VIRTUAL_MIC.test(label), label);
  for (const label of real) assert.ok(!VIRTUAL_MIC.test(label), label);
});

test("normalizeLabel drops what Windows and Chromium add around a device's name", () => {
  const base = "headset microphone (jabra evolve 20 ms)";
  for (const label of [
    "Headset Microphone (Jabra EVOLVE 20 MS)",
    "Default - Headset Microphone (Jabra EVOLVE 20 MS)",
    "Communications - Headset Microphone (Jabra EVOLVE 20 MS)",
    "Headset Microphone (2- Jabra EVOLVE 20 MS)",
    "Headset Microphone (Jabra EVOLVE 20 MS) (0b0e:0348)",
    "Default - Headset Microphone (12- Jabra EVOLVE 20 MS) (0b0e:0348)",
    "  Headset   Microphone (Jabra EVOLVE 20 MS)  ",
  ]) {
    assert.equal(normalizeLabel(label), base, label);
  }
  assert.equal(normalizeLabel("USB Microphone (2)"), "usb microphone");
  assert.equal(normalizeLabel("Microphone Array (Realtek(R) Audio)"), "microphone array (realtek(r) audio)");
  assert.equal(normalizeLabel("Line In (3-4 Channel)"), "line in (3-4 channel)", "only Windows' '2- ' numbering");
  assert.equal(normalizeLabel(undefined), "");
});

test("usableMics: real microphones only, in list order", () => {
  assert.deepEqual(ids(usableMics(INPUTS)), [ID.array, ID.jabra]);
  // The whole enumerateDevices() list: outputs are not microphones.
  assert.deepEqual(ids(usableMics([...INPUTS, ...OUTPUTS])), [ID.array, ID.jabra]);
  // Before the microphone permission Chromium lists one entry with no id and no label.
  assert.deepEqual(usableMics([mic("", "")]), []);
  assert.deepEqual(usableMics([{ deviceId: ID.jabra, label: "Headset Microphone (Jabra EVOLVE 20 MS)" }]).length, 1, "kind may be left out");
  for (const nothing of [[], undefined, null, "CABLE", [null, 3]]) assert.deepEqual(usableMics(nothing), []);
});

test("pickMic: the saved microphone by id, else by label, else Windows' choice, else the first", () => {
  assert.equal(pickMic(INPUTS, { deviceId: ID.array, label: "anything" }).deviceId, ID.array, "exact id first");
  // The ids changed (site data cleared): same label.
  assert.equal(pickMic(INPUTS, { deviceId: "gone", label: "Headset Microphone (Jabra EVOLVE 20 MS)" }).deviceId, ID.jabra);
  // Saved from the "Default - " pseudo-device, or with Chromium's USB id.
  assert.equal(pickMic(INPUTS, { deviceId: "default", label: "Default - Headset Microphone (Jabra EVOLVE 20 MS)" }).deviceId, ID.jabra);
  assert.equal(pickMic(INPUTS, { label: "Headset Microphone (Jabra EVOLVE 20 MS) (0b0e:0348)" }).deviceId, ID.jabra);
  assert.equal(pickMic(INPUTS, { label: "headset microphone (jabra evolve 20 ms)" }).deviceId, ID.jabra);
  // The headset came back on another USB port: Windows renamed it "(2- …)" with a new id.
  const moved = [mic(ID.array, "Microphone Array (Realtek(R) Audio)"), mic(ID.jabra2, "Headset Microphone (2- Jabra EVOLVE 20 MS)")];
  assert.equal(pickMic(moved, { deviceId: ID.jabra, label: "Headset Microphone (Jabra EVOLVE 20 MS)" }).deviceId, ID.jabra2);
  // ... and back again; with both present the exact label wins.
  assert.equal(pickMic([mic(ID.jabra, "Headset Microphone (Jabra EVOLVE 20 MS)")], { label: "Headset Microphone (2- Jabra EVOLVE 20 MS)" }).deviceId, ID.jabra);
  const both = [mic(ID.jabra, "Headset Microphone (Jabra EVOLVE 20 MS)"), mic(ID.jabra2, "Headset Microphone (2- Jabra EVOLVE 20 MS)")];
  assert.equal(pickMic(both, { label: "Headset Microphone (2- Jabra EVOLVE 20 MS)" }).deviceId, ID.jabra2);
  assert.equal(pickMic([mic(ID.array, "USB Microphone (2)")], { label: "USB Microphone" }).deviceId, ID.array, '" (2)" suffix');
});

test("pickMic never returns a virtual microphone or a pseudo-device", () => {
  // Saved: the cable (or Krisp). Not used even though it is there: Windows' real default instead.
  assert.equal(pickMic(INPUTS, { deviceId: ID.cableOut, label: "CABLE Output (VB-Audio Virtual Cable)" }).deviceId, ID.jabra);
  assert.equal(pickMic(INPUTS, { deviceId: ID.krisp, label: "Krisp Microphone (Krisp Audio)" }).deviceId, ID.jabra);
  // Nothing saved: what Windows uses by default, although the laptop array comes first in the list.
  assert.equal(pickMic(INPUTS).deviceId, ID.jabra);
  assert.equal(pickMic(INPUTS, null).deviceId, ID.jabra);
  // Windows' default microphone is the cable: its communications device, then the first real one.
  const cableDefault = [
    mic("default", "Default - CABLE Output (VB-Audio Virtual Cable)"),
    mic("communications", "Communications - Headset Microphone (Jabra EVOLVE 20 MS)"),
    ...INPUTS.slice(2),
  ];
  assert.equal(pickMic(cableDefault).deviceId, ID.jabra);
  assert.equal(pickMic([mic("default", "Default - CABLE Output (VB-Audio Virtual Cable)"), ...INPUTS.slice(2)]).deviceId, ID.array);
  assert.equal(pickMic(INPUTS.slice(2)).deviceId, ID.array, "no pseudo-devices: the first real one");
  // Only virtual microphones, or none at all.
  assert.equal(pickMic([INPUTS[0], INPUTS[3], INPUTS[5], INPUTS[6]]), null);
  assert.equal(pickMic([]), null);
  assert.equal(pickMic(undefined, { deviceId: ID.jabra }), null);
});

test("findCableInput: the real CABLE Input entry, never a pseudo-device", () => {
  assert.equal(findCableInput(OUTPUTS).deviceId, ID.cableIn);
  assert.equal(findCableInput([...INPUTS, ...OUTPUTS]).deviceId, ID.cableIn);
  // Windows' default playback device is the cable (wrong, but it happens): still the real entry.
  const cableDefault = [out("default", "Default - CABLE Input (VB-Audio Virtual Cable)"), out("communications", "Communications - CABLE Input (VB-Audio Virtual Cable)"), ...OUTPUTS.slice(2)];
  assert.equal(findCableInput(cableDefault).deviceId, ID.cableIn);
  assert.equal(findCableInput(cableDefault.slice(0, 2)), null, "only pseudo-devices: not usable");
  // Not installed; only the 16-channel variant; microphones passed by mistake.
  assert.equal(findCableInput(OUTPUTS.slice(0, 4)), null);
  assert.equal(findCableInput([out(hexId(), "CABLE In 16 Ch (VB-Audio Virtual Cable)")]), null);
  assert.equal(findCableInput(INPUTS), null);
  assert.equal(findCableInput(undefined), null);
  // Listed twice (reinstalled): the un-numbered one, which pairs with the "CABLE Output" the meeting app shows.
  const twice = [out(hexId(), "CABLE Input (2- VB-Audio Virtual Cable)"), out(ID.cableIn, "CABLE Input (VB-Audio Virtual Cable)")];
  assert.equal(findCableInput(twice).deviceId, ID.cableIn);
  assert.ok(findCableInput([twice[0]]), "the numbered one when it is the only one");
});

test("Windows in another language: 'Standard - …', 'Par défaut - …' pseudo-devices are read like 'Default - …'", () => {
  // Chromium writes the word for "Default"/"Communications" in Windows' display language, then " - ".
  for (const [def, comm] of [
    ["Standard", "Kommunikation"],
    ["Par défaut", "Communications"],
    ["Predeterminado", "Comunicaciones"],
    ["Значение по умолчанию", "Связь"],
  ]) {
    const inputs = [
      mic("default", `${def} - Headset Microphone (Jabra EVOLVE 20 MS)`),
      mic("communications", `${comm} - Headset Microphone (Jabra EVOLVE 20 MS)`),
      ...INPUTS.slice(2),
    ];
    assert.equal(pickMic(inputs).deviceId, ID.jabra, `${def}: Windows' default, not the first in the list`);
    // Saved from the pseudo-device; Windows' default has moved to the laptop's array since.
    const moved = [mic("default", `${def} - Microphone Array (Realtek(R) Audio)`), ...INPUTS.slice(2)];
    assert.equal(pickMic(moved, { deviceId: "default", label: `${def} - Headset Microphone (Jabra EVOLVE 20 MS)` }).deviceId, ID.jabra, def);
    assert.equal(pickMic(moved).deviceId, ID.array, `${def}: the new default`);
    // The cable as Windows' default devices, and as the app's microphone.
    const warnings = feedbackWarnings({
      micLabel: `${def} - CABLE Output (VB-Audio Virtual Cable)`,
      defaultInputLabel: `${def} - CABLE Output (VB-Audio Virtual Cable)`,
      defaultOutputLabel: `${def} - CABLE Input (VB-Audio Virtual Cable)`,
    });
    assert.equal(warnings.length, 3, def);
    const outputs = [out("default", `${def} - CABLE Input (VB-Audio Virtual Cable)`), ...OUTPUTS.slice(2)];
    assert.equal(findCableInput(outputs).deviceId, ID.cableIn, def);
  }
  // A device whose own name has " - " in it is only cut at the first one.
  const dashed = [mic("default", "Standard - Mic - USB (C-Media(R) Audio)"), mic(ID.array, "Mic - USB (C-Media(R) Audio)")];
  assert.equal(pickMic([...dashed, mic(ID.jabra, "Headset Microphone (Jabra EVOLVE 20 MS)")]).deviceId, ID.array);
});

test("two identical headsets: Windows' default is found by its exact label, '(2- …)' included", () => {
  const twins = [
    mic("default", "Default - Headset Microphone (2- Jabra EVOLVE 20 MS)"),
    mic("communications", "Communications - Headset Microphone (Jabra EVOLVE 20 MS)"),
    mic(ID.jabra, "Headset Microphone (Jabra EVOLVE 20 MS)"),
    mic(ID.jabra2, "Headset Microphone (2- Jabra EVOLVE 20 MS)"),
  ];
  assert.equal(pickMic(twins).deviceId, ID.jabra2);
  assert.equal(pickMic(twins.slice(1)).deviceId, ID.jabra, "the communications device, un-numbered");
  assert.equal(pickMic(twins, { deviceId: "default", label: "Standard - Headset Microphone (2- Jabra EVOLVE 20 MS)" }).deviceId, ID.jabra2);
});

test("voice changers and voice filters are virtual microphones too", () => {
  const virtual = [
    "Microphone (Voicemod Virtual Audio Device (WDM))",
    "Microphone (NVIDIA Broadcast)",
    "Microphone (NVIDIA RTX Voice)",
    "Wave Link Stream (Elgato Wave:3)",
    "Microphone (Microsoft Teams Audio)",
    "Microphone (MorphVOX Audio)",
    "Line 1 (Virtual Audio Cable)",
    "Voice.ai Audio Cable (Voice.ai)",
  ];
  for (const label of virtual) {
    assert.ok(VIRTUAL_MIC.test(label), label);
    // Windows' default microphone is the voice changer: the real headset instead, never the changer.
    const inputs = [mic("default", `Default - ${label}`), mic(hexId(), label), mic(ID.jabra, "Headset Microphone (Jabra EVOLVE 20 MS)")];
    assert.equal(pickMic(inputs).deviceId, ID.jabra, label);
  }
  for (const label of ["Microphone (Elgato Wave:3)", "Microphone (Virtual Desktop Audio)", "Microphone (Yeti Stereo Microphone)", "Microphone (Shure MV7)"]) {
    assert.ok(!VIRTUAL_MIC.test(label), label);
  }
});

test("a cable renamed in Windows' sound settings is still the cable", () => {
  // Windows lets the user rename an endpoint; the driver's name in brackets stays.
  const renamedIn = out(ID.cableIn, "Accent Out (VB-Audio Virtual Cable)");
  assert.equal(findCableInput([...OUTPUTS.slice(0, 4), renamedIn]).deviceId, ID.cableIn);
  assert.equal(findCableInput([out(hexId(), "CABLE Input (2- VB-Audio Virtual Cable)"), renamedIn]).deviceId, ID.cableIn, "the un-numbered one");
  assert.ok(isCableOutput("Interview Mic (VB-Audio Virtual Cable)"));
  assert.ok(isCableInput("Accent Out (VB-Audio Virtual Cable)"));
  assert.deepEqual(usableMics([mic(hexId(), "Interview Mic (VB-Audio Virtual Cable)")]), []);
  const warnings = feedbackWarnings({
    micLabel: "Interview Mic (VB-Audio Virtual Cable)",
    defaultInputLabel: "Default - Interview Mic (VB-Audio Virtual Cable)",
    defaultOutputLabel: "Standard - Accent Out (VB-Audio Virtual Cable)",
  });
  assert.equal(warnings.length, 3);
  // Still not the 16-channel endpoint, and not VB-Audio's other cables.
  assert.equal(findCableInput([out(hexId(), "CABLE In 16 Ch (VB-Audio Virtual Cable)")]), null);
  assert.equal(findCableInput([out(hexId(), "CABLE-A Input (VB-Audio Cable A)")]), null);
  assert.ok(!isCableInput("CABLE Output (VB-Audio Virtual Cable)") && !isCableOutput("CABLE Input (VB-Audio Virtual Cable)"));
});

test("feedbackWarnings: set-ups that loop the audio back, in plain English", () => {
  const fine = { micLabel: "Headset Microphone (Jabra EVOLVE 20 MS)", defaultInputLabel: "Default - Headset Microphone (Jabra EVOLVE 20 MS)", defaultOutputLabel: "Default - Headset Earphone (Jabra EVOLVE 20 MS)" };
  assert.deepEqual(feedbackWarnings(fine), []);
  assert.deepEqual(feedbackWarnings({ ...fine, micLabel: "Krisp Microphone (Krisp Audio)" }), [], "not a loop (pickMic avoids it anyway)");

  const micIsCable = feedbackWarnings({ ...fine, micLabel: "CABLE Output (VB-Audio Virtual Cable)" });
  assert.equal(micIsCable.length, 1);
  assert.match(micIsCable[0], /CABLE Output/);
  assert.match(micIsCable[0], /won't use it/);
  assert.ok(isCableOutput("CABLE Output (VB-Audio Virtual Cable)"), "the caller refuses it with isCableOutput");

  const playsIntoCable = feedbackWarnings({ ...fine, defaultOutputLabel: "Default - CABLE Input (VB-Audio Virtual Cable)" });
  assert.equal(playsIntoCable.length, 1);
  assert.match(playsIntoCable[0], /CABLE Input/);
  assert.match(playsIntoCable[0], /default playback device/);

  const listensToCable = feedbackWarnings({ ...fine, defaultInputLabel: "Default - CABLE Output (VB-Audio Virtual Cable)" });
  assert.equal(listensToCable.length, 1);
  assert.match(listensToCable[0], /default microphone is “CABLE Output”/);

  const all = feedbackWarnings({
    micLabel: "Default - CABLE Output (VB-Audio Virtual Cable)",
    defaultInputLabel: "CABLE Output (2- VB-Audio Virtual Cable)",
    defaultOutputLabel: "CABLE Input (VB-Audio Virtual Cable)",
  });
  assert.deepEqual(all, [micIsCable[0], playsIntoCable[0], listensToCable[0]]);
  assert.deepEqual(feedbackWarnings({}), []);
  assert.deepEqual(feedbackWarnings(), []);
  assert.ok(isCableInput("CABLE Input (VB-Audio Virtual Cable)") && !isCableInput("CABLE Output (VB-Audio Virtual Cable)"));
});
