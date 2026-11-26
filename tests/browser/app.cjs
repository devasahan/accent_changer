// Headless check of the app's page (npm run test:app): the same src/ the
// installed app shows, served by the spike server under the CSP from
// src-tauri/tauri.conf.json, in Chromium with a fake microphone. Two runs:
//  1. Edge dev mode (src/platform/browser.js): app info, the microphone
//     check, the key section (held by the dev server) and "Connect only"
//     failing clearly without a key.
//  2. The installed app's page (src/platform/tauri.js): window.__TAURI__ is
//     faked the way the Rust side answers (errors as plain strings, as Tauri
//     rejects), and so is Sanas's portal, so "Connect only" goes all the way
//     through the SDK under the app's CSP. Covers the build stamp, the key's
//     check result in the copied results, Remove key, the app's hints and a
//     relaunch.
// No request leaves this machine. What only the laptop can show (Windows
// Credential Manager, the real http://tauri.localhost origin, Sanas itself)
// is left to Session A2.
// PLAYWRIGHT=<path to playwright> overrides where Playwright is loaded from.
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..", "..");
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
// Read here rather than taken from the server: a config the server can't read would go unnoticed.
const APP_CSP = JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8")).app.security.csp;

let failed = 0;
function check(ok, what, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${!ok && detail ? `\n     ${String(detail).replace(/\n/g, "\n     ")}` : ""}`);
  if (!ok) failed += 1;
}

const count = (text, re) => (text.match(re) ?? []).length;

/** Page errors and CSP messages are always problems; console errors only when no failure is expected. */
function watchPage(page, watch) {
  page.on("pageerror", (err) => watch.problems.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    const text = msg.text();
    if (/Content Security Policy|Refused to/i.test(text)) watch.problems.push(`CSP: ${text}`);
    else if (msg.type() === "error" && !watch.expectErrors) watch.problems.push(`console.error: ${text}`);
  });
}

/** Every request for another host is stopped and reported. Routes added later (the fake portal) go first. */
async function stayOffline(context, base, problems) {
  await context.route(
    (url) => url.origin !== base,
    (route) => {
      problems.push(`request left the machine: ${route.request().method()} ${route.request().url()}`);
      return route.abort();
    },
  );
}

function pageTools(page) {
  const text = (selector) => page.locator(selector).textContent();
  return {
    text,
    flat: async (selector) => (await text(selector)).replace(/\s+/g, ""),
    results: async () => JSON.parse(await text("#results")),
    status: () => text("#status"),
    statusKind: () => page.locator("#status").getAttribute("data-kind"),
    ready: () => page.waitForFunction(() => /Ready/.test(document.querySelector("#status").textContent), null, { timeout: 10000 }),
    /**
     * Click a button and wait for its action's end: the text of `where` matches
     * `until`, and the button is no longer marked busy (main.js sets data-busy
     * while an action runs; the text alone also works without it).
     */
    press: async (id, until, where = "#status") => {
      await page.click(`#${id}`);
      await page.waitForFunction(
        ([button, selector, source, flags]) =>
          new RegExp(source, flags).test(document.querySelector(selector).textContent) && !document.querySelector(button).dataset.busy,
        [`#${id}`, where, until.source, until.flags],
        { timeout: 40000 },
      );
    },
  };
}

// Connect only's end in the status line, whatever the outcome: anything but its "Connecting…" line.
const CONNECTED_OR_NOT = /^(?!Connecting to Sanas)/;

/**
 * Runs in the page: the contrast of every button's label against what is
 * behind it (WCAG formula), each button both on and off. A faded button
 * (opacity below 1) counts as unreadable: its real contrast is lower.
 */
function buttonContrast() {
  const rgba = (css) => css.match(/[\d.]+/g).map(Number);
  const channel = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const behind = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const c = rgba(getComputedStyle(e).backgroundColor);
      if (c.length < 4 || c[3] > 0) return c;
    }
    return [255, 255, 255];
  };
  const measure = (button) => {
    const style = getComputedStyle(button);
    const [hi, lo] = [luminance(rgba(style.color)), luminance(behind(button))].sort((a, b) => b - a);
    const ratio = Number(style.opacity) < 1 ? 0 : (hi + 0.05) / (lo + 0.05);
    return `${button.id}${button.disabled ? " (off)" : ""}: ${ratio.toFixed(2)}`;
  };
  return [...document.querySelectorAll("button")].flatMap((button) => {
    const was = button.disabled;
    const both = [false, true].map((off) => {
      button.disabled = off;
      return measure(button);
    });
    button.disabled = was;
    return both;
  });
}

