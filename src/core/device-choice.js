/**
 * Which devices the app uses, where its own sounds may play, and what is
 * safe to say about a device in results and logs.
 *
 * The voice goes from the user's real microphone into VB-CABLE's "CABLE
 * Input"; the meeting app listens to "CABLE Output". The microphone is the
 * one the user saved, found again by its id or its name. When it is
 * unplugged, another real microphone stands in for it until it comes back,
 * and the app says so. A virtual microphone (CABLE Output, Krisp, Stereo
 * Mix and the like) is never used: it would loop the meeting's audio back
 * into itself or convert the voice twice.
 *
 * Beeps and previews must reach the user's headphones and never the cable.
 * They go to the earpiece of the headset whose microphone is in use (same
 * groupId), else to the real device behind Windows' default playback device,
 * and they are refused when that device is the cable or another virtual
 * device, when device names are hidden, or while a stand-in microphone is in
 * use (the headset is unplugged, so a beep would come out of the laptop's
 * speakers and reach the meeting through the laptop's microphone).
 *
 * Device names can hold a person's name ("Priya's AirPods"). reportLabel()
 * keeps only VB-CABLE's own endpoint names and generic Windows endpoint and
 * driver words, and hides everything else.
 *
 * Pure: device lists come in as arrays of {deviceId, groupId?, kind?, label}.
 * No DOM, no clock.
 */
import {
  VIRTUAL_MIC,
  feedbackWarnings,
  findCableInput,
  isCableInput,
  isCableOutput,
  normalizeLabel,
  pickMic,
  usableMics,
} from "./devices-match.js";
import { redact } from "./redact.js";

/** Chromium's pseudo-devices that follow Windows' default and default communications device. */
export const PSEUDO_IDS = Object.freeze(["default", "communications"]);

/** What reportLabel() puts in place of a name that could be personal. */
export const HIDDEN_NAME = "[name hidden]";

/** What reportLabel() puts in place of a VB-CABLE endpoint the user renamed. */
export const RENAMED_CABLE = "[renamed] (VB-Audio Virtual Cable)";

