/**
 * Which audio devices the app uses: the user's real microphone in, and
 * VB-CABLE's "CABLE Input" out (the meeting app then listens to "CABLE
 * Output").
 *
 * Chromium's device lists on Windows (enumerateDevices) start with two
 * pseudo-devices, ids "default" and "communications", labelled "Default - …"
 * and "Communications - …" (those two words in Windows' display language:
 * "Standard - …" in German, "Par défaut - …" in French). They follow
 * Windows' current choice, which can change under the app (even to the
 * cable), so they are never picked. Windows renames a device that comes
 * back on another USB port ("Headset Microphone (2- Jabra EVOLVE 20 MS)"),
 * Chromium adds a USB id to some labels ("… (0b0e:0348)") and changes ids
 * when site data is cleared, so a saved microphone is found by its id first
 * and then by its label without those decorations. Virtual microphones
 * (VB-CABLE, Krisp, Sanas, Voicemeeter, Steam, voice changers) are never
 * picked: the cable's output would loop the meeting's audio back into
 * itself, and another voice app would convert the voice twice. The cable is
 * known by its driver's name, "(VB-Audio Virtual Cable)", which stays when
 * the user renames "CABLE Input" or "CABLE Output" in Windows' sound
 * settings.
 *
 * Pure: device lists come in as arrays of {deviceId, label, kind?}.
 */

/**
 * Labels of virtual microphones: another app's output, never the user's own
 * voice. The spec's list plus "vb-audio", which also covers VB-Audio's other
 * virtual devices (CABLE-A/B, Hi-Fi Cable, Voicemeeter's outputs), and the
 * voice changers and voice filters people have installed (Voicemod, NVIDIA
 * Broadcast and RTX Voice, Elgato's Wave Link mixes, Teams' own device,
 * MorphVOX, Clownfish, Voxal, Voice.ai, MagicMic, Virtual Audio Cable). Not
 * "Elgato Wave:3" or "Virtual Desktop": real microphones.
 */
export const VIRTUAL_MIC =
  /cable output|krisp|sanas|voicemeeter|steam streaming|vb-audio|voicemod|voice changer|nvidia broadcast|rtx voice|wave link|teams audio|morphvox|clownfish|voxal|voice\.ai|magicmic|virtual audio cable/i;

/** Chromium's pseudo-devices that follow Windows' default and default communications device. */
const PSEUDO_IDS = ["default", "communications"];

/** VB-CABLE's playback side, as its driver names it (not translated by Windows). */
const CABLE_INPUT = "cable input (vb-audio virtual cable)";

/** VB-CABLE's driver name at the end of each of its endpoints' labels (after normalizeLabel), whatever the endpoint is called. */
const CABLE_DRIVER = /\(vb-audio virtual cable\)$/;

