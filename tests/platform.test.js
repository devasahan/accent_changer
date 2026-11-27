// The two shells the page runs in (src/platform/tauri.js for the installed
// app, src/platform/browser.js for Edge dev mode) offer the same functions.
// These tests run them in Node with fakes for window.__TAURI__, localStorage,
// document and console: the settings never throw on the way in, the window
// calls check their arguments, and the log lines are redacted on the page's
// side (the Rust side's clean_line hides less: see src-tauri/src/pagelog.rs).
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import * as app from "../src/platform/tauri.js";
import * as browser from "../src/platform/browser.js";

const PLATFORM_DIR = new URL("../src/platform/", import.meta.url);
const SAVED = '{"version":1,"micLabel":"Headset Microphone (USB Audio Device)"}';
const BOM = "\uFEFF";
const STEP2 = ["loadSettings", "saveSettings", "hideWindowFor", "windowState", "allowMicPermission", "log"];

/** The app's Rust side, faked: settings_load answers `text`. */
function fakeApp(text) {
  globalThis.window = { __TAURI__: { core: { invoke: async () => text } } };
}

/** Edge's storage for the page, faked: the saved settings are `text`. */
function fakeEdge(text) {
  Object.defineProperty(globalThis, "localStorage", { value: { getItem: () => text }, configurable: true, writable: true });
}

/** window.__TAURI__.core.invoke answering from `answers` (a value, or a function of args; throw to reject). */
function fakeTauri(answers = {}) {
  const calls = [];
  globalThis.window = {
    __TAURI__: {
      core: {
        async invoke(cmd, args) {
          calls.push({ cmd, args });
          await new Promise((resolve) => setTimeout(resolve, 1)); // IPC never answers at once
          if (!(cmd in answers)) throw `command ${cmd} not found`;
          const answer = answers[cmd];
          return typeof answer === "function" ? answer(args) : answer;
        },
      },
    },
  };
  return calls;
}

/** localStorage as Edge has it, in memory. */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
  return map;
}

function noGlobals() {
  delete globalThis.window;
  delete globalThis.localStorage;
  delete globalThis.document;
}

/** Calls of console.info / warn / error while `fn` runs. */
async function consoleCalls(fn) {
  const seen = { info: [], warn: [], error: [] };
  const saved = { info: console.info, warn: console.warn, error: console.error };
  for (const k of Object.keys(seen)) console[k] = (...a) => seen[k].push(a.join(" "));
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return seen;
}

/** Unhandled rejections while `fn` runs and a little after (a fire-and-forget call). */
async function unhandledDuring(fn) {
  const seen = [];
  const onRejection = (reason) => seen.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    await fn();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  return seen;
}

test("a settings file saved with a byte order mark still reads, in the app and in Edge", async (t) => {
  t.after(noGlobals);
  for (const [platform, fake] of [
    [app, fakeApp],
    [browser, fakeEdge],
  ]) {
    // Notepad's "UTF-8 with BOM" puts U+FEFF in front, and JSON.parse refuses it.
    for (const text of [SAVED, BOM + SAVED]) {
      fake(text);
      assert.deepEqual(
        await platform.loadSettings(),
        { raw: { version: 1, micLabel: "Headset Microphone (USB Audio Device)" }, error: null },
        `${platform.name}: ${JSON.stringify(text)}`,
      );
    }
    // A text that is not JSON comes back as it is, for validateSettings to report.
    fake(`${BOM}not json`);
    assert.deepEqual(await platform.loadSettings(), { raw: `${BOM}not json`, error: null }, platform.name);
  }
});

