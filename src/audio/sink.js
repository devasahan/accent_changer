/**
 * Sends the graph's output (outBus) to one playback device: "CABLE Input",
 * so that the meeting app hears the voice through "CABLE Output".
 *
 * Methods, in this order:
 *  - "context": AudioContext.setSinkId(device), then outBus → the context's
 *    destination. The best route: no extra buffer and no extra clock.
 *  - "element": outBus → a MediaStream → an <audio> element whose setSinkId
 *    is the device. Only when the context route was refused (NotAllowedError
 *    or SecurityError) for a device the list shows, or when the Advanced test
 *    setting asks for it. The context itself then plays nothing; its own
 *    sink is the headset's earpiece when the microphone has one (same
 *    physical device), so the graph runs on the headset's clock.
 *  - once per page, when both were refused: the app's permission fix (Rust
 *    grants the microphone to the page in WebView2's saved permissions; the
 *    right to choose a playback device rides on it), then both again.
 * A recovery after a fault tries only the method that worked last, never
 * the permission fix. Every try is recorded (tried) for the results.
 *
 * Errors become a SinkError whose kind the recovery reducer understands.
 * Chromium's error messages can hold the 64-hex device id, so they are
 * redacted before they are kept.
 */
import { settle } from "../core/async.js";
import { redact } from "../core/redact.js";

const KINDS = ["missing", "blocked", "transient", "needs-gesture"];

const SINK_TEXTS = Object.freeze({
  missing: "The playback device for your voice is not there.",
  blocked: "Windows or WebView2 did not let the app play into the playback device for your voice.",
  transient: "The app could not switch its sound to the playback device for your voice yet.",
  "needs-gesture": "The page needs one click before it may play sound.",
});

/** Errors that mean "not allowed to use that playback device". */
const REFUSED = new Set(["NotAllowedError", "SecurityError"]);

/** The permission fix runs once per page load, whatever it answered. */
let permissionTried = false;

/**
 * A playback route that could not be set up. kind: "missing" | "blocked" |
 * "transient" | "needs-gesture"; tried: every try, as in a Route;
 * errorName: the browser's name of the last error.
 */
export class SinkError extends Error {
  /**
   * @param {string} [kind]
   * @param {string} [message]
   * @param {{tried?: object[], errorName?: string|null}} [details]
   */
  constructor(kind = "transient", message = "", { tried = [], errorName = null } = {}) {
    const k = KINDS.includes(kind) ? kind : "transient";
    super(message || SINK_TEXTS[k]);
    this.name = "SinkError";
    this.kind = k;
    this.tried = tried;
    this.errorName = errorName;
  }
}

function nameOf(err) {
  return err && typeof err === "object" && typeof err.name === "string" && err.name ? err.name : "Error";
}

function messageOf(err) {
  if (err && typeof err === "object" && typeof err.message === "string") return err.message;
  return err === undefined || err === null ? "" : String(err);
}

function named(name, message) {
  const e = new Error(message);
  e.name = name;
  return e;
}

/** `promise`, or a TimeoutError after `ms` (settle's own timeout error, renamed). */
async function timed(promise, ms, what) {
  const message = `${what} timed out`;
  try {
    return await settle(promise, { ms, message });
  } catch (err) {
    if (err instanceof Error && err.name === "Error" && err.message === message) err.name = "TimeoutError";
    throw err;
  }
}

const sinkIdText = (ctx) => (typeof ctx.sinkId === "string" ? ctx.sinkId : "");

/** "context" or "element": the method without "-after-permission". */
export function methodBase(method) {
  return typeof method === "string" && method.startsWith("element") ? "element" : "context";
}

/** The context route: setSinkId on the graph's own context, then outBus → destination. */
async function viaContext(ctx, deviceId, { source, timeoutMs }) {
  await timed(ctx.setSinkId(deviceId), timeoutMs, "setSinkId");
  if (sinkIdText(ctx) !== deviceId) throw named("InvalidStateError", "The audio engine did not switch to that device.");
  source.connect(ctx.destination);
  let connected = true;
  const disconnect = () => {
    if (!connected) return;
    connected = false;
    try {
      source.disconnect(ctx.destination);
    } catch {
      // Already disconnected (the context closed).
    }
  };
  return {
    deviceId,
    element: null,
    contextSinkId: null,
    dispose: disconnect,
    silence: disconnect,
    onLost() {},
    progress: () => null,
  };
}

/**
 * The element route: outBus → MediaStreamAudioDestination → <audio> with
 * setSinkId. The element starts muted and is unmuted only once its sink is
 * the device, so nothing reaches Windows' default device (the user's
 * headphones) on the way.
 */
