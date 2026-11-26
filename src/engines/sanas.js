/**
 * The Sanas engine, shared by the probe page and the app. Every engine has
 * one shape:
 *   const session = await engine.start({ input, onState, onDrop, signal })
 *   session.outputStream   processed audio (MediaStream)
 *   session.warmupMs       time from start until audio can flow
 *   session.droppedReason  why a session that was up stopped working, or null
 *   await session.stop()
 *
 * `input` is handed over: when a session ends, its tracks are stopped (the
 * Sanas SDK's WebRTC stack does that), so every session needs its own.
 * onState(state, reason) reports every state change. onDrop(reason) fires
 * once when a session that was up stops working: the SDK reports that as
 * "disconnected" (Media connection lost) or "failed" (authentication or
 * entitlement lost), never for our own stop(). Aborting `signal` while a
 * session is starting cancels it (nothing is left open).
 *
 * Call configureSanas() once with a token provider: the probe asks its local
 * server, the app asks its Rust side. The key itself never reaches the page.
 */
import { waitForMedia } from "./webrtc-watch.js";
import { abortError, settle } from "../core/async.js";
import { describeSdkError } from "./sanas-errors.js";

let config = { tokenProvider: null, where: "probe" };
let sdkModule = null;
let sdk = null; // the initialised SanasSDK, once initialize() succeeded
let initPromise = null; // the init attempt that is running or done

/**
 * tokenProvider: async () => the identity service's token response
 * ({ access_token, user_id, group_id, ... }). where: "probe" or "app", for
 * the hints in error messages.
 */
export function configureSanas({ tokenProvider, where = "probe" }) {
  config = { tokenProvider, where };
}

async function loadSdk() {
  if (!sdkModule) sdkModule = await import("../vendor/sanas-browser-sdk/index.js");
  return sdkModule;
}

const describe = (err) => describeSdkError(err, { where: config.where });

/**
 * Initialise the Sanas SDK once per page; returns { initMs }. Callers that
 * arrive while an attempt is running share it.
 */
export function connectSanas({ logLevel = "info" } = {}) {
  if (initPromise && sdk && !sdk.isInitialized()) {
    // It was up, but the SDK has given up since (authentication lost): start over.
    sdk = null;
    initPromise = null;
  }
  if (!initPromise) {
    const attempt = (async () => {
      if (!config.tokenProvider) throw new Error("Sanas is not set up: no token provider (configureSanas).");
      const { SanasSDK } = await loadSdk();
      const instance = new SanasSDK();
      const t0 = performance.now();
      try {
        await instance.initialize({ tokenProvider: config.tokenProvider, logLevel });
      } catch (err) {
        throw describe(err);
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
        throw describe(err);
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
