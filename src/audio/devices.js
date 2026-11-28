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
 * Every call to the browser here (enumerateDevices, getUserMedia, closing a
 * probe context) is given up when it does not answer in time, so nothing
 * that waits for one can wait for good. A stream that arrives after that is
 * stopped at once.
 *
 * Nothing here touches the page when it is imported: navigator and
 * AudioContext are only used inside the functions.
 */
import { VIRTUAL_MIC, isCableOutput, usableMics, findCableInput } from "../core/devices-match.js";
import { PSEUDO_IDS, WARNINGS, findCableOutput, micSettingsReport } from "../core/device-choice.js";
import { abortError } from "../core/async.js";
import { redact } from "../core/redact.js";

/**
 * How long enumerateDevices() or getUserMedia() may take before it is given
 * up (a "TimeoutError"). Generous, so that the permission question of a first
 * launch in Edge still fits. The recovery treats it as a passing failure and
 * tries again.
 */
export const NO_ANSWER_MS = 15000;

/** How long closing a probe context may take (readOutputRate). */
const PROBE_CLOSE_MS = 2000;


/** VB-Audio's endpoints (VB-CABLE's and its other cables'), by their driver's name. */
const VB_AUDIO = /vb-audio/i;

// Texts for microphone errors. The app's wording is main.js's (Step 1); the
// browser's is the probe's, which tells Edge users where site permissions live.
const TEXTS = Object.freeze({
  appSystem:
    "Windows blocked the microphone: Settings → Privacy & security → Microphone (on Windows 10: Settings → Privacy → Microphone) → turn on microphone access and let desktop apps access your microphone, then press “Check the microphone”.",
  browserSystem:
    "Windows blocked the microphone: Settings → Privacy & security → Microphone (on Windows 10: Settings → Privacy → Microphone) → turn on microphone access and let desktop apps access your microphone, then reload this page.",
  appRefused:
    "The microphone was refused for this app. Write that in your notes, press “Copy results” and send them to me, then close the app and open it again.",
  browserRefused:
    "The browser blocked the microphone for this page: click the icon left of the address bar → Permissions for this site → Microphone → Allow, then reload the page.",
  busy: "The microphone could not be opened: another app may be holding it. Close apps that use it and try again.",
  noAnswer: "The microphone did not answer in time. Try again in a moment.",
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

/** The error of a browser call that did not answer in time (name "TimeoutError"). */
function noAnswer(what, ms) {
  const e = new Error(`${what} did not answer within ${Math.round(ms / 1000)} s.`);
  e.name = "TimeoutError";
  return e;
}

/**
 * The outcome of a browser call that is already under way: its value or its
 * error; a TimeoutError after `ms`; an AbortError as soon as `signal` aborts
 * (the caller gave up). A value that comes after that goes to `onLate` (a
 * late stream is stopped there); a late error is ignored.
 * @template T
 * @param {Promise<T>} call
 * @param {{ms: number, what: string, signal?: AbortSignal|null, onLate?: ((value: T) => void)|null}} options
 * @returns {Promise<T>}
 */
function bounded(call, { ms, what, signal = null, onLate = null }) {
  const limit = Number.isFinite(ms) && ms > 0 ? ms : NO_ANSWER_MS;
  return new Promise((resolve, reject) => {
    let over = false;
    let timer = null;
    const onAbort = () => {
      if (over) return;
      end();
      reject(abortError());
    };
    const end = () => {
      over = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    };
    timer = setTimeout(() => {
      if (over) return;
      end();
      reject(noAnswer(what, limit));
    }, limit);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.("abort", onAbort, { once: true });
    Promise.resolve(call).then(
      (value) => {
        if (!over) {
          end();
          resolve(value);
          return;
        }
        try {
          onLate?.(value);
        } catch {
          // Nothing more to clean up.
        }
      },
      (err) => {
        if (over) return;
        end();
        reject(err);
      },
    );
  });
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
  if (name === "TimeoutError") return TEXTS.noAnswer;
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
async function enumerate(md, { timeoutMs, signal }) {
  if (signal?.aborted) throw abortError();
  const list = await bounded(md.enumerateDevices(), { ms: timeoutMs, what: "enumerateDevices", signal });
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
 *    failed or did not answer within timeoutMs (the names then stay hidden),
 *    else null.
 * Throws a MicError when the page has no media devices at all, a
 * TimeoutError when enumerateDevices() does not answer within timeoutMs, and
 * an AbortError as soon as `signal` aborts.
 * @param {{unlockLabels?: boolean, where?: "app"|"browser", timeoutMs?: number, signal?: AbortSignal|null}} [options]
 */
export async function readDevices({ unlockLabels = false, where = "app", timeoutMs = NO_ANSWER_MS, signal = null } = {}) {
  const md = mediaDevices(where);
  const limits = { timeoutMs, signal };
  let list = await enumerate(md, limits);
  let unlockMs = null;
  let unlockError = null;
  if (unlockLabels && !list.some((d) => d.kind === "audioinput" && d.label)) {
    const t0 = performance.now();
    try {
      const asking = md.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      stopStream(await bounded(asking, { ms: timeoutMs, what: "getUserMedia", signal, onLate: stopStream }));
    } catch (err) {
      if (signal?.aborted) throw abortError();
      unlockError = toMicError(err, where);
    }
    unlockMs = Math.round(performance.now() - t0);
    list = await enumerate(md, limits);
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
 * exactly one more read follows when it ends. A failed read is skipped, and
 * so is a read that gets no answer within timeoutMs, so later changes are
 * still read.
 * @param {(snapshot: object) => void} callback
 * @param {{where?: "app"|"browser", timeoutMs?: number}} [options]
 * @returns {() => void} unsubscribe
 */
export function onDeviceChange(callback, { where = "app", timeoutMs = NO_ANSWER_MS } = {}) {
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
          snapshot = await readDevices({ where, timeoutMs });
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
 * Every other failure is a MicError (toMicError), including a getUserMedia
 * that does not answer within timeoutMs (code "other", cause TimeoutError: a
 * passing failure that the recovery retries; the stream, if it comes later,
 * is stopped). An AbortError as soon as `signal` aborts (the caller gave up).
 * @param {{deviceId: string, label?: string}} entry
 * @param {{where?: "app"|"browser", timeoutMs?: number, signal?: AbortSignal|null}} [options]
 */
export async function openMic(entry, { where = "app", timeoutMs = NO_ANSWER_MS, signal = null } = {}) {
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
  if (signal?.aborted) throw abortError();
  const t0 = performance.now();
  let stream;
  try {
    const asking = md.getUserMedia(micConstraints(id));
    stream = await bounded(asking, { ms: timeoutMs, what: "getUserMedia", signal, onLate: stopStream });
  } catch (err) {
    if (signal?.aborted) throw abortError();
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
 * processing off. → { stream, track, settings }. A getUserMedia that does
 * not answer within timeoutMs is given up (its stream, if it comes later, is
 * stopped).
 * @param {object|null} snapshot a DeviceSnapshot
 * @param {{timeoutMs?: number}} [options]
 */
export async function openCableOutput(snapshot, { timeoutMs = NO_ANSWER_MS } = {}) {
  const id = snapshot?.cableOut?.deviceId;
  if (typeof id !== "string" || !id) throw new Error("“CABLE Output” is not among the microphones: is VB-CABLE installed?");
  const md = mediaDevices("app");
  let stream;
  try {
    const asking = md.getUserMedia(micConstraints(id));
    stream = await bounded(asking, { ms: timeoutMs, what: "getUserMedia", onLate: stopStream });
  } catch (err) {
    const name = nameOf(err);
    const busy = name === "NotReadableError" || name === "AbortError";
    const e = new Error(
      name === "TimeoutError"
        ? "“CABLE Output” did not answer in time. Try again; if it keeps happening, restart the app."
        : busy
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
 * A device list that does not come within timeoutMs gives null; a close()
 * that does not finish within 2 s is not waited for.
 * @param {string} [deviceId]
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<number|null>}
 */
export async function readOutputRate(deviceId = "", { timeoutMs = NO_ANSWER_MS } = {}) {
  let ctx = null;
  try {
    if (deviceId) {
      const asking = globalThis.navigator.mediaDevices.enumerateDevices();
      const list = await bounded(asking, { ms: timeoutMs, what: "enumerateDevices" });
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
        await bounded(ctx.close(), { ms: PROBE_CLOSE_MS, what: "close()" });
      } catch {
        // Already closed, or it does not answer: the rate is known either way.
      }
    }
  }
}