/** Windows' numbering of a second device of the same kind: "(2- …)". */
const NUMBERED = /\(\d{1,2}- /;

/** Words in the name of a playback device that is not a real one (besides VB-CABLE's own endpoints). */
const VIRTUAL_OUTPUT = /vb-audio|voicemeeter|virtual/i;

/** The entries of a device list of one kind (entries without `kind` are taken as that kind). */
function ofKind(devices, kind) {
  const list = devices && typeof devices[Symbol.iterator] === "function" ? [...devices] : [];
  return list.filter((d) => d !== null && typeof d === "object" && (d.kind === undefined || d.kind === kind));
}

/** Any objects of a device list, whatever their kind. */
function entries(devices) {
  const list = devices && typeof devices[Symbol.iterator] === "function" ? [...devices] : [];
  return list.filter((d) => d !== null && typeof d === "object");
}

/** A device the app can open by id: not a pseudo-device, and not the id-less entry Chromium lists before permission. */
const isReal = (d) => typeof d.deviceId === "string" && d.deviceId !== "" && !PSEUDO_IDS.includes(d.deviceId);

const labelOf = (d) => (typeof d?.label === "string" ? d.label : "");

/**
 * The device's own label inside a pseudo-device's label: Chromium writes
 * "Default - X" with the first word in Windows' display language. Only the
 * first " - " counts: a device's own name may hold one too.
 */
function afterPrefix(label) {
  const text = String(label ?? "").trim();
  const at = text.indexOf(" - ");
  return at > 0 ? text.slice(at + 3).trim() : text;
}

/** The entry of `list` with this label: the exact label first, then the same label after normalizeLabel(). */
function byLabel(list, wanted) {
  const text = String(wanted ?? "").trim();
  if (!text) return null;
  const exact = list.find((d) => labelOf(d).trim() === text);
  if (exact) return exact;
  const want = normalizeLabel(text);
  return (want && list.find((d) => normalizeLabel(labelOf(d)) === want)) || null;
}

/**
 * VB-CABLE's capture side ("CABLE Output") among the inputs: a real entry
 * (never a pseudo-device, never an id-less entry) whose label isCableOutput()
 * accepts, which includes an endpoint the user renamed. The exact label
 * "CABLE Output (VB-Audio Virtual Cable)" first, then one without Windows'
 * "(2- " numbering, then the first. Null when VB-CABLE is not installed.
 * @param {Array<{deviceId: string, label: string, kind?: string}>} inputs
 * @returns {object|null} an entry of `inputs`
 */
export function findCableOutput(inputs) {
  const cables = ofKind(inputs, "audioinput").filter((d) => isReal(d) && isCableOutput(labelOf(d)));
  return (
    cables.find((d) => labelOf(d).trim().toLowerCase() === "cable output (vb-audio virtual cable)") ??
    cables.find((d) => !NUMBERED.test(labelOf(d))) ??
    cables[0] ??
    null
  );
}

/**
 * Real playback devices that look like a virtual cable: CABLE Input (also
 * renamed) or a name with "VB-Audio", "Voicemeeter" or "virtual" in it.
 * These are the only choices the "Send to" list offers besides Automatic:
 * picking the user's own headphones would make them hear themselves.
 * Order kept.
 * @param {Array<{deviceId: string, label: string, kind?: string}>} outputs
 * @returns {object[]} entries of `outputs`
 */
export function virtualOutputs(outputs) {
  return ofKind(outputs, "audiooutput").filter(
    (d) => isReal(d) && (isCableInput(labelOf(d)) || VIRTUAL_OUTPUT.test(labelOf(d))),
  );
}

/**
 * The real entry a pseudo-device names, in `list` (one kind): the label
 * after the first " - " of the pseudo-device's label (Chromium writes
 * "Default - X" in Windows' display language, "Standard - X" in German),
 * exact first, then by normalizeLabel(). Never a pseudo-device or an id-less
 * entry. Null when the pseudo-device is absent or names nothing in the list
 * (also when labels are hidden).
 * @param {Array<{deviceId: string, label: string}>} list
 * @param {string} [id] "default" or "communications"
 * @returns {object|null} an entry of `list`
 */
export function pseudoTarget(list, id = "default") {
  const all = entries(list);
  const pseudo = all.find((d) => d.deviceId === id);
  if (!pseudo) return null;
  return byLabel(all.filter(isReal), afterPrefix(labelOf(pseudo)));
}

/** True for a playback device that is the cable or another virtual output. */
const isVirtualOutput = (label) => isCableInput(label) || VIRTUAL_OUTPUT.test(String(label ?? ""));

/**
 * The real playback device inside the same physical device as `mic` (the
 * same non-empty groupId): a headset's earpiece. Never a pseudo-device, an
 * id-less entry, a cable or another virtual output. A label without Windows'
 * "(2- " numbering first. Null when there is none, or when `mic` is null or
 * has no groupId.
 * @param {Array<{deviceId: string, groupId?: string, label: string, kind?: string}>} outputs
 * @param {{groupId?: string}|null} mic
 * @returns {object|null} an entry of `outputs`
 */
export function siblingOutput(outputs, mic) {
  const group = mic && typeof mic.groupId === "string" ? mic.groupId : "";
  if (!group) return null;
  const same = ofKind(outputs, "audiooutput").filter(
    (d) => isReal(d) && d.groupId === group && !isVirtualOutput(labelOf(d)),
  );
  return same.find((d) => !NUMBERED.test(labelOf(d))) ?? same[0] ?? null;
}

/** True when a saved or wanted microphone ({deviceId, label}) has an id or a label. */
const hasTarget = (t) =>
  Boolean(t && typeof t === "object" && ((typeof t.deviceId === "string" && t.deviceId) || (typeof t.label === "string" && t.label.trim())));

/**
 * The microphone to open.
 * saved: the user's explicit choice from settings ({deviceId, label}; empty
 * strings mean none). wanted: the microphone in use before (kept in memory
 * by the graph; used when nothing is saved), or null.
 * Returns { entry, how, standIn, wantedMissing }:
 *  - The target is `saved` when it has an id or a label, else `wanted` when
 *    it has one, else there is none.
 *  - Target present among the usable microphones (same id, else the same
 *    label exactly, else the same label after normalizeLabel()) → how
 *    "saved-id" or "saved-label" (the target is `saved`) or "same" (the target
 *    is `wanted`); standIn false.
 *  - Target absent, or the target is a virtual microphone (CABLE Output saved
 *    by hand) → Windows' default microphone, then its default
 *    communications microphone, then the first usable one stands in: how
 *    "stand-in", standIn true, wantedMissing true.
 *  - No target → the same choice, how "default" when it is the device behind
 *    Windows' default, else "first".
 *  - No usable microphone → { entry: null, how: "none", standIn: false,
 *    wantedMissing: true when there was a target }.
 * Never returns a virtual microphone or a pseudo-device.
 * @param {Array<{deviceId: string, label: string, kind?: string}>} inputs
 * @param {{saved?: {deviceId?: string, label?: string}, wanted?: {deviceId?: string, label?: string}|null}} [options]
 * @returns {{entry: object|null, how: string, standIn: boolean, wantedMissing: boolean}}
 */
export function chooseMic(inputs, { saved = { deviceId: "", label: "" }, wanted = null } = {}) {
  const target = hasTarget(saved) ? saved : hasTarget(wanted) ? wanted : null;
  const isSaved = target !== null && target === saved;
  const mics = usableMics(inputs);
  if (!mics.length) return { entry: null, how: "none", standIn: false, wantedMissing: Boolean(target) };

  const fallback = () => pickMic(inputs, {});
  if (!target) {
    const entry = fallback();
    const behindDefault = pseudoTarget(ofKind(inputs, "audioinput"), "default");
    const how = entry && behindDefault && entry.deviceId === behindDefault.deviceId ? "default" : "first";
    return { entry, how: entry ? how : "none", standIn: false, wantedMissing: false };
  }

  const id = typeof target.deviceId === "string" ? target.deviceId : "";
  const rawLabel = typeof target.label === "string" ? target.label : "";
  // A label saved from a pseudo-device ("Standard - Headset Microphone (…)") names the device after its prefix.
  const label = PSEUDO_IDS.includes(id) ? afterPrefix(rawLabel) : rawLabel;
  const real = ofKind(inputs, "audioinput").filter(isReal);
  const sameAs = real.find((d) => id && d.deviceId === id) ?? byLabel(real, label);
  const virtual =
    VIRTUAL_MIC.test(label) || isCableOutput(label) || (sameAs !== null && sameAs !== undefined && VIRTUAL_MIC.test(labelOf(sameAs)));

  if (!virtual) {
    const byId = id ? mics.find((d) => d.deviceId === id) : undefined;
    if (byId) return { entry: byId, how: isSaved ? "saved-id" : "same", standIn: false, wantedMissing: false };
    const named = byLabel(mics, label);
    if (named) return { entry: named, how: isSaved ? "saved-label" : "same", standIn: false, wantedMissing: false };
  }
  const entry = fallback();
  return entry
    ? { entry, how: "stand-in", standIn: true, wantedMissing: true }
    : { entry: null, how: "none", standIn: false, wantedMissing: true };
}

/**
 * The playback device for the voice. saved: the user's override
 * ({deviceId, label}; empty strings mean automatic).
 * Returns { entry, how: "saved-id" | "saved-label" | "auto" | "none", savedMissing }:
 *  - override set and found among the real outputs by id, else by label
 *    (exact, then after normalizeLabel()) → "saved-id" / "saved-label";
 *  - override set but absent → CABLE Input (findCableInput), how "auto" (or
 *    "none" without the cable), savedMissing true;
 *  - no override → CABLE Input → "auto" (or "none").
 * @param {Array<{deviceId: string, label: string, kind?: string}>} outputs
 * @param {{saved?: {deviceId?: string, label?: string}}} [options]
 * @returns {{entry: object|null, how: string, savedMissing: boolean}}
 */
export function chooseOutput(outputs, { saved = { deviceId: "", label: "" } } = {}) {
  const auto = (savedMissing) => {
    const entry = findCableInput(outputs);
    return { entry, how: entry ? "auto" : "none", savedMissing };
  };
  if (!hasTarget(saved)) return auto(false);
  const real = ofKind(outputs, "audiooutput").filter(isReal);
  const id = typeof saved.deviceId === "string" ? saved.deviceId : "";
  const byId = id ? real.find((d) => d.deviceId === id) : undefined;
  if (byId) return { entry: byId, how: "saved-id", savedMissing: false };
  const label = PSEUDO_IDS.includes(id) ? afterPrefix(saved.label) : saved.label;
  const named = byLabel(real, label);
  if (named) return { entry: named, how: "saved-label", savedMissing: false };
  return auto(true);
}

/**
 * Where the monitor plays beeps and previews. snapshot: the graph's device
 * snapshot ({labelsVisible, outputs, …}); mic: the microphone entry in use;
 * standIn: that microphone is a stand-in.
 * → { entry, how: "mic-sibling" | "default" | null, refusal: null | code }, in this order:
 *  1. names hidden (or no snapshot yet) → refusal "NAMES_HIDDEN";
 *  2. a stand-in microphone → refusal "STAND_IN_QUIET";
 *  3. the earpiece of the microphone's own device → how "mic-sibling";
 *  4. the real device behind Windows' default playback device: the cable →
 *     refusal "OUTPUT_IS_CABLE"; another virtual output → "DEFAULT_IS_VIRTUAL";
 *     else how "default";
 *  5. else refusal "NO_HEADPHONES".
 * @returns {{entry: object|null, how: string|null, refusal: string|null}}
 */
export function headphonesFor(snapshot, { mic = null, standIn = false } = {}) {
  const refuse = (refusal) => ({ entry: null, how: null, refusal });
  if (!snapshot || !snapshot.labelsVisible) return refuse("NAMES_HIDDEN");
  if (standIn) return refuse("STAND_IN_QUIET");
  const sibling = siblingOutput(snapshot.outputs, mic);
  if (sibling) return { entry: sibling, how: "mic-sibling", refusal: null };
  const target = pseudoTarget(ofKind(snapshot.outputs, "audiooutput"), "default");
  if (!target) return refuse("NO_HEADPHONES");
  if (isCableInput(labelOf(target))) return refuse("OUTPUT_IS_CABLE");
  if (VIRTUAL_OUTPUT.test(labelOf(target))) return refuse("DEFAULT_IS_VIRTUAL");
  return { entry: target, how: "default", refusal: null };
}

/**
 * The tone context's device (its clock): the real device behind Windows'
 * default playback device, whose clock the SDK's AudioRouter uses for the
 * converted voice in Step 7. → { entry, refusal }: refusal "NAMES_HIDDEN",
 * "OUTPUT_IS_CABLE", "DEFAULT_IS_VIRTUAL" or "NO_DEFAULT_OUTPUT" (no
 * pseudo-device, or it names nothing), else null.
 * @returns {{entry: object|null, refusal: string|null}}
 */
export function toneOutput(snapshot) {
  const refuse = (refusal) => ({ entry: null, refusal });
  if (!snapshot || !snapshot.labelsVisible) return refuse("NAMES_HIDDEN");
  const target = pseudoTarget(ofKind(snapshot.outputs, "audiooutput"), "default");
  if (!target) return refuse("NO_DEFAULT_OUTPUT");
  if (isCableInput(labelOf(target))) return refuse("OUTPUT_IS_CABLE");
  if (VIRTUAL_OUTPUT.test(labelOf(target))) return refuse("DEFAULT_IS_VIRTUAL");
  return { entry: target, refusal: null };
}

/** A Bluetooth device by its name: hands-free profiles, "Bluetooth", "BT", AirPods, "… Buds". */
const BLUETOOTH = /hands-free|bluetooth|\bbt\b|airpods|buds\b/i;

/**
 * What a label says about its device: { cable: one of VB-CABLE's endpoints
 * (also renamed), virtual: a virtual microphone or virtual output, usb: "USB"
 * in the name, bluetooth: a Bluetooth headset's name }.
 * @param {string} label
 * @returns {{cable: boolean, virtual: boolean, usb: boolean, bluetooth: boolean}}
 */
export function labelFlags(label) {
  const text = String(label ?? "");
  const cable = isCableInput(text) || isCableOutput(text) || /\(vb-audio virtual cable\)$/.test(normalizeLabel(text));
  return {
    cable,
    virtual: VIRTUAL_MIC.test(text) || VIRTUAL_OUTPUT.test(text),
    usb: /usb/i.test(text),
    bluetooth: BLUETOOTH.test(text),
  };
}

/** Windows' generic names for an endpoint (the part before the driver's name), compared in lower case. */
const ENDPOINT_TYPES = new Set(
  [
    "Microphone",
    "Microphone Array",
    "Headset Microphone",
    "Headset",
    "Headphones",
    "Headset Earphone",
    "Speakers",
    "Speaker",
    "Speakers/Headphones",
    "Line",
    "Line In",
    "Line Out",
    "External Microphone",
    "Internal Microphone",
    "Stereo Mix",
    "Digital Audio (S/PDIF)",
    "Digital Output",
    "Communications Headphones",
    "Realtek Digital Output",
  ].map((t) => t.toLowerCase()),
);

/** Drivers whose names say nothing about the person: sound chips, generic USB audio, VB-Audio's own devices. */
const DRIVER_NAMES =
  /^(USB Audio Device|USB Audio|USB PnP (Sound|Audio) Device|Realtek\(R\) Audio|Realtek High Definition Audio|High Definition Audio Device|Intel(®|\(R\)) Smart Sound Technology.*|NVIDIA High Definition Audio|AMD High Definition Audio Device|IDT High Definition Audio CODEC|Conexant.*|Synaptics.*|Cirrus Logic.*|VB-Audio Cable [A-D]|VB-Audio Voicemeeter (VAIO|AUX VAIO|VAIO3))$/i;

/** VB-CABLE's own endpoint names, kept as they are. */
const CABLE_ENDPOINT = /^(CABLE Input|CABLE Output|CABLE In 16 Ch) \((\d{1,2}- )?VB-Audio Virtual Cable\)$/i;

/** Any other name with VB-CABLE's driver name: an endpoint the user renamed. */
const CABLE_DRIVER = /\(\s*(\d{1,2}-\s*)?VB-Audio Virtual Cable\)$/i;

/**
 * Where the last bracketed group of a label starts (its "("), when the label
 * ends with ")": "Speakers (Realtek(R) Audio)" → the "(" before "Realtek".
 * -1 when the label does not end with a balanced group.
 */
function lastGroupStart(text) {
  if (!text.endsWith(")")) return -1;
  let depth = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === ")") depth++;
    else if (text[i] === "(") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The part of a label after the prefix, masked (see reportLabel). */
function maskName(name) {
  if (CABLE_ENDPOINT.test(name)) return name;
  if (CABLE_DRIVER.test(name)) return RENAMED_CABLE;
  if (ENDPOINT_TYPES.has(name.toLowerCase())) return name; // "Digital Audio (S/PDIF)" on its own
  // Windows numbers a duplicate " (2)": no name in it.
  const dup = /^(.*\S)(\s\(\d{1,2}\))$/.exec(name);
  if (dup && lastGroupStart(dup[1]) >= 0) return maskName(dup[1]) + dup[2];
  const open = lastGroupStart(name);
  if (open < 0) return ENDPOINT_TYPES.has(name.toLowerCase()) ? name : HIDDEN_NAME;
  const type = name.slice(0, open).trim();
  const inner = name.slice(open + 1, -1).trim();
  const numbered = /^(\d{1,2}-\s*)(.*)$/.exec(inner);
  const number = numbered ? numbered[1] : "";
  const driver = numbered ? numbered[2] : inner;
  const typeText = ENDPOINT_TYPES.has(type.toLowerCase()) ? type : HIDDEN_NAME;
  const driverText = DRIVER_NAMES.test(driver) ? driver : HIDDEN_NAME;
  return `${typeText} (${number}${driverText})`;
}

/**
 * A device label that is safe to put in results or logs.
 *  - "" or null → "(no name)".
 *  - Chromium's USB id " (abcd:1234)" at the end is dropped first.
 *  - The prefixes "Default - " and "Communications - " (English only) are
 *    kept; any other "<word> - " prefix is treated as part of the name.
 *  - VB-CABLE's own endpoint names are kept as they are: "CABLE Input",
 *    "CABLE Output" or "CABLE In 16 Ch", then " (VB-Audio Virtual Cable)" or
 *    " (N- VB-Audio Virtual Cable)". Any other name ending in "(VB-Audio
 *    Virtual Cable)" is an endpoint the user renamed: RENAMED_CABLE (the
 *    prefix kept), never the user's text.
 *  - "<type> (<driver>)": the type is kept when it is one of Windows' generic
 *    endpoint names (ENDPOINT_TYPES), else HIDDEN_NAME; the driver (after an
 *    optional "N- ", which is kept) is kept when it is a known sound chip or
 *    generic driver (DRIVER_NAMES), else HIDDEN_NAME. A duplicate's " (2)" at
 *    the end is kept.
 *  - A label without "(…)" is kept only when it is a generic endpoint name.
 * Examples: "Headset Microphone (Jabra EVOLVE 20 MS) (0b0e:0348)" →
 * "Headset Microphone ([name hidden])"; "Microphone (2- USB Audio Device)" →
 * unchanged; "Priya's AirPods" → "[name hidden]"; "Default - CABLE Input
 * (VB-Audio Virtual Cable)" → unchanged; "Priya mic (VB-Audio Virtual Cable)"
 * → "[renamed] (VB-Audio Virtual Cable)"; "Fake Audio Input 1" → "[name
 * hidden]". redact() runs last, so the result never holds a device id.
 * @param {string} label
 * @returns {string}
 */
export function reportLabel(label) {
  let text = String(label ?? "").trim();
  if (!text) return "(no name)";
  text = text.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, "").trim();
  if (!text) return "(no name)";
  const prefix = /^(Default|Communications) - /i.exec(text);
  const head = prefix ? prefix[0] : "";
  const name = text.slice(head.length).trim();
  return redact(head + (name ? maskName(name) : HIDDEN_NAME));
}

