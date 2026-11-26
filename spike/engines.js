/**
 * Engines for the spike, all with one shape:
 *   const session = await engine.start({ input, onState })
 *   session.outputStream   processed audio (MediaStream)
 *   session.warmupMs       time from start until audio flows
 *   await session.stop()
 * "sanas" is the real thing; "mock" delays and recolours the voice locally,
 * so every part of the page can be tried without spending credit.
 */

let sdkModule = null;
let sdk = null;
let initInfo = null;

async function loadSdk() {
  if (!sdkModule) sdkModule = await import("../src/vendor/sanas-browser-sdk/index.js");
  return sdkModule;
}

async function fetchToken() {
  const res = await fetch("/token", { method: "POST", headers: { "X-Accent-Switch": "1" } });
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

/** Initialise the Sanas SDK once per page; returns { initMs }. */
export async function connectSanas({ logLevel = "info" } = {}) {
  if (sdk?.isInitialized()) return initInfo;
  const { SanasSDK } = await loadSdk();
  sdk = new SanasSDK();
  const t0 = performance.now();
  try {
    await sdk.initialize({ tokenProvider: fetchToken, logLevel });
  } catch (err) {
    sdk = null;
    throw describeSdkError(err);
  }
  initInfo = { initMs: Math.round(performance.now() - t0) };
  return initInfo;
}

export async function disconnectSanas() {
  if (sdk) {
    try {
      await sdk.shutdown();
    } finally {
      sdk = null;
      initInfo = null;
    }
  }
}

const HINTS = {
  origin_not_allowed: "Add this page's origin (e.g. http://localhost:8080) under Project settings → Allowed origins in the Sanas Console.",
  authentication_failed: "The key was refused or the token was malformed: check the key in the Sanas Console (expired? revoked?).",
  model_not_entitled: "Your project isn't entitled to that model name. Copy the exact name (with any suffix) from the Sanas Console.",
  feature_not_entitled: "Remote Inferencing (accent translation) isn't enabled for your account. Ask Sanas support to enable it.",
  unsupported_sample_rate: "Use 8000, 16000 or 48000 Hz.",
  network_error: "A request to Sanas failed: check the internet connection, or a firewall blocking WebSockets.",
};

function describeSdkError(err) {
  const code = err?.code;
  const hint = code && HINTS[code] ? ` ${HINTS[code]}` : "";
  const e = new Error(`${err?.message ?? err}${code ? ` [${code}]` : ""}.${hint}`);
  e.code = code;
  return e;
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function sanasEngine({ modelName = "AT5.2", sampleRate = 16000, jitterBufferTargetMs } = {}) {
  return {
    name: "sanas",
    async start({ input, onState }) {
      await connectSanas();
      const { ProcessorState } = await loadSdk();
      const t0 = performance.now();
      let markReady;
      let markFailed;
      const ready = new Promise((resolve, reject) => {
        markReady = resolve;
        markFailed = reject;
      });
      ready.catch(() => {}); // handled below; avoid an unhandled rejection after Ready
      let proc;
      try {
        proc = await sdk.createAudioProcessor(
          { input, modelName, sampleRate, ...(Number.isFinite(jitterBufferTargetMs) ? { jitterBufferTargetMs } : {}) },
          {
            onStateChange: (state, reason) => {
              onState?.(state, reason);
              if (state === ProcessorState.Ready) markReady(performance.now() - t0);
              else if (state === ProcessorState.Failed) markFailed(new Error(`Sanas processor failed: ${reason || "no reason given"}`));
            },
          },
        );
      } catch (err) {
        throw describeSdkError(err);
      }
      if (proc.getState() === ProcessorState.Ready) markReady(performance.now() - t0);
      let warmupMs;
      try {
        warmupMs = await withTimeout(ready, 20000, "Sanas did not start sending audio within 20 s.");
      } catch (err) {
        await sdk.destroyAudioProcessor(proc).catch(() => {});
        throw err;
      }
      const openedAt = performance.now();
      let closed = false;
      return {
        outputStream: proc.outputStream,
        warmupMs: Math.round(warmupMs),
        openedAt,
        getState: () => proc.getState(),
        updateInput: (stream) => proc.updateInputStream(stream),
        async stop() {
          if (closed) return;
          closed = true;
          await sdk.destroyAudioProcessor(proc).catch(() => {});
        },
      };
    },
  };
}

/** Local stand-in: fixed delay plus a brighter tone, through its own AudioContext like the SDK. */
export function mockEngine({ delayMs = 300, failAfterSec = null } = {}) {
  return {
    name: "mock",
    async start({ input, onState }) {
      onState?.("initializing", "");
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
      let failTimer = null;
      if (Number.isFinite(failAfterSec) && failAfterSec > 0) {
        failTimer = setTimeout(() => {
          state = "failed";
          level.gain.value = 0;
          onState?.("failed", "Mock: simulated media connection loss");
        }, failAfterSec * 1000);
      }
      onState?.("ready", "");
      return {
        outputStream: out.stream,
        warmupMs: 0,
        openedAt: performance.now(),
        getState: () => state,
        updateInput: async () => {},
        async stop() {
          clearTimeout(failTimer);
          state = "disconnected";
          source.disconnect();
          await ctx.close().catch(() => {});
        },
      };
    },
  };
}
