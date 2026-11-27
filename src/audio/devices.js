/**
 * The audio devices as the page sees them, and opening a microphone.
 *
 * readDevices() takes a snapshot of Chromium's device lists: plain copies of
 * every microphone and playback device, the labels of Windows' default and
 * default communications devices, the usable microphones, and VB-CABLE's two
 * ends ("CABLE Input" to play into, "CABLE Output" to record from). Device
 * names stay hidden until the page may use the microphone. On the first start
 * the snapshot can open Windows' default microphone for a moment to unlock
 * them; nothing is played or recorded then.
 *
 * openMic() opens one microphone by its exact id, with echo cancellation,
 * noise suppression, auto gain and voice isolation off. It refuses CABLE
 * Output and other virtual microphones before asking Windows. Its errors are
 * MicErrors: a code the recovery reducer understands, the browser's own error
 * name, and a plain-English text for the page.
 *
 * Nothing here touches the page when it is imported: navigator and
 * AudioContext are only used inside the functions.
 */
import { VIRTUAL_MIC, isCableOutput, usableMics, findCableInput } from "../core/devices-match.js";
import { WARNINGS, findCableOutput, micSettingsReport } from "../core/device-choice.js";
import { redact } from "../core/redact.js";

/** Chromium's pseudo-devices that follow Windows' default and default communications device. */
const PSEUDO_IDS = ["default", "communications"];

/** VB-Audio's endpoints (VB-CABLE's and its other cables'), by their driver's name. */
const VB_AUDIO = /vb-audio/i;

// Texts for microphone errors. The app's wording is main.js's (Step 1); the
// browser's is the probe's, which tells Edge users where site permissions live.
const TEXTS = Object.freeze({
  appSystem:
    "Windows blocked the microphone: Settings → Privacy & security → Microphone → turn on microphone access and “Let desktop apps access your microphone”, then try again.",
  browserSystem:
    "Windows blocked the microphone: Settings → Privacy & security → Microphone → turn on microphone access and “Let desktop apps access your microphone”, then reload this page.",
  appRefused: "The microphone was refused for this app. Write that in your notes.",
  browserRefused:
    "The browser blocked the microphone for this page: click the icon left of the address bar → Permissions for this site → Microphone → Allow, then reload the page.",
  busy: "The microphone could not be opened: another app may be holding it. Close apps that use it and try again.",
  notFound: "No microphone was found. Plug in your headset and try again.",
  gone: "That microphone is not connected any more (unplugged?). Plug it in, or pick another one in the list.",
  noMediaDevices: "This page cannot use microphones (it is not a secure page). Open the app itself, or http://localhost:8080/src/ in Edge.",
});

/** The name of anything thrown ("Error" when it has none). */
function nameOf(err) {
  return err && typeof err === "object" && typeof err.name === "string" && err.name ? err.name : "Error";
}

/** The message of anything thrown, as text. */
function messageOf(err) {
  if (err && typeof err === "object" && typeof err.message === "string") return err.message;
  return err === undefined || err === null ? "" : String(err);
}

/** Stop every track of a stream (a stream that is already stopped is fine). */
export function stopStream(stream) {
  try {
    for (const track of stream?.getTracks?.() ?? []) track.stop();
  } catch {
    // Nothing to stop.
  }
}

/**
 * A microphone that could not be used. code: "blocked" | "busy" | "missing" |
 * "is-cable" | "is-virtual" | "other"; cause: the browser's error as
 * { name, message } (its message redacted); message: the text for the page.
 * The recovery reducer classifies it by its code (classifyError).
 */
export class MicError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{name: string, message: string}|null} [cause]
   */
  constructor(code, message, cause = null) {
    super(message);
    this.name = "MicError";
    this.code = code;
    this.cause = cause;
  }
}

/** The MicError code of a getUserMedia error name. */
function codeOf(name) {
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "blocked";
    case "NotReadableError":
    case "AbortError":
      return "busy";
    case "NotFoundError":
    case "OverconstrainedError":
      return "missing";
    default:
      return "other";
  }
}