// ---------- 1 · Edge dev mode ----------

async function devMode(browser, base) {
  console.log("Edge dev mode (src/platform/browser.js):");
  const context = await browser.newContext();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  const watch = { problems: [], expectErrors: false };
  await stayOffline(context, base, watch.problems);
  const page = await context.newPage();
  watchPage(page, watch);
  const { text, flat, results, status, statusKind, ready, press } = pageTools(page);

  try {
    const res = await page.goto(`${base}/src/`);
    check(
      res.headers()["content-security-policy"] === APP_CSP,
      "the dev server serves the app page under the CSP from tauri.conf.json",
      res.headers()["content-security-policy"],
    );
    await ready();
    check(true, "the page loads and says Ready");
    const info = await flat("#appInfo");
    check(/Edgedevmode/.test(info) && /Securepageyes/.test(info), "step 1 shows the shell and a secure page", info);
    check(/Rustsidenotin/.test(info), "and doesn't claim a Rust side in dev mode", info);
    check(info.includes("(builddev)") && (await results()).app.build === "dev", "step 1 and the results say build dev", info);
    // WebView2 follows the Windows theme: button labels must be readable in both, on and off.
    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme });
      const contrast = await page.evaluate(buttonContrast);
      const low = contrast.filter((line) => Number(line.split(": ")[1]) < 4.5);
      check(
        contrast.length >= 8 && low.length === 0,
        `in ${colorScheme} mode every button label has at least 4.5:1 contrast, on and off`,
        (low.length ? low : contrast).join("\n"),
      );
    }
    await page.emulateMedia({ colorScheme: null });

    // 2 · microphone (a double click runs it once)
    await page.dblclick("#btnMic");
    await page.waitForFunction(() => /Microphone checked/.test(document.querySelector("#status").textContent), null, { timeout: 10000 });
    const mic = (await results()).microphone;
    check(mic.ok && mic.microphones.length >= 1 && mic.outputs.length >= 1, "the microphone opens and devices are listed", JSON.stringify(mic));
    check(
      mic.echoCancellation === false && mic.noiseSuppression === false && mic.autoGainControl === false,
      "echo cancellation, noise suppression and auto gain are off",
      JSON.stringify(mic),
    );
    check(mic.cableInputFound === false && /not installed yet/.test(await text("#micInfo")), "VB-CABLE is reported as not installed");

    // 3 · key: in dev mode the server holds it
    check(/No key saved yet/.test(await text("#keyInfo")), "no key yet");
    check(await page.locator("#btnDeleteKey").isDisabled(), "Remove key is off when there is nothing to remove");
    watch.expectErrors = true;
    await page.fill("#key", "sk_test_should_not_stay_1234567890");
    await press("btnSaveKey", /server window/);
    check((await statusKind()) === "error" && /server window/.test(await status()), "saving a key in dev mode says where the key goes", await status());
    check((await page.locator("#key").inputValue()) === "", "the pasted key is cleared from the box at once");

    // 4 · connect only without a key: a clear error that doesn't blame the key
    await press("btnConnect", /\S/, "#connectInfo");
    const err = await text("#connectInfo");
    check(/No Sanas API key loaded/.test(err), "Connect only without a key explains what is missing", err);
    check(!/refused/.test(err), "and does not send you to the Sanas Console", err);
    check((await statusKind()) === "error" && (await results()).sanas.ok === false, "the failure is recorded");
    watch.expectErrors = false;

    // 5 · copy
    await press("btnCopy", /\S/, "#copyInfo");
    const copyInfo = await text("#copyInfo");
    check(/^Copied/.test(copyInfo), "Copy results copies by itself (not the fallback)", copyInfo);
    const copied = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
    const parsed = JSON.parse(copied || "{}");
    check(
      parsed.tool === "accent-changer diagnostics" && parsed.shell === "browser" && parsed.microphone?.ok,
      "Copy results gives the summary",
      copied.slice(0, 200),
    );
    // What the person would copy by hand if the clipboard failed, too.
    const shared = copied || (await text("#results"));
    check(!/sk_test|access_token|deviceId/.test(shared), "the summary holds no key, token or device ids");
  } catch (err) {
    check(false, "scenario finished", err.stack || err.message);
    console.log(`     status: ${await status().catch(() => "?")}`);
  } finally {
    check(watch.problems.length === 0, "no page errors, CSP violations or outside requests", watch.problems.join("\n"));
    await context.close();
  }
}