/**
 * What getSettings() says about the processing the app turned off.
 * settings: MediaTrackSettings. → { echoCancellation, noiseSuppression,
 * autoGainControl, voiceIsolation, sampleRateHz, channelCount, latencyMs
 * (settings.latency × 1000, 1 decimal; null when absent), allOff }. A value
 * the browser does not report is null. allOff: echo cancellation, noise
 * suppression and auto gain are all exactly false, and voice isolation is
 * false or not reported. A string echoCancellation ("remote-only", "all")
 * counts as on.
 * @param {object|null} settings
 */
export function micSettingsReport(settings) {
  const s = settings && typeof settings === "object" ? settings : {};
  const value = (v) => (v === undefined ? null : v);
  const number = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const latency = number(s.latency);
  return {
    echoCancellation: value(s.echoCancellation),
    noiseSuppression: value(s.noiseSuppression),
    autoGainControl: value(s.autoGainControl),
    voiceIsolation: value(s.voiceIsolation),
    sampleRateHz: number(s.sampleRate),
    channelCount: number(s.channelCount),
    latencyMs: latency === null ? null : Math.round(latency * 10000) / 10,
    allOff:
      s.echoCancellation === false &&
      s.noiseSuppression === false &&
      s.autoGainControl === false &&
      (s.voiceIsolation === undefined || s.voiceIsolation === false),
  };
}

