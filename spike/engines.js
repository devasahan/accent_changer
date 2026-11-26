/**
 * Engines for the spike, all with one shape:
 *   const session = await engine.start({ input, onState, onDrop, signal })
 *   session.outputStream   processed audio (MediaStream)
 *   session.warmupMs       time from start until audio can flow
 *   session.droppedReason  why a session that was up stopped working, or null
 *   await session.stop()
 *
 * `input` is handed over: when a session ends, its tracks are stopped (the
 * Sanas SDK's WebRTC stack does that), so every session needs its own.
 * onState(state, reason) reports every state change. onDrop(reason) fires
 * once when a session that was up stops working: the Sanas SDK reports that
 * as "disconnected" (Media connection lost) or "failed" (authentication or
 * entitlement lost), never for our own stop(). Aborting `signal` while a
 * session is starting cancels it (nothing is left open).
 *
 * "sanas" is the real thing; "mock" delays and recolours the voice locally,
 * so every part of the page can be tried without spending credit.
 */
import { waitForMedia } from "./webrtc-stats.js";

let sdkModule = null;
let sdk = null; // the initialised SanasSDK, once initialize() succeeded
let initPromise = null; // the init attempt that is running or done

async function loadSdk() {
  if (!sdkModule) sdkModule = await import("../src/vendor/sanas-browser-sdk/index.js");
  return sdkModule;
}

async function fetchToken() {
  const res = await fetch("/token", { method: "POST", headers: { "X-Accent-Changer": "1" } });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      detail = JSON.parse(text).error ?? text;
    } catch {
      // plain text answer
    }
    throw new Error(`Token request failed (HTTP ${res.status}): ${String(detail).slice(0, 300)}`);
  }
  return JSON.parse(text);
}

/**
 * Initialise the Sanas SDK once per page; returns { initMs }. Callers that
 * arrive while an attempt is running share it (a second attempt would trip
 * the local server's one-token-per-second limit).
 */
export function connectSanas({ logLevel = "info" } = {}) {
  if (initPromise && sdk && !sdk.isInitialized()) {
    // It was up, but the SDK has given up since (authentication lost): start over.
    sdk = null;
    initPromise = null;
  }
  if (!initPromise) {
    const attempt = (async () => {
      const { SanasSDK } = await loadSdk();
      const instance = new SanasSDK();
      const t0 = performance.now();
      try {
        await instance.initialize({ tokenProvider: fetchToken, logLevel });
      } catch (err) {
        throw describeSdkError(err);
      }
      sdk = instance;
      return { initMs: Math.round(performance.now() - t0) };
    })();
    initPromise = attempt;
    attempt.catch(() => {
      if (initPromise === attempt) initPromise = null;
    });
  }
  return initPromise;
}

export async function disconnectSanas() {
  const instance = sdk;
  sdk = null;
  initPromise = null;
  if (instance) await instance.shutdown().catch(() => {});
}

const HINTS = {
  origin_not_allowed: "Add this page's origin (e.g. http://localhost:8080) under Project settings → Allowed origins in the Sanas Console.",
  authentication_failed:
    "Sanas refused the key. Stop the server, start it again and paste the key once (the server says whether Sanas accepts it); if it is still refused, check in the Sanas Console whether the key expired or was revoked.",
  model_not_entitled: "Your project isn't entitled to that model name. Copy the exact name (with any suffix) from the Sanas Console.",
  feature_not_entitled: "Remote Inferencing (accent translation) isn't enabled for your account. Ask Sanas support to enable it.",
  unsupported_sample_rate: "Use 8000, 16000 or 48000 Hz.",
  network_error: "A request to Sanas failed: check the internet connection, or a firewall blocking WebSockets.",
};

export function describeSdkError(err) {
  const code = err?.code;
  const message = String(err?.message ?? err);
  let hint = code && HINTS[code] ? ` ${HINTS[code]}` : "";
  // The SDK files every refused token request under authentication_failed,
  // also when this page's own server said no (no key loaded, Sanas
  // unreachable, too many requests). Its message already says what to do.
  const status = Number(/HTTP (\d{3})/.exec(message)?.[1]);
  if (code === "authentication_failed" && Number.isFinite(status) && ![400, 401, 403].includes(status)) hint = "";
  const e = new Error(`${message}${code ? ` [${code}]` : ""}.${hint}`);
  e.code = code;
  return e;
}

function abortError() {
  const e = new Error("Cancelled.");
  e.name = "AbortError";
  return e;
}

/** Resolve `promise`, or reject after `ms`, or as soon as `signal` aborts. */
function settle(promise, { ms, message, signal }) {
  let timer;
  let onAbort;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
      onAbort = () => reject(abortError());
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    }),
  ]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  });
}