/**
 * Plain-English text for a microphone error. A MicError keeps its own text.
 * where "app": the installed app's wording; "browser": Edge dev mode, which
 * says where the site permission is and asks for a reload.
 * @param {*} err
 * @param {"app"|"browser"} [where]
 * @returns {string}
 */
export function micErrorText(err, where = "app") {
  if (nameOf(err) === "MicError" && messageOf(err)) return messageOf(err);
  const name = nameOf(err);
  const message = messageOf(err);
  const browser = where === "browser";
  if (name === "NotAllowedError" || name === "SecurityError") {
    if (/system/i.test(message)) return browser ? TEXTS.browserSystem : TEXTS.appSystem;
    return browser ? TEXTS.browserRefused : TEXTS.appRefused;
  }
  if (name === "NotReadableError" || name === "AbortError") return TEXTS.busy;
  if (name === "NotFoundError") return TEXTS.notFound;
  if (name === "OverconstrainedError") return TEXTS.gone;
  if (name === "NoMediaDevices") return TEXTS.noMediaDevices;
  const detail = redact(message).trim();
  return `Microphone error: ${detail || name}`;
}

/**
 * Any error from opening a microphone as a MicError (a MicError stays as it
 * is). The browser's message is redacted: it can hold a device id.
 * @param {*} err
 * @param {"app"|"browser"} [where]
 * @returns {MicError}
 */
export function toMicError(err, where = "app") {
  if (nameOf(err) === "MicError" && typeof err.code === "string") return err;
  const cause = { name: nameOf(err), message: redact(messageOf(err)) };
  return new MicError(codeOf(cause.name), micErrorText(err, where), cause);
}

/** The MicError for "no usable microphone in the list". */
export function noMicError(where = "app") {
  return new MicError("missing", TEXTS.notFound, { name: "NotFoundError", message: "No usable microphone in the device list." });
}

/** navigator.mediaDevices, or a MicError when the page has none (not a secure page). */
function mediaDevices(where) {
  const md = globalThis.navigator?.mediaDevices;
  if (!md || typeof md.enumerateDevices !== "function") {
    throw new MicError("blocked", TEXTS.noMediaDevices, { name: "NoMediaDevices", message: "navigator.mediaDevices is missing." });
  }
  return md;
}

/** Plain copies of the audio entries of enumerateDevices() (never instanceof MediaDeviceInfo). */
async function enumerate(md) {
  const list = await md.enumerateDevices();
  const out = [];
  for (const d of list ?? []) {
    if (!d || (d.kind !== "audioinput" && d.kind !== "audiooutput")) continue;
    out.push({
      deviceId: typeof d.deviceId === "string" ? d.deviceId : "",
      groupId: typeof d.groupId === "string" ? d.groupId : "",
      kind: d.kind,
      label: typeof d.label === "string" ? d.label : "",
    });
  }
  return out;
}

const isReal = (d) => d.deviceId !== "" && !PSEUDO_IDS.includes(d.deviceId);

/** The label of a pseudo-device in a list ("" when it is not there). */
const pseudoLabel = (list, id) => list.find((d) => d.deviceId === id)?.label ?? "";

/**
 * A snapshot of the audio devices:
 * { atMs, labelsVisible, unlockMs, unlockError, inputs, outputs,
 *   defaultInputLabel, defaultOutputLabel, commsInputLabel, commsOutputLabel,
 *   usable, cableIn, cableOut, cableEndpoints }.
 *  - inputs, outputs: plain {deviceId, groupId, kind, label} copies, the
 *    pseudo-devices included.
 *  - The four *Label fields are the pseudo-devices' labels ("Default - …"),
 *    "" when Windows has no such device.
 *  - usable: usableMics(inputs); cableIn: findCableInput(outputs); cableOut:
 *    findCableOutput(inputs); cableEndpoints: the labels of every VB-Audio
 *    endpoint, microphones first.
 *  - unlockLabels: when no microphone has a name yet, Windows' default
 *    microphone is opened for a moment (no device id; nothing is played or
 *    recorded) so that Chromium shows the names, and the list is read again.
 *    unlockMs is how long that took (a permission question would appear
 *    there); null when it was not needed. unlockError is the MicError when it
 *    failed (the names then stay hidden), else null.
 * Throws a MicError only when the page has no media devices at all.
 * @param {{unlockLabels?: boolean, where?: "app"|"browser"}} [options]
 */
