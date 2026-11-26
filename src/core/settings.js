/**
 * The app's settings: what the settings file holds, its defaults, and the
 * check every loaded or edited copy goes through.
 *
 * The Sanas API key is never a setting: it lives in Windows Credential
 * Manager. Anything in the file whose name looks like a key, token, secret,
 * password or credential is dropped and reported, so a hand-edited or copied
 * settings file cannot carry a key into backups, sync folders or a
 * diagnostics report. Every other value is checked and, when it is wrong,
 * replaced by its default: the app always starts with complete settings, and
 * a broken file never stops it on the day of an interview.
 *
 * Pure: no file access. The caller reads and writes the JSON.
 */
import { redact } from "./redact.js";

/** The settings a new install starts with. Frozen all the way down: copy before changing. */
export const DEFAULTS = Object.freeze({
  version: 1,
  micDeviceId: "",
  micLabel: "",
  cableDeviceId: "",
  cableLabel: "",
  modelName: "AT5.2",
  voiceType: null,
  sampleRate: 48000,
  mode: "interview",
  hotkeyOwn: "Ctrl+Alt+B",
  hotkeyConvert: "Ctrl+Alt+N",
  startWithWindows: true,
  lipSync: Object.freeze({ enabled: false, totalMs: null, obsOffsetMs: 0 }),
  budget: Object.freeze({ capUsd: 10, keyExpiresOn: null }),
  obsPath: "",
});

/** Why a key-like setting was dropped (the text the app shows). */
export const SECRET_MESSAGE = "API keys are kept in Windows Credential Manager, not in settings";

/**
 * Setting names that look like a secret; the known names that only contain
 * "key" are not, however they are capitalised (a hand-edited "HotkeyOwn" is
 * an unknown name, dropped quietly, not a key the user put in the file).
 */
const SECRET_NAME = /key|token|secret|password|credential/i;
const NOT_SECRET = new Set(["hotkeyown", "hotkeyconvert", "keyexpireson"]);

const VOICE_TYPES = ["masculine", "feminine"];
const SAMPLE_RATES = [16000, 48000];
const MODES = ["interview", "practice"];
const MAX_LIP_SYNC_MS = 800;
/** OBS's video delay is the lip-sync total plus this fine adjustment (20 ms steps by ear); a second either way is plenty. */
const MAX_OBS_OFFSET_MS = 1000;
/** A model name as the Sanas Console shows it: AT5.2, AT5.2_Masculine. */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A settings file nested deeper than this is not ours; stop looking for keys in it. */
const MAX_DEPTH = 8;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const absent = (v) => v === undefined || v === null;
const numberIn = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

/**
 * True when redact() would hide part of `text`: a key, token or id pasted in
 * by mistake. In a Windows path ("C:\…", "C:/…", "\\server\…") either slash
 * separates parts, so "C:/Program Files/obs-studio/bin/64bit/obs64.exe" is
 * checked part by part and is not taken for a base64 key.
 */
