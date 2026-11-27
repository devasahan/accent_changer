import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const app = await import("../src/platform/tauri.js");
const edge = await import("../src/platform/browser.js");

const PLATFORM_DIR = new URL("../src/platform/", import.meta.url);
const SAVED = '{"version":1,"micLabel":"Headset Microphone (USB Audio Device)"}';
const BOM = "\uFEFF";

/** The app's Rust side, faked: settings_load answers `text`. */
function fakeApp(text) {
  globalThis.window = { __TAURI__: { core: { invoke: async () => text } } };
}

/** Edge's storage for the page, faked: the saved settings are `text`. */
function fakeEdge(text) {
  Object.defineProperty(globalThis, "localStorage", { value: { getItem: () => text }, configurable: true, writable: true });
}

test("a settings file saved with a byte order mark still reads, in the app and in Edge", async (t) => {
  t.after(() => {
    delete globalThis.window;
    delete globalThis.localStorage;
  });
  for (const [platform, fake] of [
    [app, fakeApp],
    [edge, fakeEdge],
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