/** Windows' numbering of a second device of the same kind: "(2- …)". */
const NUMBERED = /\(\d{1,2}- /;

/**
 * The real device's label in a pseudo-device's label: Chromium writes the
 * word for "Default" or "Communications" in Windows' display language, then
 * " - ", then the device's label. Only the first " - " counts: a device's own
 * name may hold one too.
 * @param {string} label
 * @returns {string}
 */
function pseudoTarget(label) {
  const text = String(label ?? "").trim();
  const at = text.indexOf(" - ");
  return at > 0 ? text.slice(at + 3).trim() : text;
}

/**
 * A device label without what Windows and Chromium add around the device's
 * name, in lower case, for comparing: "Default - " and "Communications - "
 * prefixes, Chromium's USB id " (0b0e:0348)", a duplicate's " (2)" suffix
 * and Windows' port number "(2- …)". Only the English prefixes: a real
 * device's name may hold " - " too, so the prefix in another language
 * ("Standard - ") is cut only where the label is known to be a
 * pseudo-device's (pickMic, feedbackWarnings).
 * @param {string} label
 * @returns {string}
 */
export function normalizeLabel(label) {
  return String(label ?? "")
    .trim()
    .replace(/^(?:default|communications)\s+-\s+/i, "")
    .replace(/\s+\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, "")
    .replace(/\s+\(\d+\)$/, "")
    .replace(/\(\d{1,2}-\s+/g, "(")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Which of VB-CABLE's endpoints a label names: "output" (CABLE Output),
 * "input" (CABLE Input), "input16" (CABLE In 16 Ch), "renamed" (another name
 * with the cable's driver name: an endpoint the user renamed), or null (not
 * the cable). The endpoint name may follow a pseudo-device's prefix in any
 * language ("Standard - CABLE Output (…)").
 */
function cableEndpoint(label) {
  const name = normalizeLabel(label);
  if (/(?:^| - )cable output\b/.test(name)) return "output";
  if (/(?:^| - )cable input\b/.test(name)) return "input";
  if (/(?:^| - )cable in 16 ch\b/.test(name)) return "input16";
  return CABLE_DRIVER.test(name) ? "renamed" : null;
}

/**
 * True for VB-CABLE's capture side ("CABLE Output"): the converted voice, as
 * the meeting app hears it. For a microphone's label (or Windows' default
 * microphone's): an endpoint the user renamed counts too, as a microphone
 * of the cable can only be its capture side.
 * @param {string} label
 * @returns {boolean}
 */
export function isCableOutput(label) {
  const endpoint = cableEndpoint(label);
  return endpoint === "output" || endpoint === "renamed";
}

/**
 * True for VB-CABLE's playback side ("CABLE Input"): where the app plays the
 * converted voice. For a playback device's label: an endpoint the user
 * renamed counts too. The 16-channel "CABLE In 16 Ch" does not.
 * @param {string} label
 * @returns {boolean}
 */
export function isCableInput(label) {
  const endpoint = cableEndpoint(label);
  return endpoint === "input" || endpoint === "renamed";
}

/** The entries of a device list of one kind (entries without `kind` are taken as that kind). */
function ofKind(devices, kind) {
  const list = devices && typeof devices[Symbol.iterator] === "function" ? [...devices] : [];
  return list.filter((d) => d !== null && typeof d === "object" && (d.kind === undefined || d.kind === kind));
}

/** A device the app can open by id: not a pseudo-device, and not the id-less entry Chromium lists before permission. */
const isReal = (d) => typeof d.deviceId === "string" && d.deviceId !== "" && !PSEUDO_IDS.includes(d.deviceId);

/**
 * VB-CABLE's "CABLE Input (VB-Audio Virtual Cable)" among the playback
 * devices, also when the user renamed it in Windows' sound settings ("Accent
 * Out (VB-Audio Virtual Cable)"): the real entry, never the "default" or
 * "communications" pseudo-device (even when Windows' default output is the
 * cable). The un-numbered one first when Windows lists the cable twice. Null
 * when VB-CABLE is not installed.
 * @param {Array<{deviceId: string, label: string, kind?: string}>} outputs
 * @returns {object|null} the matching entry of `outputs`
 */
export function findCableInput(outputs) {
  const cables = ofKind(outputs, "audiooutput").filter((d) => isReal(d) && isCableInput(d.label));
  return (
    cables.find((d) => String(d.label).trim().toLowerCase() === CABLE_INPUT) ??
    cables.find((d) => !NUMBERED.test(String(d.label))) ??
    cables[0] ??
    null
  );
}

/**
 * Real microphones only: no virtual microphones (VIRTUAL_MIC), no "default"
 * or "communications" pseudo-devices, no entries without an id. Order kept.
 * @param {Array<{deviceId: string, label: string, kind?: string}>} inputs
 * @returns {object[]} entries of `inputs`
 */
export function usableMics(inputs) {
  return ofKind(inputs, "audioinput").filter((d) => isReal(d) && !VIRTUAL_MIC.test(d.label ?? ""));
}

/**
 * The microphone to use, always a real one (see usableMics): the saved
 * device by its exact id if it is there; else the one with the same label
 * (exact, then ignoring "Default - ", "Communications - ", " (2)", "(2- …)"
 * and USB ids; a label saved from a pseudo-device loses its prefix in any
 * language); else the real microphone Windows uses by default (then its
 * default communications device), by the label inside the pseudo-device's
 * label, exact first; else the first usable one. Null when there is no
 * usable microphone. Compare the result's deviceId with the saved one to
 * tell the user when their microphone was replaced.
 * @param {Array<{deviceId: string, label: string, kind?: string}>} inputs
 * @param {{deviceId?: string, label?: string}} [saved]
 * @returns {object|null} an entry of `inputs`
 */
export function pickMic(inputs, saved = {}) {
  const mics = usableMics(inputs);
  if (!mics.length) return null;
  const { deviceId, label } = saved ?? {};
  if (deviceId) {
    const same = mics.find((d) => d.deviceId === deviceId);
    if (same) return same;
  }
  // The exact label first: with two identical headsets only Windows' "(2- …)" tells them apart.
  const byLabel = (wanted) => {
    const exact = mics.find((d) => d.label === wanted);
    if (exact) return exact;
    const want = normalizeLabel(wanted);
    return want ? mics.find((d) => normalizeLabel(d.label) === want) : undefined;
  };
  if (label) {
    const same = byLabel(PSEUDO_IDS.includes(deviceId) ? pseudoTarget(label) : label);
    if (same) return same;
  }
  const all = ofKind(inputs, "audioinput");
  for (const id of PSEUDO_IDS) {
    const pseudo = all.find((d) => d.deviceId === id);
    const target = pseudo && byLabel(pseudoTarget(pseudo.label));
    if (target) return target;
  }
  return mics[0];
}

const MIC_IS_CABLE =
  "“CABLE Output” is set as your microphone. That is the app's own output, so the meeting's audio would loop back into itself. The app won't use it: pick your headset microphone.";
const OUTPUT_IS_CABLE =
  "Windows plays its sound into “CABLE Input”. You would not hear the interviewer, and they would hear themselves and your notification sounds. In Windows sound settings, make your headphones the default playback device.";
const INPUT_IS_CABLE =
  "Windows' default microphone is “CABLE Output”, the app's own output. Apps that use the default microphone would hear the converted voice instead of you. In Windows sound settings, make your headset the default microphone, and pick “CABLE Output” only inside Zoom, Teams or Meet.";

/**
 * Plain-English warnings about set-ups that loop audio back (labels as
 * Chromium shows them; "Default - …" prefixes are fine, in any language, and
 * so are cable endpoints the user renamed):
 * CABLE Output as the app's microphone (the app must refuse it: check
 * isCableOutput(micLabel) before starting), CABLE Input as Windows' default
 * playback device, and CABLE Output as Windows' default microphone. An empty
 * array when all is well.
 * @param {{micLabel?: string, defaultInputLabel?: string, defaultOutputLabel?: string}} labels
 * @returns {string[]}
 */
export function feedbackWarnings({ micLabel, defaultInputLabel, defaultOutputLabel } = {}) {
  const warnings = [];
  if (isCableOutput(micLabel)) warnings.push(MIC_IS_CABLE);
  if (isCableInput(defaultOutputLabel)) warnings.push(OUTPUT_IS_CABLE);
  if (isCableOutput(defaultInputLabel)) warnings.push(INPUT_IS_CABLE);
  return warnings;
}