test("the platform files and this test hold no invisible characters", () => {
  // A byte order mark, a no-break or zero-width space or a direction mark in
  // the code looks like nothing at all on screen and in a review. Write it as
  // an escape ("\uFEFF") instead.
  const invisible = /(?![ \t\r\n])[\p{Cc}\p{Cf}\p{Zs}\p{Zl}\p{Zp}]/gu;
  const names = readdirSync(PLATFORM_DIR).filter((f) => f.endsWith(".js"));
  assert.ok(names.includes("tauri.js") && names.includes("browser.js"), String(names));
  const files = [...names.map((f) => [f, new URL(f, PLATFORM_DIR)]), ["platform.test.js", new URL(import.meta.url)]];
  const found = [];
  for (const [name, url] of files) {
    const lines = readFileSync(url, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(invisible)) {
        const code = m[0].codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
        found.push(`${name}:${i + 1}:${m.index + 1} U+${code}`);
      }
    });
  }
  assert.deepEqual(found, []);
});

test("both shells offer the same Step 2 functions", () => {
  for (const name of STEP2) {
    assert.equal(typeof app[name], "function", `tauri.js ${name}`);
    assert.equal(typeof browser[name], "function", `browser.js ${name}`);
  }
  assert.equal(app.name, "app");
  assert.equal(browser.name, "browser");
});

test("app: loadSettings parses the file's text, or keeps it when it is not JSON", async (t) => {
  t.after(noGlobals);
  const saved = { version: 1, micLabel: "Headset Microphone (USB Audio Device)" };
  let text = JSON.stringify(saved);
  const calls = fakeTauri({ settings_load: () => text });
  assert.deepEqual(await app.loadSettings(), { raw: saved, error: null });
  assert.deepEqual(calls, [{ cmd: "settings_load", args: undefined }]);

  text = null; // no file yet
  assert.deepEqual(await app.loadSettings(), { raw: null, error: null });
  text = "{ not json";
  assert.deepEqual(await app.loadSettings(), { raw: "{ not json", error: null });
  text = BOM + JSON.stringify(saved); // saved by Notepad with a byte order mark
  assert.deepEqual(await app.loadSettings(), { raw: saved, error: null });
  text = "[1,2]"; // JSON, but not settings: validateSettings reports it
  assert.deepEqual(await app.loadSettings(), { raw: [1, 2], error: null });
});

test("app: loadSettings never throws", async (t) => {
  t.after(noGlobals);
  const unreadable = "Could not read the settings file (permission denied).";
  fakeTauri({
    settings_load: () => {
      throw unreadable; // Tauri rejects with the command's error text
    },
  });
  assert.deepEqual(await app.loadSettings(), { raw: null, error: unreadable });

  fakeTauri({
    settings_load: () => {
      throw new Error("IPC closed");
    },
  });
  assert.deepEqual(await app.loadSettings(), { raw: null, error: "IPC closed" });

  fakeTauri({}); // an older app without the command
  assert.deepEqual(await app.loadSettings(), { raw: null, error: "command settings_load not found" });

  noGlobals(); // no window.__TAURI__ at all
  const r = await app.loadSettings();
  assert.equal(r.raw, null);
  assert.equal(typeof r.error, "string");
  assert.ok(r.error.length > 0);
});

test("app: saveSettings sends the JSON text and reports a failure", async (t) => {
  t.after(noGlobals);
  const settings = { version: 1, micDeviceId: "", micLabel: "Fake Audio Input 2" };
  const calls = fakeTauri({ settings_save: null });
  assert.equal(await app.saveSettings(settings), undefined);
  assert.deepEqual(calls, [{ cmd: "settings_save", args: { json: JSON.stringify(settings) } }]);
  assert.deepEqual(JSON.parse(calls[0].args.json), settings);

  fakeTauri({
    settings_save: () => {
      throw "Could not save the settings file (permission denied).";
    },
  });
  await assert.rejects(app.saveSettings(settings), { message: "Could not save the settings file (permission denied)." });
});