export async function readDevices({ unlockLabels = false, where = "app" } = {}) {
  const md = mediaDevices(where);
  let list = await enumerate(md);
  let unlockMs = null;
  let unlockError = null;
  if (unlockLabels && !list.some((d) => d.kind === "audioinput" && d.label)) {
    const t0 = performance.now();
    try {
      const stream = await md.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      stopStream(stream);
    } catch (err) {
      unlockError = toMicError(err, where);
    }
    unlockMs = Math.round(performance.now() - t0);
    list = await enumerate(md);
  }
  const inputs = list.filter((d) => d.kind === "audioinput");
  const outputs = list.filter((d) => d.kind === "audiooutput");
  const cableEndpoints = [...inputs, ...outputs].filter((d) => isReal(d) && VB_AUDIO.test(d.label)).map((d) => d.label);
  return {
    atMs: performance.now(),
    labelsVisible: list.some((d) => d.label !== ""),
    unlockMs,
    unlockError,
    inputs,
    outputs,
    defaultInputLabel: pseudoLabel(inputs, "default"),
    defaultOutputLabel: pseudoLabel(outputs, "default"),
    commsInputLabel: pseudoLabel(inputs, "communications"),
    commsOutputLabel: pseudoLabel(outputs, "communications"),
    usable: usableMics(inputs),
    cableIn: findCableInput(outputs),
    cableOut: findCableOutput(inputs),
    cableEndpoints,
  };
}

/**
 * Call `callback(snapshot)` after each "devicechange". Coalesced without
 * timers: while one read runs, further events only mark it dirty, and
 * exactly one more read follows when it ends. A failed read is skipped.
 * @param {(snapshot: object) => void} callback
 * @param {{where?: "app"|"browser"}} [options]
 * @returns {() => void} unsubscribe
 */
export function onDeviceChange(callback, { where = "app" } = {}) {
  const md = globalThis.navigator?.mediaDevices;
  if (!md || typeof md.addEventListener !== "function") return () => {};
  let active = true;
  let reading = false;
  let dirty = false;
  const run = async () => {
    reading = true;
    try {
      do {
        dirty = false;
        let snapshot = null;
        try {
          snapshot = await readDevices({ where });
        } catch {
          snapshot = null;
        }
        if (!active) return;
        if (snapshot) {
          try {
            callback(snapshot);
          } catch {
            // The listener's own problem; the next change is still reported.
          }
        }
      } while (dirty && active);
    } finally {
      reading = false;
    }
  };
  const onChange = () => {
    if (!active) return;
    if (reading) dirty = true;
    else run();
  };
  md.addEventListener("devicechange", onChange);
  return () => {
    active = false;
    md.removeEventListener("devicechange", onChange);
  };
}

/**
 * getUserMedia constraints for one microphone by its exact id, mono, with
 * the browser's voice processing off.
 * @param {string} deviceId
 */
export function micConstraints(deviceId) {
  return {
    audio: {
      deviceId: { exact: deviceId },
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      voiceIsolation: false,
    },
  };
}

/**
 * Open a microphone (an entry of the snapshot's inputs).
 * → { stream, track, openedInMs, settings } where settings is
 * micSettingsReport(track.getSettings()).
 * Refused before Windows is asked: CABLE Output (MicError "is-cable", text
 * WARNINGS.MIC_IS_CABLE) and any other virtual microphone (Krisp,
 * Voicemeeter, Stereo Mix, …: "is-virtual", WARNINGS.MIC_IS_VIRTUAL).
 * Every other failure is a MicError (toMicError).
 * @param {{deviceId: string, label?: string}} entry
 * @param {{where?: "app"|"browser"}} [options]
 */