function looksLikeSecret(text, isPath = false) {
  const checked = isPath && /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(text) ? text.replace(/\//g, "\\") : text;
  return redact(checked) !== checked;
}

/** A real calendar date "YYYY-MM-DD" (no 30 February). */
function isIsoDate(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return false;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return date.getUTCFullYear() === Number(m[1]) && date.getUTCMonth() === Number(m[2]) - 1 && date.getUTCDate() === Number(m[3]);
}

/** Every key-like name anywhere in the input, reported once each (by name, never by value). */
function reportSecrets(value, path, errors, depth) {
  if (value === null || typeof value !== "object" || depth > MAX_DEPTH) return;
  for (const [key, child] of Object.entries(value)) {
    const where = path ? `${path}.${key}` : key;
    // redact(): a name that is itself key-like is not repeated in the message.
    if (SECRET_NAME.test(key) && !NOT_SECRET.has(key.toLowerCase())) errors.push(`Removed "${redact(where)}": ${SECRET_MESSAGE}.`);
    else reportSecrets(child, where, errors, depth + 1);
  }
}

const MODIFIERS = {
  ctrl: "Ctrl",
  control: "Ctrl",
  // Tauri's names for "Ctrl on Windows, Cmd on a Mac".
  commandorcontrol: "Ctrl",
  commandorctrl: "Ctrl",
  cmdorctrl: "Ctrl",
  cmdorcontrol: "Ctrl",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  // The Windows key; Tauri calls it Super.
  super: "Super",
  win: "Super",
  windows: "Super",
  meta: "Super",
  cmd: "Super",
  command: "Super",
};
const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Super"];

/** Named keys (lower case → the spelling Tauri's global shortcuts use); `true` = it types a character. */
const NAMED_KEYS = new Map(
  [
    ["Space", true, "spacebar"],
    ["Backquote", true, "`"],
    ["Minus", true, "-"],
    ["Equal", true, "="],
    ["BracketLeft", true, "["],
    ["BracketRight", true, "]"],
    ["Backslash", true, "\\"],
    ["Semicolon", true, ";"],
    ["Quote", true, "'"],
    ["Comma", true, ","],
    ["Period", true, "."],
    ["Slash", true, "/"],
    ["Enter", false, "return"],
    ["Tab", false],
    ["Backspace", false],
    ["Delete", false, "del"],
    ["Insert", false, "ins"],
    ["Home", false],
    ["End", false],
    ["PageUp", false, "pgup"],
    ["PageDown", false, "pgdn"],
    ["Up", false, "arrowup"],
    ["Down", false, "arrowdown"],
    ["Left", false, "arrowleft"],
    ["Right", false, "arrowright"],
    ["Escape", false, "esc"],
    ["PrintScreen", false],
    ["ScrollLock", false],
    ["Pause", false],
    ["NumpadAdd", true],
    ["NumpadSubtract", true],
    ["NumpadMultiply", true],
    ["NumpadDivide", true],
    ["NumpadDecimal", true],
    ["NumpadEnter", false],
    ["AudioVolumeUp", false],
    ["AudioVolumeDown", false],
    ["AudioVolumeMute", false],
    ["MediaPlayPause", false],
    ["MediaStop", false],
    ["MediaTrackNext", false],
    ["MediaTrackPrevious", false],
  ].flatMap(([name, types, alias]) => {
    const key = { name, types };
    return alias ? [[name.toLowerCase(), key], [alias, key]] : [[name.toLowerCase(), key]];
  }),
);

/** The key part of a hotkey: { name, types } or null. */
function keyOf(part) {
  const lower = part.toLowerCase();
  let m = /^(?:key)?([a-z])$/.exec(lower);
  if (m) return { name: m[1].toUpperCase(), types: true };
  m = /^(?:digit)?([0-9])$/.exec(lower);
  if (m) return { name: m[1], types: true };
  m = /^(?:numpad|num)([0-9])$/.exec(lower);
  if (m) return { name: `Numpad${m[1]}`, types: true };
  m = /^f([1-9]|1[0-9]|2[0-4])$/.exec(lower);
  if (m) return { name: `F${m[1]}`, types: false };
  return NAMED_KEYS.get(lower) ?? null;
}

/**
 * Shortcuts that are not letters but that Windows or every app needs: closing
 * a window (Alt+F4 would close the meeting), switching windows, the window
 * and Start menus, the security screen and the Task Manager. Letters are
 * covered by the two-modifier rule in normalizeHotkey.
 */
const TAKEN = new Set(["Alt+F4", "Alt+Tab", "Alt+Escape", "Alt+Space", "Ctrl+Escape", "Ctrl+Alt+Delete", "Ctrl+Shift+Escape", "Super+Tab"]);

/** The modifiers and key of a hotkey in canonical form, or null when it is not modifiers and one key. */
function parseHotkey(text) {
  if (typeof text !== "string") return null;
  const parts = text.split("+").map((p) => p.trim());
  if (parts.length < 2 || parts.some((p) => !p)) return null;
  const mods = new Set();
  let key = null;
  for (const part of parts) {
    const mod = MODIFIERS[part.toLowerCase()];
    if (mod) {
      if (mods.has(mod)) return null;
      mods.add(mod);
    } else {
      if (key) return null; // one key only
      key = keyOf(part);
      if (!key) return null;
    }
  }
  if (!key || !mods.size) return null;
  return { mods, key, text: [...MODIFIER_ORDER.filter((m) => mods.has(m)), key.name].join("+") };
}

/** Why a well-formed hotkey would take a shortcut away from the user's other apps, or null when it would not. */
function takenFromOthers({ mods, key, text }) {
  // One modifier with a letter is some app's shortcut: Ctrl+C/V/X/Z/A/S copy, paste, undo, save;
  // Ctrl+B bold in the meeting's chat, Ctrl+W closes a tab, Alt+letter opens a menu, Win+L locks the PC.
  // Shift+B is every capital B typed in the chat.
  if (mods.size === 1 && /^[A-Z]$/.test(key.name)) return "a letter needs two of Ctrl, Alt, Shift and Win";
  // Shift with another typing key is a symbol or a space.
  if (mods.size === 1 && mods.has("Shift") && key.types) return "with Shift alone it types a character";
  return TAKEN.has(text) ? "Windows uses it" : null;
}

/**
 * A hotkey in canonical form ("ctrl + alt + b" → "Ctrl+Alt+B", modifiers in
 * the order Ctrl, Alt, Shift, Super), or null when it is not modifiers and
 * one key, or when it would take a shortcut from the user's other apps: the
 * hotkey is global, so the meeting app and the chat would never see it. It
 * needs Ctrl, Alt or the Windows key, or Shift with a key that types nothing
 * (F9): a global Shift+B would steal every capital B typed in the meeting's
 * chat. A letter needs two modifiers (Ctrl+V is paste everywhere; Ctrl+Alt+V
 * is free), and system shortcuts like Alt+F4 and Alt+Tab are refused. Whether
 * Windows lets the app have the rest is found out when it is registered.
 * @param {string} text
 * @returns {string|null}
 */
export function normalizeHotkey(text) {
  const hotkey = parseHotkey(text);
  return hotkey && takenFromOthers(hotkey) === null ? hotkey.text : null;
}

/**
 * Check settings read from the file (or edited on the settings page).
 * Unknown names are dropped. Key-like names (key, token, secret, password,
 * credential: all but hotkeyOwn, hotkeyConvert and keyExpiresOn in any
 * capitalisation), at any depth, are dropped and reported. So is a key in
 * a free-text setting (modelName, micLabel, cableLabel, obsPath: anything
 * redact() would hide). Every wrong value is replaced by its default and
 * reported. Error texts name the setting but never repeat its value (it
 * could be a pasted key).
 *
 * `ready` is true once voiceType is "masculine" or "feminine": the Sanas
 * model is picked by it, so until then the app can't convert. A missing
 * voice type is in `errors` too, so the setup page can say what to do.
 * @param {*} input the parsed settings file (null or undefined: none yet)
 * @returns {{settings: object, errors: string[], ready: boolean}} settings:
 *   a complete, new object (defaults filled in) that the caller may change
 */
export function validateSettings(input) {
  const errors = [];
  let src = input;
  if (absent(src)) src = {};
  else if (!isObject(src)) {
    errors.push("The settings could not be read, so the defaults are used.");
    src = {};
  }
  reportSecrets(src, "", errors, 0);

  const text = (name) => {
    const v = src[name];
    if (absent(v)) return DEFAULTS[name];
    if (typeof v === "string") return v;
    errors.push(`${name} must be text; it was cleared.`);
    return DEFAULTS[name];
  };
  // Free text that a pasted key could end up in. Not the device ids: their 64 hex digits are
  // what redact() hides from logs, yet they are only names for this PC's devices.
  const plainText = (name) => {
    const v = text(name);
    if (!v || !looksLikeSecret(v, name === "obsPath")) return v;
    errors.push(`${name} looks like an API key, so it was not kept (${SECRET_MESSAGE}); it was cleared.`);
    return DEFAULTS[name];
  };
  const bool = (v, label, fallback) => {
    if (absent(v)) return fallback;
    if (typeof v === "boolean") return v;
    errors.push(`${label} must be true or false; using ${fallback}.`);
    return fallback;
  };

  const settings = {
    version: 1,
    micDeviceId: text("micDeviceId"),
    micLabel: plainText("micLabel"),
    cableDeviceId: text("cableDeviceId"),
    cableLabel: plainText("cableLabel"),
    modelName: modelName(src.modelName, errors),
    voiceType: voiceType(src.voiceType, errors),
    sampleRate: sampleRate(src.sampleRate, errors),
    mode: mode(src.mode, errors),
    hotkeyOwn: hotkey(src.hotkeyOwn, "hotkeyOwn", errors),
    hotkeyConvert: hotkey(src.hotkeyConvert, "hotkeyConvert", errors),
    startWithWindows: bool(src.startWithWindows, "startWithWindows", DEFAULTS.startWithWindows),
    lipSync: { ...DEFAULTS.lipSync },
    budget: { ...DEFAULTS.budget },
    obsPath: plainText("obsPath"),
  };

  if (settings.hotkeyOwn === settings.hotkeyConvert) {
    errors.push(`hotkeyOwn and hotkeyConvert are the same keys; using ${DEFAULTS.hotkeyOwn} and ${DEFAULTS.hotkeyConvert}.`);
    settings.hotkeyOwn = DEFAULTS.hotkeyOwn;
    settings.hotkeyConvert = DEFAULTS.hotkeyConvert;
  }

  const lip = src.lipSync;
  if (isObject(lip)) {
    settings.lipSync.enabled = bool(lip.enabled, "lipSync.enabled", DEFAULTS.lipSync.enabled);
    if (!absent(lip.totalMs)) {
      if (numberIn(lip.totalMs, 0, MAX_LIP_SYNC_MS)) settings.lipSync.totalMs = lip.totalMs;
      else errors.push(`lipSync.totalMs must be empty or 0 to ${MAX_LIP_SYNC_MS} ms; it was cleared.`);
    }
    if (!absent(lip.obsOffsetMs)) {
      if (numberIn(lip.obsOffsetMs, -MAX_OBS_OFFSET_MS, MAX_OBS_OFFSET_MS)) settings.lipSync.obsOffsetMs = lip.obsOffsetMs;
      else errors.push(`lipSync.obsOffsetMs must be -${MAX_OBS_OFFSET_MS} to ${MAX_OBS_OFFSET_MS} ms; using 0.`);
    }
  } else if (!absent(lip)) errors.push("lipSync must be a group of settings; using the defaults.");

  const budget = src.budget;
  if (isObject(budget)) {
    if (!absent(budget.capUsd)) {
      if (numberIn(budget.capUsd, Number.MIN_VALUE, Infinity)) settings.budget.capUsd = budget.capUsd;
      else errors.push(`budget.capUsd must be more than $0; using $${DEFAULTS.budget.capUsd}.`);
    }
    const expires = typeof budget.keyExpiresOn === "string" ? budget.keyExpiresOn.trim() : budget.keyExpiresOn;
    if (!absent(expires) && expires !== "") {
      if (typeof expires === "string" && isIsoDate(expires)) settings.budget.keyExpiresOn = expires;
      else errors.push("budget.keyExpiresOn must be a date like 2027-11-26; it was cleared.");
    }
  } else if (!absent(budget)) errors.push("budget must be a group of settings; using the defaults.");

  return { settings, errors, ready: settings.voiceType !== null };
}

function modelName(value, errors) {
  if (absent(value) || (typeof value === "string" && !value.trim())) return DEFAULTS.modelName;
  const name = typeof value === "string" ? value.trim() : "";
  // The key and the model name are both copied from the Sanas Console: a key pasted here must not be saved.
  if (name && looksLikeSecret(name)) {
    errors.push(`modelName looks like an API key, so it was not kept (${SECRET_MESSAGE}); using ${DEFAULTS.modelName}.`);
  } else if (MODEL_NAME.test(name)) return name;
  else errors.push(`modelName must be a model name from the Sanas Console, like AT5.2; using ${DEFAULTS.modelName}.`);
  return DEFAULTS.modelName;
}

function sampleRate(value, errors) {
  if (absent(value)) return DEFAULTS.sampleRate;
  if (SAMPLE_RATES.includes(value)) return value;
  errors.push(`sampleRate must be 16000 or 48000; using ${DEFAULTS.sampleRate}.`);
  return DEFAULTS.sampleRate;
}

function mode(value, errors) {
  if (absent(value)) return DEFAULTS.mode;
  const m = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (MODES.includes(m)) return m;
  errors.push(`mode must be "interview" or "practice"; using "${DEFAULTS.mode}".`);
  return DEFAULTS.mode;
}

function voiceType(value, errors) {
  const v = typeof value === "string" ? value.trim().toLowerCase() : value;
  if (VOICE_TYPES.includes(v)) return v;
  if (absent(v) || v === "") errors.push("Choose your voice type, masculine or feminine: the Sanas model needs it.");
  else errors.push('voiceType must be "masculine" or "feminine": choose your voice type, the Sanas model needs it.');
  return null;
}

function hotkey(value, name, errors) {
  if (absent(value) || value === "") return DEFAULTS[name];
  const canonical = normalizeHotkey(value);
  if (canonical) return canonical;
  const parsed = parseHotkey(value);
  if (parsed) {
    // Its canonical text is made of modifier and key names only, so it may be shown.
    errors.push(
      `${name} must be keys no other app needs: a hotkey works everywhere, so ${parsed.text} would be taken from Windows and every app (${takenFromOthers(parsed)}); using ${DEFAULTS[name]}.`,
    );
  } else {
    errors.push(`${name} must be Ctrl, Alt, Shift or Win keys and one more key, like ${DEFAULTS[name]}; using ${DEFAULTS[name]}.`);
  }
  return DEFAULTS[name];
}