test("app: hideWindowFor asks Rust for whole minutes and passes its answer on", async (t) => {
  t.after(noGlobals);
  const info = { hiddenAtMs: 1_700_000_000_000, showAtMs: 1_700_001_800_000, minutes: 30 };
  const calls = fakeTauri({
    window_hide_for: ({ minutes }) => {
      if (minutes < 1 || minutes > 120) throw "Hide for 1 to 120 minutes.";
      return info;
    },
  });
  assert.deepEqual(await app.hideWindowFor(30), info);
  assert.deepEqual(calls, [{ cmd: "window_hide_for", args: { minutes: 30 } }]);
  assert.deepEqual(await app.hideWindowFor(1), info);
  assert.deepEqual(await app.hideWindowFor(120), info);
  for (const odd of [0, 121, -5, 0.5, "30", null, undefined, NaN, Infinity]) {
    await assert.rejects(app.hideWindowFor(odd), { message: "Hide for 1 to 120 minutes." }, String(odd));
  }
  assert.equal(calls.length, 3, "nothing out of range, no fraction and no text reaches Rust (it would fail with a type error)");

  // Rust's own refusal comes through as it is.
  fakeTauri({
    window_hide_for: () => {
      throw "The app's window is not open.";
    },
  });
  await assert.rejects(app.hideWindowFor(30), { message: "The app's window is not open." });
});

test("app: windowState asks Rust", async (t) => {
  t.after(noGlobals);
  const state = { visible: false, minimized: false, focused: false };
  const calls = fakeTauri({ window_state: state });
  assert.deepEqual(await app.windowState(), state);
  assert.deepEqual(calls, [{ cmd: "window_state", args: undefined }]);
});

test("app: allowMicPermission never throws", async (t) => {
  t.after(noGlobals);
  const note = "microphone allowed for http://tauri.localhost in the WebView2 profile";
  const calls = fakeTauri({ mic_permission_allow: note });
  assert.deepEqual(await app.allowMicPermission(), { ok: true, note });
  assert.deepEqual(calls, [{ cmd: "mic_permission_allow", args: undefined }]);

  fakeTauri({
    mic_permission_allow: () => {
      throw "SetPermissionState failed: No such interface supported (0x80004002)";
    },
  });
  assert.deepEqual(await app.allowMicPermission(), {
    ok: false,
    note: "SetPermissionState failed: No such interface supported (0x80004002)",
  });

  noGlobals();
  const r = await app.allowMicPermission();
  assert.equal(r.ok, false);
  assert.equal(typeof r.note, "string");
});

test("app: log sends redacted text and never throws or waits", async (t) => {
  t.after(noGlobals);
  const calls = fakeTauri({ log_line: null });
  const key = "sk_live_" + "a1B2c3D4e5F6g7H8i9J0";
  const deviceId = "5f0c3a9de1b24c7a8e6f0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e";
  const returned = app.log("warn", `warn STAND_IN key ${key} sink ${deviceId} Authorization: Bearer abc.def.ghi`);
  assert.equal(returned, undefined, "fire and forget: nothing to await");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "log_line");
  assert.equal(calls[0].args.level, "warn");
  const sent = calls[0].args.text;
  assert.match(sent, /^warn STAND_IN key /);
  for (const secret of [key, deviceId, "abc.def.ghi"]) assert.ok(!sent.includes(secret), `${secret} in ${sent}`);

  app.log(undefined, "state running");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls[1].args, { level: "info", text: "state running" });

  // A failing or missing Rust side, and odd values, never surface.
  fakeTauri({
    log_line: () => {
      throw "the log is closed";
    },
  });
  const rejections = await unhandledDuring(async () => {
    app.log("info", "state running");
    app.log("info", Object.create(null)); // cannot even be turned into text
    app.log("info", null);
    noGlobals();
    app.log("error", "state recovering");
  });
  assert.deepEqual(rejections, []);
});

test("app: log hides what the Rust side's clean_line lets through (short tokens, split keys)", async (t) => {
  // clean_line (src-tauri/src/pagelog.rs) hides tokens of 32+ characters,
  // sk_/pk_ tokens and Bearer tokens. A URL's token, a token after "token:"
  // and a base64 key split by + or / are shorter pieces, and only the page's
  // redact() hides them: the log file the user sends (Session B step 11)
  // depends on it.
  t.after(noGlobals);
  const calls = fakeTauri({ log_line: null });
  const lines = [
    ["csp connect-src https://x.example/cb?access_token=abc123def", "abc123def"],
    ["sanas token: 0123456789abcdef0123", "0123456789abcdef0123"],
    ["key AbCdEfGh12345678+IjKlMnOp87654321/QrStUvWx", "AbCdEfGh12345678+IjKlMnOp87654321/QrStUvWx"],
  ];
  for (const [line] of lines) app.log("info", line);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls.length, lines.length);
  lines.forEach(([line, secret], i) => {
    const sent = calls[i].args.text;
    assert.ok(!sent.includes(secret), `${line} -> ${sent}`);
  });
});

