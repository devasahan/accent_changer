/**
 * Which audio devices the app uses: the user's real microphone in, and
 * VB-CABLE's "CABLE Input" out (the meeting app then listens to "CABLE
 * Output").
 *
 * Chromium's device lists on Windows (enumerateDevices) start with two
 * pseudo-devices, ids "default" and "communications", labelled "Default - …"
 * and "Communications - …". They follow Windows' current choice, which can
 * change under the app (even to the cable), so they are never picked.
 * Windows renames a device that comes back on another USB port ("Headset
 * Microphone (2- Jabra EVOLVE 20 MS)"), Chromium adds a USB id to some
 * labels ("… (0b0e:0348)") and changes ids when site data is cleared, so a
 * saved microphone is found by its id first and then by its label without
 * those decorations. Virtual microphones (VB-CABLE, Krisp, Sanas,
 * Voicemeeter, Steam) are never picked: the cable's output would loop the
 * meeting's audio back into itself, and another voice app would convert the
 * voice twice.
 *
 * Pure: device lists come in as arrays of {deviceId, label, kind?}.
 */

/**
 * Labels of virtual microphones: another app's output, never the user's own
 * voice. The spec's list plus "vb-audio", which also covers VB-Audio's other
 * virtual devices (CABLE-A/B, Hi-Fi Cable, Voicemeeter's outputs).
 */
export const VIRTUAL_MIC = /cable output|krisp|sanas|voicemeeter|steam streaming|vb-audio/i;

/** Chromium's pseudo-devices that follow Windows' default and default communications device. */
const PSEUDO_IDS = ["default", "communications"];

/** VB-CABLE's playback side, as its driver names it (not translated by Windows). */
const CABLE_INPUT = "cable input (vb-audio virtual cable)";

/**
 * A device label without what Windows and Chromium add around the device's
 * name, in lower case, for comparing: "Default - " and "Communications - "
 * prefixes, Chromium's USB id " (0b0e:0348)", a duplicate's " (2)" suffix
 * and Windows' port number "(2- …)".
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

/** True for VB-CABLE's capture side ("CABLE Output"): the converted voice, as the meeting app hears it. */
export function isCableOutput(label) {
  return /^cable output\b/.test(normalizeLabel(label));
}

/** True for VB-CABLE's playback side ("CABLE Input"): where the app plays the converted voice. */
export function isCableInput(label) {
  return /^cable input\b/.test(normalizeLabel(label));
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
 * devices: the real entry, never the "default" or "communications"
 * pseudo-device (even when Windows' default output is the cable). The
 * un-numbered one first when Windows lists the cable twice. Null when
 * VB-CABLE is not installed.
 * @param {Array<{deviceId: string, label: string, kind?: string}>} outputs
 * @returns {object|null} the matching entry of `outputs`
 */
export function findCableInput(outputs) {
  const cables = ofKind(outputs, "audiooutput").filter((d) => isReal(d) && isCableInput(d.label));
  return cables.find((d) => String(d.label).trim().toLowerCase() === CABLE_INPUT) ?? cables[0] ?? null;
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
 * and USB ids); else the real microphone Windows uses by default (then its
 * default communications device); else the first usable one. Null when
 * there is no usable microphone. Compare the result's deviceId with the
 * saved one to tell the user when their microphone was replaced.
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
  const byLabel = (wanted) => {
    const want = normalizeLabel(wanted);
    return want ? mics.find((d) => normalizeLabel(d.label) === want) : undefined;
  };
  if (label) {
    const same = mics.find((d) => d.label === label) ?? byLabel(label);
    if (same) return same;
  }
  const all = ofKind(inputs, "audioinput");
  for (const id of PSEUDO_IDS) {
    const pseudo = all.find((d) => d.deviceId === id);
    const target = pseudo && byLabel(pseudo.label);
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
 * Chromium shows them; "Default - …" prefixes are fine):
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