export function sanasEngine({ modelName = "AT5.2", sampleRate = 16000, jitterBufferTargetMs, mediaTimeoutMs = 15000 } = {}) {
  return {
    name: "sanas",
    async start({ input, onState, onDrop, signal }) {
      await settle(connectSanas(), { ms: 30000, message: "Connecting to Sanas took longer than 30 s.", signal });
      const instance = sdk;
      const { ProcessorState } = await loadSdk();
      const t0 = performance.now();
      let up = false; // reached Ready
      let closing = false; // our own stop (or a failed start) is tearing it down
      let droppedReason = null;
      let markReady;
      let markFailed;
      const ready = new Promise((resolve, reject) => {
        markReady = resolve;
        markFailed = reject;
      });
      ready.catch(() => {}); // handled below; avoid an unhandled rejection after Ready
      const reachedReady = () => {
        if (up) return;
        up = true;
        markReady(performance.now() - t0);
      };
      let proc;
      try {
        proc = await instance.createAudioProcessor(
          { input, modelName, sampleRate, ...(Number.isFinite(jitterBufferTargetMs) ? { jitterBufferTargetMs } : {}) },
          {
            onStateChange: (state, reason) => {
              onState?.(state, reason);
              if (state === ProcessorState.Ready) reachedReady();
              else if (state === ProcessorState.Failed || state === ProcessorState.Disconnected) {
                if (!up) markFailed(new Error(`Sanas could not start the call: ${reason || state}`));
                else if (!closing && !droppedReason) {
                  droppedReason = reason || state;
                  onDrop?.(droppedReason);
                }
              }
            },
          },
        );
      } catch (err) {
        throw describeSdkError(err);
      }
      if (proc.getState() === ProcessorState.Ready) reachedReady();
      let readyMs;
      try {
        readyMs = await settle(ready, { ms: 20000, message: "Sanas did not answer the call within 20 s.", signal });
        const flowing = await waitForMedia({ timeoutMs: mediaTimeoutMs, cancel: () => Boolean(signal?.aborted || droppedReason) });
        if (signal?.aborted) throw abortError();
        if (droppedReason) throw new Error(`Sanas dropped the call while it was connecting: ${droppedReason}`);
        if (!flowing) {
          throw new Error(
            `Sanas answered, but no audio connection came up within ${mediaTimeoutMs / 1000} s. ` +
              "A firewall, VPN or network that blocks WebRTC (UDP) is the usual cause: try another network.",
          );
        }
      } catch (err) {
        closing = true;
        await instance.destroyAudioProcessor(proc).catch(() => {});
        throw err;
      }
      const warmupMs = Math.round(performance.now() - t0);
      return {
        outputStream: proc.outputStream,
        warmupMs,
        readyMs: Math.round(readyMs),
        getState: () => proc.getState(),
        get droppedReason() {
          return droppedReason;
        },
        async stop() {
          if (closing) return;
          closing = true;
          await instance.destroyAudioProcessor(proc).catch(() => {});
        },
      };
    },
  };
}

/**
 * Local stand-in: fixed delay plus a brighter tone, through its own
 * AudioContext like the SDK. It behaves like the SDK where the page depends
 * on it: `connectMs` of start-up, a drop after `failAfterSec` reported as
 * "disconnected" (Media connection lost) with the output going silent, and
 * the input's tracks stopped when the session ends or drops.
 */
export function mockEngine({ delayMs = 300, failAfterSec = null, connectMs = 0 } = {}) {
  return {
    name: "mock",
    async start({ input, onState, onDrop, signal }) {
      onState?.("initializing", "created");
      const t0 = performance.now();
      if (connectMs > 0) {
        try {
          await settle(new Promise((resolve) => setTimeout(resolve, connectMs)), { ms: connectMs + 60000, message: "", signal });
        } catch (err) {
          input.getTracks().forEach((t) => t.stop());
          throw err;
        }
      }
      if (signal?.aborted) {
        input.getTracks().forEach((t) => t.stop());
        throw abortError();
      }
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(input);
      const delay = ctx.createDelay(5);
      delay.delayTime.value = Math.max(0, delayMs) / 1000;
      const tone = ctx.createBiquadFilter();
      tone.type = "peaking";
      tone.frequency.value = 2500;
      tone.Q.value = 0.8;
      tone.gain.value = 6;
      const level = ctx.createGain();
      level.gain.value = 0.8;
      const out = ctx.createMediaStreamDestination();
      source.connect(delay).connect(tone).connect(level).connect(out);
      if (ctx.state !== "running") await ctx.resume().catch(() => {});
      let state = "ready";
      let droppedReason = null;
      let closed = false;
      let failTimer = null;
      if (Number.isFinite(failAfterSec) && failAfterSec > 0) {
        failTimer = setTimeout(() => {
          if (closed) return;
          state = "disconnected";
          droppedReason = "Media connection lost";
          level.gain.value = 0;
          input.getTracks().forEach((t) => t.stop()); // like SIP.js closing the call
          onState?.("disconnected", droppedReason);
          onDrop?.(droppedReason);
        }, failAfterSec * 1000);
      }
      onState?.("ready", "connected");
      return {
        outputStream: out.stream,
        warmupMs: Math.round(performance.now() - t0),
        readyMs: Math.round(performance.now() - t0),
        getState: () => state,
        get droppedReason() {
          return droppedReason;
        },
        async stop() {
          if (closed) return;
          closed = true;
          clearTimeout(failTimer);
          state = "disconnected";
          onState?.("disconnected", "Destroyed by consumer");
          source.disconnect();
          input.getTracks().forEach((t) => t.stop());
          await ctx.close().catch(() => {});
        },
      };
    },
  };
}
