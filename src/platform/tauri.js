/**
 * The page inside the Accent Changer app: the Sanas key and tokens come from
 * the app's Rust side (Windows Credential Manager); the page never holds the
 * key for longer than it takes to hand it over. The settings file, the
 * window, the microphone permission and the log file are the Rust side's too.
 */
import { cleanKeyInput } from "../core/key-input.js";
import { redact } from "../core/redact.js";

export const name = "app";

/** Tauri rejects with the command's error text; make it an Error. */
async function call(command, args) {
  try {
    return await window.__TAURI__.core.invoke(command, args);
  } catch (err) {
    throw new Error(typeof err === "string" ? err : err?.message ?? String(err));
  }
}

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

/**
 * The settings text as JSON: the parsed value, or the text itself when it is
 * not JSON (validateSettings then reports it and uses the defaults). A byte
 * order mark from a hand edit in Notepad is not part of the JSON.
 */
function parseSettings(text) {
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(String(text).replace(/^﻿/, ""));
  } catch {
    return text;
  }
}

/** For the Sanas SDK: a fresh token response object. */
export async function tokenProvider() {
  return JSON.parse(await call("sanas_token"));
}

/** { saved, tail } where tail is the key's last 4 characters. */
export const keyStatus = () => call("key_status");

/** Check a pasted key with Sanas and save it: { checked: "accepted" | "unknown", note, tail }. */
export async function saveKey(raw) {
  const { value } = cleanKeyInput(raw);
  return call("key_set", { key: value });
}

export const deleteKey = () => call("key_delete");

/** { name, version, build }: build is the CI tag or branch and short commit, or "local". */
export const appInfo = () => call("app_info");

/**
 * The saved settings, read from settings.json in the app's folder on this PC.
 * Never throws: { raw, error }. raw is the parsed file (null when there is no
 * file yet; the text itself when it is not JSON); error is why the file could
 * not be read (raw is then null), else null.
 */
export async function loadSettings() {
  try {
    return { raw: parseSettings(await call("settings_load")), error: null };
  } catch (err) {
    return { raw: null, error: messageOf(err) };
  }
}

/** Write the settings (already checked with validateSettings) to settings.json. Throws when it fails. */
export async function saveSettings(settings) {
  await call("settings_save", { json: JSON.stringify(settings) });
}

/**
 * Hide the window, and the taskbar button with it, for whole `minutes`
 * (1 to 120). It comes back by itself without taking the keyboard from the
 * meeting. → { hiddenAtMs, showAtMs, minutes } (times in ms since 1970).
 * Rust checks the minutes too; checking here first keeps Tauri's own
 * type error ("invalid args …") for a fraction or a text off the page.
 */
export async function hideWindowFor(minutes) {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) throw new Error("Hide for 1 to 120 minutes.");
  return call("window_hide_for", { minutes });
}

/** { visible, minimized, focused }, as Windows sees the window now. */
export const windowState = () => call("window_state");

/**
 * Grant the microphone to the app's own page in WebView2's saved permissions
 * (output devices ride on it). Never throws: { ok, note }.
 */
export async function allowMicPermission() {
  try {
    return { ok: true, note: messageOf(await call("mic_permission_allow")) };
  } catch (err) {
    return { ok: false, note: messageOf(err) };
  }
}

/**
 * One line for the app's log file. Fire and forget: never throws and never
 * waits. The text is redacted here and again on the Rust side; callers pass
 * codes and numbers only, never device names.
 */
export function log(level, text) {
  try {
    call("log_line", { level: String(level ?? "info"), text: redact(text) }).catch(() => {});
  } catch {
    // A log line is never worth an error.
  }
}
