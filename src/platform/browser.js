/**
 * Edge dev mode: the same page opened from the local server
 * (node spike/serve.mjs, then http://localhost:8080/src/). The server holds
 * the Sanas key in its memory and swaps it for tokens at POST /token. The
 * settings live in this browser's storage for the page; the window, the
 * permission fix and the log file exist only in the installed app.
 */
import { redact } from "../core/redact.js";

export const name = "browser";

/**
 * Where the settings live in Edge dev mode. Not one of the probe's
 * accentChanger.* keys: the same server (localhost:8080) serves both pages.
 */
const SETTINGS_KEY = "accentChanger.app.settings";

/** The text of anything thrown, without ever throwing itself. */
function messageOf(err) {
  try {
    if (typeof err === "string") return err;
    if (typeof err?.message === "string" && err.message) return err.message;
    return String(err);
  } catch {
    return "unknown error";
  }
}

/** The settings text as JSON: the parsed value, or the text itself when it is not JSON. */
function parseSettings(text) {
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(String(text).replace(/^\uFEFF/, ""));
  } catch {
    return text;
  }
}

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

/** Step 1 already says "Edge dev mode"; build "dev" marks results that came from it. */
export async function appInfo() {
  return { name: "Accent Changer", version: "dev", build: "dev" };
}

/**
 * The saved settings, from this browser's storage. Never throws:
 * { raw, error }, as in the app (raw null when nothing is saved yet).
 */
export async function loadSettings() {
  try {
    return { raw: parseSettings(localStorage.getItem(SETTINGS_KEY)), error: null };
  } catch (err) {
    return { raw: null, error: messageOf(err) };
  }
}

/** Save the settings (already checked with validateSettings). Throws when the storage refuses. */
export async function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export async function hideWindowFor() {
  throw new Error("Hiding the window works only in the installed app. In Edge, minimize the window instead.");
}

/** { visible, minimized, focused }: a page in Edge cannot tell whether its window is minimized. */
export async function windowState() {
  return { visible: document.visibilityState === "visible", minimized: null, focused: document.hasFocus() };
}

/** The WebView2 permission fix exists only in the app. Never throws. */
export async function allowMicPermission() {
  return { ok: false, note: "not available in Edge dev mode" };
}

/**
 * One line for the developer console (Edge dev mode has no log file). Never
 * throws, and never logs at the console's error level: the headless test
 * counts those as failures.
 */
export function log(level, text) {
  try {
    const line = redact(text);
    if (level === "warn" || level === "error") console.warn(line);
    else console.info(line);
  } catch {
    // A log line is never worth an error.
  }
}
