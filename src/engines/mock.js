/**
 * The Mock engine: a local stand-in for Sanas with the same shape (see
 * sanas.js). It delays and recolours the voice through its own AudioContext,
 * so every part of the probe and the app can be tried without spending
 * credit, and it fails the way the SDK does.
 */
import { abortError, settle } from "../core/async.js";

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