// devices-match.js does not export its texts: take them from feedbackWarnings(), so both always agree.
const MIC_IS_CABLE = feedbackWarnings({ micLabel: "CABLE Output (VB-Audio Virtual Cable)" })[0];
const OUTPUT_IS_CABLE = feedbackWarnings({ defaultOutputLabel: "CABLE Input (VB-Audio Virtual Cable)" })[0];
const INPUT_IS_CABLE = feedbackWarnings({ defaultInputLabel: "CABLE Output (VB-Audio Virtual Cable)" })[0];
const INPUT_IS_LOOPBACK = feedbackWarnings({ defaultInputLabel: "Stereo Mix (Realtek(R) Audio)" })[0] ?? null;

/**
 * Warning and refusal texts: plain English, at most three sentences, never
 * a device id. The ones that name a device are functions of its label (the
 * caller decides whether that label is masked). The monitor's refusals
 * (MonitorError codes) are keys of this object too.
 */
export const WARNINGS = Object.freeze({
  MIC_IS_CABLE,
  OUTPUT_IS_CABLE,
  INPUT_IS_CABLE,
  INPUT_IS_LOOPBACK,
  MIC_IS_VIRTUAL:
    "That microphone is another app's virtual microphone, or a recording of everything the PC plays, not your voice. The app won't use it: pick your headset microphone.",
  COMMS_OUTPUT_IS_CABLE:
    "Windows' default communications playback device is “CABLE Input”. Meeting apps that use it would play the interviewer into the cable, and you would not hear them. In Windows sound settings, right-click your headphones and choose “Set as Default Communication Device”.",
  COMMS_INPUT_IS_CABLE:
    "Windows' default communications microphone is “CABLE Output”, the app's own output. Apps that use it would hear the app instead of you, and nothing at all while the app is closed. In Windows sound settings → Recording, right-click your headset microphone and choose “Set as Default Communication Device”.",
  // missing: the name of the microphone that is not there ("" when none is known).
  STAND_IN: (missing, used) =>
    `Your microphone ${missing ? `“${missing}” ` : ""}is not connected, so the app uses “${used}” for now. Plug it back in: the app switches back by itself.`,
  OUTPUT_OVERRIDE_MISSING: (saved) =>
    `The playback device you picked, “${saved}”, is not there, so the app uses CABLE Input instead.`,
  NO_CABLE:
    "VB-CABLE is not installed yet (there is no “CABLE Input” playback device). Install it, restart Windows, then open the app again.",
  DEFAULT_RATE_LOW: (hz) =>
    `Windows' default playback device runs at ${hz / 1000} kHz (a Bluetooth headset in call mode?). The converted voice will be played through that device, so it can't sound better than that: make wired or USB headphones the default playback device.`,
  CABLE_RATE: (hz) =>
    `CABLE Input runs at ${hz / 1000} kHz. Set it to 48000 Hz: Windows sound settings → More sound settings → Playback → CABLE Input → Properties → Advanced.`,
  BLUETOOTH_MIC:
    "Your microphone looks like a Bluetooth headset. Bluetooth adds delay and cut-outs: use a wired or USB headset.",
  // from, to: "the app's audio engine" or "an audio element (fallback)".
  ROUTE_CHANGED: (from, to) =>
    `The app now sends your voice through ${to} instead of ${from}. This can add delay or clicks: copy the results and send them to me.`,
  NAMES_HIDDEN:
    "The app can't see your devices' names yet, so it doesn't know where your headphones are. Press “Check the microphone” first.",
  STAND_IN_QUIET:
    "Sounds are off while your headset is unplugged: they would come out of the laptop's speakers, and the meeting would hear them.",
  DEFAULT_IS_VIRTUAL:
    "Windows' default playback device is a virtual device, not your headphones. In Windows sound settings, make your headphones the default playback device.",
  NO_HEADPHONES: "The app could not find your headphones, so it plays no sound. Plug in your headset.",
  NO_DEFAULT_OUTPUT:
    "The test tone needs Windows' default playback device, and the app can't find it. Make your headphones the default playback device, then try again.",
});