// ---------- 2 · the installed app's page, Rust side and Sanas portal faked ----------

const BUILD = "v0.1.0-test.2 1a2b3c4";
const TOKEN = "tok_FAKE_access_5d1c9e";
const USER_ID = "user-FAKE-7f3a";
const GROUP_ID = "group-FAKE-9b2e";
const KEYS = {
  good: "sk_live_FAKE_good_0123456789WXYZ",
  offline: "sk_live_FAKE_OFFLINE_0123456789QRST",
  refused: "sk_live_FAKE_REFUSED_0123456789MNOP",
};
// As src-tauri/src/lib.rs (key_set) and sanas.rs (sanas_token) word them. The page's part of the contract
// is only the words "refused the saved key": src/engines/sanas-errors.js adds no hint of its own then.
const REFUSED_KEY =
  "Sanas refused this key (HTTP 401). Paste it again from where you saved it (for example your password manager); if it is still refused, check in the Sanas Console whether it expired or was revoked.";
const REFUSED_SAVED_KEY =
  "Sanas refused the saved key (HTTP 401). Paste it again on the Diagnostics page from where you saved it (for example your password manager) and press Save key; if it is still refused, check in the Sanas Console whether it expired or was revoked.";

// Runs in the page before its scripts: the five commands of src-tauri/src/lib.rs.
// Tauri rejects with the command's Err text, a plain string, so this does too.
// The key lives in sessionStorage in place of Windows Credential Manager, so it
// outlasts a reload (the app's relaunch).
function fakeTauri({ build, tokenResponse, refusedKey, refusedSavedKey }) {
  const STORE = "fake-credential-manager";
  const store = {
    get() {
      try {
        return sessionStorage.getItem(STORE);
      } catch {
        return null; // about:blank has no storage
      }
    },
    set: (key) => sessionStorage.setItem(STORE, key),
    delete: () => sessionStorage.removeItem(STORE),
  };
  const tail = (key) => `…${key.slice(-4)}`;
  window.__fake = { calls: [], keySetGot: [], refuseToken: false };
  window.__TAURI__ = {
    core: {
      async invoke(cmd, args = {}) {
        window.__fake.calls.push(cmd);
        await new Promise((resolve) => setTimeout(resolve, 5)); // IPC never answers at once
        switch (cmd) {
          case "app_info":
            return { name: "Accent Changer", version: "0.1.0", build };
          case "key_status": {
            const key = store.get();
            return { saved: key !== null, tail: key === null ? null : tail(key) };
          }
          case "key_set":
            window.__fake.keySetGot.push(args.key);
            if (args.key.includes("REFUSED")) throw refusedKey; // a refused key is not saved
            store.set(args.key);
            if (args.key.includes("OFFLINE")) {
              return { checked: "unknown", note: "Could not reach identity.sanas.ai: check the internet connection", tail: tail(args.key) };
            }
            return { checked: "accepted", note: null, tail: tail(args.key) };
          case "key_delete":
            store.delete();
            return null;
          case "sanas_token":
            if (store.get() === null) throw "No Sanas key saved yet: paste it on the Diagnostics page.";
            if (window.__fake.refuseToken) throw refusedSavedKey;
            return tokenResponse;
          default:
            throw `command ${cmd} not found`;
        }
      },
    },
  };
}

/**
 * Sanas's portal as the SDK's initialize() uses it (src/vendor/sanas-browser-sdk:
 * fetchPortalIdentity and heartbeat): GETs with an Authorization header, so
 * the real portal must answer the CORS preflight and send
 * Access-Control-Allow-Origin. While routing, Chromium's preflights are
 * answered by Playwright itself; one is answered here too in case it isn't.
 */