test("browser: settings live in localStorage under their own key", async (t) => {
  t.after(noGlobals);
  const probeKeys = { "accentChanger.mic": "probe-mic-id", "accentChanger.out": "probe-out-id" };
  const map = fakeStorage(probeKeys);
  assert.deepEqual(await browser.loadSettings(), { raw: null, error: null });

  const settings = { version: 1, micDeviceId: "", micLabel: "Headset Microphone (USB Audio Device)" };
  assert.equal(await browser.saveSettings(settings), undefined);
  assert.equal(map.get("accentChanger.app.settings"), JSON.stringify(settings));
  assert.deepEqual(await browser.loadSettings(), { raw: settings, error: null });
  for (const [k, v] of Object.entries(probeKeys)) assert.equal(map.get(k), v, "the probe's settings are left alone");

  map.set("accentChanger.app.settings", "{ not json");
  assert.deepEqual(await browser.loadSettings(), { raw: "{ not json", error: null });
});

test("browser: loadSettings never throws; saveSettings reports a full storage", async (t) => {
  t.after(noGlobals);
  noGlobals(); // no localStorage at all
  const missing = await browser.loadSettings();
  assert.equal(missing.raw, null);
  assert.equal(typeof missing.error, "string");

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw Object.assign(new Error("The operation is insecure."), { name: "SecurityError" });
    },
  });
  assert.deepEqual(await browser.loadSettings(), { raw: null, error: "The operation is insecure." });

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: {
      getItem: () => null,
      setItem() {
        throw Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError" });
      },
    },
  });
  await assert.rejects(browser.saveSettings({ version: 1 }), { message: "The quota has been exceeded." });
});

test("browser: hiding works only in the app", async () => {
  await assert.rejects(browser.hideWindowFor(30), {
    message: "Hiding the window works only in the installed app. In Edge, minimize the window instead.",
  });
});

test("browser: windowState reads the page's visibility and focus", async (t) => {
  t.after(noGlobals);
  globalThis.document = { visibilityState: "hidden", hasFocus: () => false };
  assert.deepEqual(await browser.windowState(), { visible: false, minimized: null, focused: false });
  globalThis.document = { visibilityState: "visible", hasFocus: () => true };
  assert.deepEqual(await browser.windowState(), { visible: true, minimized: null, focused: true });
});

test("browser: allowMicPermission says it is not available", async () => {
  assert.deepEqual(await browser.allowMicPermission(), { ok: false, note: "not available in Edge dev mode" });
});

test("browser: log goes to console.info or console.warn, redacted, never console.error", async () => {
  const key = "sk_live_" + "a1B2c3D4e5F6g7H8i9J0";
  const seen = await consoleCalls(() => {
    assert.equal(browser.log("info", "state running"), undefined);
    browser.log("warn", `warn NO_CABLE ${key}`);
    browser.log("error", "state sink-refused");
    browser.log("info", Object.create(null)); // never throws
  });
  assert.deepEqual(seen.info, ["state running"]);
  assert.deepEqual(seen.warn, ["warn NO_CABLE [redacted]", "state sink-refused"]);
  assert.deepEqual(seen.error, []);
});

test("the platform modules touch no DOM when imported", async () => {
  noGlobals();
  // Fresh copies (a query makes a new module instance), imported with no window, document or localStorage.
  const a = await import(`../src/platform/tauri.js?fresh=${Date.now()}`);
  const b = await import(`../src/platform/browser.js?fresh=${Date.now()}`);
  assert.equal(a.name, "app");
  assert.equal(b.name, "browser");
});