/** The code of a text from feedbackWarnings(): the constant it equals, or "FEEDBACK" for one this module does not know. */
function feedbackCode(text) {
  for (const code of ["MIC_IS_CABLE", "OUTPUT_IS_CABLE", "INPUT_IS_CABLE", "INPUT_IS_LOOPBACK"]) {
    if (WARNINGS[code] !== null && text === WARNINGS[code]) return code;
  }
  return "FEEDBACK";
}

/**
 * All warnings for the current devices, in this order: MIC_IS_CABLE (the
 * saved microphone is CABLE Output), OUTPUT_IS_CABLE (Windows' default
 * playback device is CABLE Input), INPUT_IS_CABLE or INPUT_IS_LOOPBACK
 * (Windows' default microphone is CABLE Output or a Stereo Mix), all three
 * from devices-match's feedbackWarnings() (any other text it gives is code
 * "FEEDBACK"); COMMS_OUTPUT_IS_CABLE, COMMS_INPUT_IS_CABLE (the default
 * communications devices); STAND_IN (it names the microphone that is
 * missing: savedMicLabel, else wantedMicLabel, the label of the microphone
 * in use before when nothing is saved; no name when neither is known);
 * OUTPUT_OVERRIDE_MISSING; NO_CABLE (no output found); DEFAULT_RATE_LOW
 * (below 44.1 kHz); CABLE_RATE (not 48 kHz); BLUETOOTH_MIC. nameOf(label) is
 * applied to every label put into a text: the identity for the page,
 * reportLabel for results. Labels of Windows' defaults are the
 * pseudo-devices' labels ("Default - …"; "" when absent). ROUTE_CHANGED is
 * added by the graph, not here.
 * @returns {Array<{code: string, text: string}>}
 */
