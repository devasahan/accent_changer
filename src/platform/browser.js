/**
 * Edge dev mode: the same page opened from the local server
 * (node spike/serve.mjs, then http://localhost:8080/src/). The server holds
 * the Sanas key in its memory and swaps it for tokens at POST /token.
 */

export const name = "browser";

/** For the Sanas SDK: a fresh token response object from the local server. */
export async function tokenProvider() {
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

export async function keyStatus() {
  const res = await fetch("/health", { cache: "no-store" });
  const health = await res.json();
  return { saved: Boolean(health.keyLoaded), tail: null, heldBy: "server" };
}

const SERVER_HOLDS_IT = "In Edge dev mode the key lives in the server window: stop  node spike/serve.mjs  with Ctrl+C, start it again and paste the key there.";

export async function saveKey() {
  throw new Error(SERVER_HOLDS_IT);
}

export async function deleteKey() {
  throw new Error(SERVER_HOLDS_IT);
}

export async function appInfo() {
  return { name: "Accent Changer (Edge dev mode)", version: "dev" };
}