function fakePortal(route, base, portal) {
  const req = route.request();
  const { pathname } = new URL(req.url());
  const cors = { "access-control-allow-origin": base, vary: "Origin" };
  if (req.method() === "OPTIONS") {
    return route.fulfill({
      status: 204,
      headers: { ...cors, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "authorization, accept, content-type" },
    });
  }
  portal.requests.push({ method: req.method(), path: pathname, auth: req.headers().authorization ?? null });
  const json = (status, body) => route.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (portal.refuseOrigin) return json(403, { errorCode: "FORBIDDEN", message: "Origin not allowed" });
  if (pathname.endsWith("/entitlements")) {
    return json(200, {
      data: {
        groupName: "Test group",
        settings: { timezone: "UTC", atConfiguration: { remoteInferencingConfig: { sipEndpoint: "ri.example.invalid" } } },
        features: {},
      },
    });
  }
  if (pathname.endsWith("/heartbeat")) {
    return json(200, { data: { groupSettingsLastUpdatedAt: "2026-11-01T00:00:00Z", groupFeaturesLastUpdatedAt: "2026-11-01T00:00:00Z" } });
  }
  if (pathname.startsWith("/api/v2/app/endpoint/")) return json(200, { data: { userId: USER_ID, firstName: "Test", lastName: "User" } });
  return json(404, { errorCode: "NOT_FOUND", message: `the test has no answer for ${pathname}` });
}