export function deviceWarnings(
  {
    micLabel = "",
    savedMicLabel = "",
    wantedMicLabel = "",
    standIn = false,
    outputFound,
    savedOutputMissing = false,
    savedOutputLabel = "",
    defaultInputLabel = "",
    defaultOutputLabel = "",
    commsInputLabel = "",
    commsOutputLabel = "",
    defaultOutputRateHz = null,
    cableRateHz = null,
  } = {},
  nameOf = (s) => s,
) {
  const list = [];
  const feedback = (labels) => {
    for (const text of feedbackWarnings(labels)) list.push({ code: feedbackCode(text), text });
  };
  feedback({ micLabel: savedMicLabel });
  feedback({ defaultOutputLabel });
  feedback({ defaultInputLabel });
  if (isCableInput(commsOutputLabel)) list.push({ code: "COMMS_OUTPUT_IS_CABLE", text: WARNINGS.COMMS_OUTPUT_IS_CABLE });
  if (isCableOutput(commsInputLabel)) list.push({ code: "COMMS_INPUT_IS_CABLE", text: WARNINGS.COMMS_INPUT_IS_CABLE });
  if (standIn) {
    // Nothing is saved until the user picks a microphone: then the missing one is the one in use before.
    const named = (s) => (typeof s === "string" && s.trim() ? s : "");
    const missing = named(savedMicLabel) || named(wantedMicLabel);
    list.push({ code: "STAND_IN", text: WARNINGS.STAND_IN(missing ? nameOf(missing) : "", nameOf(micLabel ?? "")) });
  }
  if (savedOutputMissing) {
    list.push({ code: "OUTPUT_OVERRIDE_MISSING", text: WARNINGS.OUTPUT_OVERRIDE_MISSING(nameOf(savedOutputLabel ?? "")) });
  }
  if (!outputFound) list.push({ code: "NO_CABLE", text: WARNINGS.NO_CABLE });
  if (typeof defaultOutputRateHz === "number" && defaultOutputRateHz > 0 && defaultOutputRateHz < 44100) {
    list.push({ code: "DEFAULT_RATE_LOW", text: WARNINGS.DEFAULT_RATE_LOW(defaultOutputRateHz) });
  }
  if (typeof cableRateHz === "number" && cableRateHz > 0 && cableRateHz !== 48000) {
    list.push({ code: "CABLE_RATE", text: WARNINGS.CABLE_RATE(cableRateHz) });
  }
  if (labelFlags(micLabel).bluetooth) list.push({ code: "BLUETOOTH_MIC", text: WARNINGS.BLUETOOTH_MIC });
  return list;
}