async function viaElement(ctx, deviceId, { source, contextSinkId, timeoutMs, tried }) {
  let ownSink = null;
  if (contextSinkId) {
    try {
      await timed(ctx.setSinkId(contextSinkId), timeoutMs, "setSinkId");
      ownSink = contextSinkId;
    } catch (err) {
      tried.push({ method: "context-sink", ok: false, errorName: nameOf(err), errorMessage: redact(messageOf(err)) });
    }
  }
  const tap = ctx.createMediaStreamDestination();
  tap.channelCount = 1;
  source.connect(tap);
  const el = new Audio();
  el.muted = true;
  el.srcObject = tap.stream;
  let ours = false; // a pause the route itself makes
  const listeners = new AbortController();
  const lostCallbacks = [];
  let lost = false;
  const loseOnce = () => {
    if (lost || ours) return;
    lost = true;
    for (const cb of lostCallbacks) {
      try {
        cb();
      } catch {
        // A listener's own problem.
      }
    }
  };
  const release = () => {
    ours = true;
    listeners.abort();
    try {
      el.muted = true;
      el.pause();
    } catch {
      // Nothing to pause.
    }
    el.srcObject = null;
    try {
      source.disconnect(tap);
    } catch {
      // Already disconnected.
    }
    for (const track of tap.stream.getTracks()) track.stop();
  };
  try {
    try {
      await timed(el.play(), timeoutMs, "play()");
    } catch (err) {
      if (nameOf(err) === "NotAllowedError") {
        const e = named("NotAllowedError", "The page may not play sound before a click.");
        e.autoplay = true;
        throw e;
      }
      throw err;
    }
    await timed(el.setSinkId(deviceId), timeoutMs, "setSinkId");
    el.muted = false;
  } catch (err) {
    release();
    throw err;
  }
  el.addEventListener("error", loseOnce, { signal: listeners.signal });
  el.addEventListener("pause", loseOnce, { signal: listeners.signal });
  return {
    deviceId,
    element: el,
    contextSinkId: ownSink,
    dispose: release,
    // Mute and pause at once, without reporting it lost (the graph reports it).
    silence: release,
    onLost(callback) {
      if (typeof callback === "function") lostCallbacks.push(callback);
    },
    progress: () => ({ currentTime: el.currentTime, paused: el.paused }),
  };
}

/** The SinkError for a list of failed tries. */
function sinkErrorOf(failures, { deviceListed, tried }) {
  const last = failures[failures.length - 1];
  const errorName = last ? last.name : null;
  let kind = "transient";
  if (failures.some((f) => f.autoplay)) kind = "needs-gesture";
  else if (failures.length > 0 && failures.every((f) => REFUSED.has(f.name))) kind = "blocked";
  else if (!deviceListed && failures.some((f) => f.name === "NotFoundError")) kind = "missing";
  return new SinkError(kind, "", { tried, errorName });
}

/**
 * Route `source` (the graph's outBus) to the playback device `deviceId` in
 * `ctx`.
 * → Route { method, deviceId, tried, element|null, contextSinkId|null,
 *           dispose(), onLost(callback), progress() → {currentTime, paused} | null,
 *           silence() }
 *   method: "context" | "element" | "context-after-permission" |
 *   "element-after-permission"; tried: [{ method, ok, errorName?,
 *   errorMessage? (redacted), note? }] ("context-sink" entries record a
 *   failed switch of the context's own sink on the element route; it is then
 *   left on Windows' default device, which plays nothing).
 * mode "full" (first start, user changes): prefer "element" tries only the
 * element; else the context, then the element only after the context was
 * refused (NotAllowedError, SecurityError) for a listed device; when every
 * try was refused, allowPermission is a function and the permission fix has
 * not run in this page: the fix, then the same methods again
 * ("…-after-permission") when it answered ok.
 * mode "recover" (fault outages): only lastMethod's base, plus the element
 * after a refused context on a listed device; never the permission fix.
 * Throws a SinkError: "needs-gesture" when <audio>.play() was refused before
 * a click; "blocked" when every try was refused; "missing" when the device
 * is not listed and a try said NotFoundError; else "transient".
 * @param {AudioContext} ctx
 * @param {string} deviceId
 * @param {object} options
 */
export async function routeOutput(
  ctx,
  deviceId,
  {
    source,
    mode = "full",
    lastMethod = null,
    prefer = null,
    deviceListed = true,
    contextSinkId = null,
    allowPermission = null,
    timeoutMs = 5000,
  } = {},
) {
  const tried = [];
  const failures = [];
  const onlyElement = mode === "recover" ? methodBase(lastMethod ?? "context") === "element" : prefer === "element";

  const attempt = async (method) => {
    try {
      const route =
        methodBase(method) === "element"
          ? await viaElement(ctx, deviceId, { source, contextSinkId, timeoutMs, tried })
          : await viaContext(ctx, deviceId, { source, timeoutMs });
      tried.push({ method, ok: true });
      return { method, tried, ...route };
    } catch (err) {
      const name = nameOf(err);
      tried.push({ method, ok: false, errorName: name, errorMessage: redact(messageOf(err)) });
      failures.push({ method, name, autoplay: err?.autoplay === true });
      return null;
    }
  };

  const refused = (f) => f && REFUSED.has(f.name) && !f.autoplay;

  const chain = async (suffix) => {
    if (onlyElement) return attempt(`element${suffix}`);
    const viaCtx = await attempt(`context${suffix}`);
    if (viaCtx) return viaCtx;
    if (deviceListed && refused(failures[failures.length - 1])) return attempt(`element${suffix}`);
    return null;
  };

  const first = await chain("");
  if (first) return first;

  if (
    mode === "full" &&
    typeof allowPermission === "function" &&
    !permissionTried &&
    failures.length > 0 &&
    failures.every(refused)
  ) {
    permissionTried = true;
    let answer;
    try {
      answer = await allowPermission();
    } catch (err) {
      answer = { ok: false, note: messageOf(err) };
    }
    const ok = Boolean(answer && answer.ok);
    tried.push({ method: "permission", ok, note: redact(String(answer?.note ?? "")) });
    if (ok) {
      const again = await chain("-after-permission");
      if (again) return again;
    }
  }
  throw sinkErrorOf(failures, { deviceListed, tried });
}