async function appMode(browser, base) {
  console.log("\nThe installed app's page (src/platform/tauri.js; Rust side and Sanas portal faked):");
  const context = await browser.newContext();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  const tokenResponse = JSON.stringify({ access_token: TOKEN, user_id: USER_ID, group_id: GROUP_ID, expires_in: 3600 });
  await context.addInitScript(fakeTauri, { build: BUILD, tokenResponse, refusedKey: REFUSED_KEY, refusedSavedKey: REFUSED_SAVED_KEY });
  // CSP violations as the page sees them, besides the console messages.
  await context.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const watch = { problems: [], expectErrors: false };
  await stayOffline(context, base, watch.problems);
  const portal = { refuseOrigin: false, requests: [] };
  await context.route("https://portal-api.sanas.ai/**", (route) => fakePortal(route, base, portal));
  const page = await context.newPage();
  watchPage(page, watch);
  const { text, flat, results, status, statusKind, ready, press } = pageTools(page);
  const removeOff = () => page.locator("#btnDeleteKey").isDisabled();
  const cspSeen = () => page.evaluate(() => window.__csp);

  try {
    const res = await page.goto(`${base}/src/`);
    check(
      res.headers()["content-security-policy"] === APP_CSP,
      "the page is served under the CSP from tauri.conf.json",
      res.headers()["content-security-policy"],
    );
    await ready();

    // 1 · this app
    let r = await results();
    const info = await flat("#appInfo");
    check(r.shell === "app", "the page uses the app's platform (window.__TAURI__ is there)", r.shell);
    check(info.includes(`AccentChanger0.1.0(build${BUILD.replace(/\s+/g, "")})`), "step 1 shows the build next to the version", info);
    check(r.app.version === "0.1.0" && r.app.build === BUILD, "the results say which build ran", JSON.stringify(r.app));
    check(/Runsastheinstalledapp/.test(info) && /Rustsideyes\(\d+ms\)/.test(info), "step 1 says the page talks to its Rust side", info);
    check(/No key saved yet/.test(await text("#keyInfo")) && (await removeOff()), "no key yet, and Remove key is off");
    watch.expectErrors = true;
    await press("btnConnect", CONNECTED_OR_NOT);
    const noKey = await text("#connectInfo");
    check(
      /No Sanas key saved yet/.test(noKey) && !/Sanas Console/.test(noKey),
      "Connect only without a key says so, and doesn't send you to the Sanas Console",
      noKey,
    );
    watch.expectErrors = false;

    // 2 · microphone: puts device names in the results (their ids must stay out)
    await press("btnMic", /^(?!Opening the microphone)/);
    check((await results()).microphone?.ok === true, "the microphone opens", JSON.stringify((await results()).microphone));

    // 3 · key
    watch.expectErrors = true;
    await press("btnSaveKey", /into the box first/);
    check(
      (await statusKind()) === "error" && /password manager/.test(await status()) && !/Sanas Console/.test(await status()),
      "Save key with an empty box says to paste the key from the password manager, not the Console",
      await status(),
    );
    await page.fill("#key", KEYS.refused);
    await press("btnSaveKey", /^(?!Checking the key)/);
    check(
      (await status()) === REFUSED_KEY && (await statusKind()) === "error",
      "a refused key shows the Rust side's text as it is (Tauri rejects with a string)",
      await status(),
    );
    r = await results();
    check(
      r.key.saved === false && r.errors.some((e) => e.message === REFUSED_KEY),
      "the refused key isn't saved, and the refusal is in the results",
      JSON.stringify(r.key),
    );
    watch.expectErrors = false;

    await page.fill("#key", KEYS.offline);
    await press("btnSaveKey", /^(?!Checking the key)/);
    r = await results();
    check(
      (await statusKind()) === "warn" && r.key.saved === true && r.key.checked === "unknown" && /identity\.sanas\.ai/.test(r.key.note ?? ""),
      "a key Sanas couldn't be asked about is saved, and the results say it is unchecked, and why",
      JSON.stringify(r.key),
    );

    await page.fill("#key", `  ${KEYS.good}\n`);
    await press("btnSaveKey", /^(?!Checking the key)/);
    r = await results();
    check(/Sanas accepted the key/.test(await status()), "Save key: Sanas accepted it", await status());
    check((await page.locator("#key").inputValue()) === "", "the pasted key is cleared from the box at once");
    check((await page.evaluate(() => window.__fake.keySetGot.at(-1))) === KEYS.good, "the Rust side gets the key without the spaces around it");
    check(
      /ending in WXYZ/.test(await text("#keyInfo")) && !(await removeOff()),
      "step 3 shows the key's last 4 characters, and Remove key is on",
      await text("#keyInfo"),
    );
    check(
      r.key.saved === true && r.key.heldBy === "credential manager" && r.key.checked === "accepted" && r.key.note === null,
      "the results keep Sanas's check of the key (checked: accepted)",
      JSON.stringify(r.key),
    );

    // 4 · connect only: the SDK all the way through, under the app's CSP
    await press("btnConnect", CONNECTED_OR_NOT);
    r = await results();
    check(
      (await page.locator("#connectInfo").getAttribute("data-kind")) === "ok" && r.sanas?.ok === true,
      "Connect only works with the saved key",
      await text("#connectInfo"),
    );
    const paths = portal.requests.map((q) => q.path);
    check(
      paths.some((p) => p.endsWith("/entitlements")) && paths.some((p) => p.startsWith("/api/v2/app/endpoint/")) && paths.some((p) => p.endsWith("/heartbeat")),
      "the SDK asked the portal for entitlements, endpoint and heartbeat",
      paths.join("\n"),
    );
    check(
      portal.requests.every((q) => q.auth === `Bearer ${TOKEN}`),
      "each with the token from the Rust side",
      JSON.stringify(portal.requests),
    );
    check(
      (await cspSeen()).length === 0 && !watch.problems.some((p) => p.startsWith("CSP")),
      "no CSP violations: the app's CSP lets the page reach Sanas's portal",
      [...(await cspSeen()), ...watch.problems].join("\n"),
    );
    check(r.key.checked === "accepted", "the key's check is still in the results after Connect only", JSON.stringify(r.key));

    // The app's hints
    watch.expectErrors = true;
    portal.refuseOrigin = true;
    await press("btnConnect", CONNECTED_OR_NOT);
    portal.refuseOrigin = false;
    const originText = await text("#connectInfo");
    check(
      (await results()).sanas.code === "origin_not_allowed" && /http:\/\/tauri\.localhost/.test(originText) && /press Connect only again/.test(originText),
      "a refused address: add http://tauri.localhost, then press Connect only again",
      originText,
    );
    await page.evaluate(() => {
      window.__fake.refuseToken = true;
    });
    await press("btnConnect", CONNECTED_OR_NOT);
    await page.evaluate(() => {
      window.__fake.refuseToken = false;
    });
    const refusedText = await text("#connectInfo");
    check(
      (await results()).sanas.code === "authentication_failed" &&
        count(refusedText, /refused the saved key/g) === 1 &&
        count(refusedText, /Sanas Console/g) === 1,
      "a refused saved key gets its advice once, not twice",
      refusedText,
    );
    watch.expectErrors = false;
    await press("btnConnect", CONNECTED_OR_NOT);
    check((await results()).sanas?.ok === true, "Connect only works again", await text("#connectInfo"));

    // 5 · copy
    await press("btnCopy", /\S/, "#copyInfo");
    const copyInfo = await text("#copyInfo");
    check(/^Copied/.test(copyInfo), "Copy results copies by itself (not the fallback)", copyInfo);
    const copied = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
    const parsed = JSON.parse(copied || "{}");
    check(
      parsed.shell === "app" &&
        parsed.app?.build === BUILD &&
        parsed.key?.checked === "accepted" &&
        parsed.sanas?.ok === true &&
        parsed.microphone?.ok === true,
      "the copied results hold the build, the key's check and Connect only's result",
      copied.slice(0, 400),
    );
    const deviceIds = await page.evaluate(async () =>
      (await navigator.mediaDevices.enumerateDevices()).map((d) => d.deviceId).filter((id) => id && !["default", "communications"].includes(id)),
    );
    const shared = copied || (await text("#results")); // what would be copied by hand if the clipboard failed
    const leaks = [...Object.values(KEYS), TOKEN, USER_ID, GROUP_ID, ...deviceIds].filter((secret) => shared.includes(secret));
    check(
      deviceIds.length > 0 && leaks.length === 0 && !/sk_live|access_token|deviceId/.test(shared),
      "the copied results hold no key, token, Sanas ids or device ids",
      leaks.join("\n") || `${deviceIds.length} device ids to look for`,
    );

    // Close and open the app again (a reload): the key stays, the results start over.
    await page.reload();
    await ready();
    r = await results();
    check(
      /ending in WXYZ/.test(await text("#keyInfo")) && !(await removeOff()),
      "after a relaunch the saved key is found, and Remove key is on",
      await text("#keyInfo"),
    );
    check(r.sanas === null && r.app.build === BUILD, "the results start over (so A2 copies them before closing)", JSON.stringify(r).slice(0, 300));
    await press("btnConnect", CONNECTED_OR_NOT);
    check((await results()).sanas?.ok === true, "Connect only works with the key read back after the relaunch", await text("#connectInfo"));

    // Remove key. The relaunch started the results over, so save the key again
    // first: then there is a check (checked, note) for Remove key to drop.
    await page.fill("#key", KEYS.good);
    await press("btnSaveKey", /^(?!Checking the key)/);
    r = await results();
    check(r.key?.saved === true && r.key.checked === "accepted", "the key is saved again before Remove key", JSON.stringify(r.key));
    await press("btnDeleteKey", /removed/);
    r = await results();
    check(/removed/.test(await status()) && /No key saved yet/.test(await text("#keyInfo")), "Remove key removes the key", await status());
    check(await removeOff(), "and Remove key ends off: nothing is left to remove");
    check(r.key.saved === false && !("checked" in r.key), "the results drop the removed key's check", JSON.stringify(r.key));
    check((await cspSeen()).length === 0, "no CSP violations after the relaunch either", (await cspSeen()).join("\n"));
  } catch (err) {
    check(false, "scenario finished", err.stack || err.message);
    console.log(`     status: ${await status().catch(() => "?")}`);
  } finally {
    check(watch.problems.length === 0, "no page errors, CSP violations or outside requests", watch.problems.join("\n"));
    await context.close();
  }
}

async function main() {
  const { startSpikeServer } = await load("spike/serve.mjs");
  const server = await startSpikeServer({ port: 0, getApiKey: () => "" });
  const base = `http://localhost:${server.port}`;
  const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  try {
    await devMode(browser, base);
    await appMode(browser, base);
  } finally {
    await browser.close();
    await server.close();
  }
  console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