export async function openMic(entry, { where = "app" } = {}) {
  const label = typeof entry?.label === "string" ? entry.label : "";
  if (isCableOutput(label)) {
    throw new MicError("is-cable", WARNINGS.MIC_IS_CABLE, { name: "VirtualMicrophone", message: "" });
  }
  if (VIRTUAL_MIC.test(label)) {
    throw new MicError("is-virtual", WARNINGS.MIC_IS_VIRTUAL, { name: "VirtualMicrophone", message: "" });
  }
  const id = typeof entry?.deviceId === "string" ? entry.deviceId : "";
  if (!id || PSEUDO_IDS.includes(id)) throw noMicError(where);
  const md = mediaDevices(where);
  const t0 = performance.now();
  let stream;
  try {
    stream = await md.getUserMedia(micConstraints(id));
  } catch (err) {
    throw toMicError(err, where);
  }
  const openedInMs = Math.round(performance.now() - t0);
  const track = stream.getAudioTracks()[0];
  if (!track) {
    stopStream(stream);
    throw noMicError(where);
  }
  let raw = {};
  try {
    raw = track.getSettings();
  } catch {
    raw = {};
  }
  return { stream, track, openedInMs, settings: micSettingsReport(raw) };
}

/**
 * Open VB-CABLE's "CABLE Output" (the microphone the meeting app uses) to
 * record what the meeting hears: the exact id from the snapshot, mono,
 * processing off. → { stream, track, settings }.
 * @param {object|null} snapshot a DeviceSnapshot
 */
export async function openCableOutput(snapshot) {
  const id = snapshot?.cableOut?.deviceId;
  if (typeof id !== "string" || !id) throw new Error("“CABLE Output” is not among the microphones: is VB-CABLE installed?");
  const md = mediaDevices("app");
  let stream;
  try {
    stream = await md.getUserMedia(micConstraints(id));
  } catch (err) {
    const name = nameOf(err);
    const busy = name === "NotReadableError" || name === "AbortError";
    const e = new Error(
      busy
        ? "“CABLE Output” could not be opened: another app may hold it. Close that app and try again."
        : `“CABLE Output” could not be opened (${name}). Try again; if it keeps failing, restart the app.`,
    );
    e.cause = { name, message: redact(messageOf(err)) };
    throw e;
  }
  const track = stream.getAudioTracks()[0];
  if (!track) {
    stopStream(stream);
    throw new Error("“CABLE Output” gave no sound track. Try again; if it keeps failing, restart the app.");
  }
  let raw = {};
  try {
    raw = track.getSettings();
  } catch {
    raw = {};
  }
  return { stream, track, settings: micSettingsReport(raw) };
}

/**
 * The native sample rate of a playback device: a short-lived AudioContext
 * on that device (Windows' default when deviceId is "") built without a
 * sampleRate option, so it runs at the device's own rate. null when the
 * device is not in the list now, when the context did not take it, or on
 * any error.
 * Chromium takes a constructor's sinkId at once and checks it only a moment
 * later (an unknown id then fires "error" and falls back to the default
 * device's rate), so the id is looked up in a fresh device list first. The
 * context is closed at once, before that check, so a device that vanished
 * in between costs a wrong number in the results, never an error.
 * @param {string} [deviceId]
 * @returns {Promise<number|null>}
 */
export async function readOutputRate(deviceId = "") {
  let ctx = null;
  try {
    if (deviceId) {
      const list = await globalThis.navigator.mediaDevices.enumerateDevices();
      if (!list.some((d) => d.kind === "audiooutput" && d.deviceId === deviceId)) return null;
    }
    ctx = deviceId ? new AudioContext({ sinkId: deviceId }) : new AudioContext();
    const rate = ctx.sampleRate;
    if (deviceId && ctx.sinkId !== deviceId) return null;
    return typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? rate : null;
  } catch {
    return null;
  } finally {
    if (ctx) {
      try {
        await ctx.close();
      } catch {
        // Already closed.
      }
    }
  }
}
