/**
 * The page inside the Accent Changer app: the Sanas key and tokens come from
 * the app's Rust side (Windows Credential Manager); the page never holds the
 * key for longer than it takes to hand it over.
 */
import { cleanKeyInput } from "../core/key-input.js";

export const name = "app";

/** Tauri rejects with the command's error text; make it an Error. */
async function call(command, args) {
  try {
    return await window.__TAURI__.core.invoke(command, args);
  } catch (err) {
    throw new Error(typeof err === "string" ? err : err?.message ?? String(err));
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
