/**
 * The probe's engines: the app's shared modules in src/engines, with the
 * Sanas token from this page's local server (spike/serve.mjs keeps the key;
 * the page only ever sees short-lived tokens). Every engine has one shape:
 *   const session = await engine.start({ input, onState, onDrop, signal })
 * (see src/engines/sanas.js).
 *
 * "sanas" is the real thing; "mock" delays and recolours the voice locally,
 * so every part of the page can be tried without spending credit.
 */
import { configureSanas } from "../src/engines/sanas.js";

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

configureSanas({ tokenProvider: fetchToken, where: "probe" });

export { connectSanas, disconnectSanas, sanasEngine } from "../src/engines/sanas.js";
export { describeSdkError } from "../src/engines/sanas-errors.js";
export { mockEngine } from "../src/engines/mock.js";
