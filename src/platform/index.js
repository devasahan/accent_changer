/**
 * The shell the page runs in: the Tauri app (window.__TAURI__ is there) or
 * Edge dev mode. Both offer the same functions.
 */
import * as app from "./tauri.js";
import * as browser from "./browser.js";

export const platform = globalThis.__TAURI__?.core?.invoke ? app : browser;
