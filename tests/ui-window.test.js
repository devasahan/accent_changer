// The app's window and what its page may call (src-tauri/): the main window
// is made no larger than the screen's free area and in its middle, and hidden
// from screen capture, all as it is made (a later size or position call goes
// through tao and hides the window again after Hide's quiet re-show: see
// src-tauri/src/window.rs); the page's capability grants nothing, because the
// app's own commands need none and the page calls no Tauri API of its own.
// No window can be opened here, so these read the Rust code and the files.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const TAURI = new URL("../src-tauri/", import.meta.url);
const SRC = new URL("../src/", import.meta.url);
const read = (url) => readFileSync(url, "utf8");
/** Rust code without its // comments, so a comment never counts as a call. */
const rustCode = (text) => text.replace(/\/\/.*$/gm, "");

/** The main window's builder calls in lib.rs, from WebviewWindowBuilder::new to .build(). */
function mainWindowBuilder() {
  const lib = rustCode(read(new URL("src/lib.rs", TAURI)));
  const start = lib.indexOf("WebviewWindowBuilder::new(app, window::MAIN_WINDOW");
  assert.ok(start >= 0, "lib.rs builds the main window");
  const end = lib.indexOf(".build()", start);
  assert.ok(end > start);
  return lib.slice(start, end);
}

test("the main window fits the screen's free area, in its middle, from the start", () => {
  const chain = mainWindowBuilder();
  assert.match(chain, /\.inner_size\(820\.0, 680\.0\)/);
  // 820 x 680 does not fit a 1366 x 768 screen at 125 % (or 1920 x 1080 at
  // 150 %) above the taskbar: the bottom of the page, Copy results, was under it.
  assert.match(chain, /\.prevent_overflow_with_margin\(LogicalSize::new\(window::SCREEN_MARGIN, window::SCREEN_MARGIN\)\)/);
  assert.match(chain, /\.center\(\)/);
  const margin = /pub const SCREEN_MARGIN: f64 = ([\d.]+);/.exec(read(new URL("src/window.rs", TAURI)));
  assert.ok(margin && Number(margin[1]) > 0 && Number(margin[1]) <= 64, "a small margin, in logical pixels");
});

test("the main window is hidden from screen sharing, recordings and screenshots", () => {
  assert.match(mainWindowBuilder(), /\.content_protected\(true\)/);
});

test("no window gets its size, place or look from a tao call after it is made", () => {
  // After Hide's quiet re-show tao's "visible" flag is stale, and any of
  // these would hide the window again (window.rs). The user's own minimize,
  // maximize and restore are fine; show_for_user's unminimize comes after a
  // show() that sets the flag again.
  const later =
    /\.(set_size|set_position|set_min_size|set_max_size|set_size_constraints|maximize|set_maximizable|set_fullscreen|set_resizable|set_decorations|set_always_on_top|set_content_protected|set_skip_taskbar)\(/;
  const dir = new URL("src/", TAURI);
  const found = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".rs"))) {
    rustCode(read(new URL(name, dir)))
      .split("\n")
      .forEach((line, i) => {
        if (later.test(line)) found.push(`${name}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(found, []);
  // .center() only where the window is made.
  const centres = rustCode(read(new URL("src/lib.rs", TAURI))).match(/\.center\(\)/g) ?? [];
  assert.equal(centres.length, 1);
});

test("the page's capability grants nothing: the app's own commands need none", () => {
  // Tauri checks a command against the capabilities only for plugin
  // commands, an app with an ACL manifest, or a page from elsewhere; the
  // app's commands (key, token, settings, window, permission, log) from its
  // own page pass without one. core:default would add window, path (the home
  // folder holds the Windows user name), menu, tray and event calls the page
  // never makes.
  const dir = new URL("capabilities/", TAURI);
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.deepEqual(files, ["default.json"]);
  const capability = JSON.parse(read(new URL("default.json", dir)));
  assert.deepEqual(capability.windows, ["main"]);
  assert.deepEqual(capability.permissions, []);
  // No app ACL manifest (tauri_build::AppManifest, set with Attributes::app_manifest): with one, Tauri would check
  // the app's own commands against this empty capability and refuse them. (WindowsAttributes::new_without_app_manifest
  // is about the Windows application manifest, a different thing: the build script links that one itself.)
  const build = rustCode(read(new URL("build.rs", TAURI)));
  assert.match(build, /tauri_build::(?:try_)?build\(/, "build.rs runs tauri-build");
  assert.doesNotMatch(build, /AppManifest/, "no app ACL manifest");
  assert.doesNotMatch(build, /\.app_manifest\s*\(/, "no app ACL manifest");
});

test("the page calls the app's own commands only, through invoke", () => {
  // With an empty capability, a Tauri API call (window, event, path, a
  // plugin command) from the page would be refused: a later step that needs
  // one adds that permission alone.
  const found = [];
  const walk = (dir, prefix = "") => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name !== "vendor") walk(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`);
      } else if (/\.(js|html)$/.test(entry.name)) {
        read(new URL(entry.name, dir))
          .split("\n")
          .forEach((line, i) => {
            for (const m of line.matchAll(/__TAURI(?:_INTERNALS)?__(?:\?)?\.(\w+)/g)) {
              if (m[1] !== "core") found.push(`${prefix}${entry.name}:${i + 1}: ${m[0]}`);
            }
            if (/["'`]plugin:/.test(line) || /data-tauri-drag-region/.test(line)) found.push(`${prefix}${entry.name}:${i + 1}: ${line.trim()}`);
          });
      }
    }
  };
  walk(SRC);
  assert.deepEqual(found, []);
});
