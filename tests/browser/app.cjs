// Headless check of the app's page (npm run test:app): the same src/ the
// installed app shows, served by the spike server under the CSP from
// src-tauri/tauri.conf.json, in Chromium with a fake microphone that plays
// synthetic speech. Three runs:
//  1. Edge dev mode (src/platform/browser.js), no VB-CABLE: app info, the
//     voice waiting for VB-CABLE, the microphone check, Hide refused, the
//     key section (held by the dev server) and "Connect only" failing
//     clearly without a key.
//  2. A browser without the autoplay flag: Edge dev mode asks for one click
//     (Start), the app never does.
//  3. The installed app's page (src/platform/tauri.js): window.__TAURI__ is
//     faked the way the Rust side answers, Sanas's portal is faked, and
//     VB-CABLE is faked by a loop from "CABLE Input" to "CABLE Output"
//     (fakes.cjs). Covers the passthrough, settings, the delay, the monitor
//     staying off the cable, recoveries, a lost headset, the sink fallbacks,
//     the long check with Hide, overlapping operations, the cable gone during
//     a recovery, Copy results and the log, and Step 1's key flows.
// No request leaves this machine. What only the laptop can show (Windows'
// audio, WebView2, a hidden window, Sanas itself) is left to Session B.
// Expected warning texts come from src/core/device-choice.js (WARNINGS),
// never typed in here.
// PLAYWRIGHT=<path to playwright> overrides where Playwright is loaded from;
// ONLY=dev,gesture,app runs some of the three runs only.
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { fakeFlags, fakeTauri, fakeAudio } = require("./fakes.cjs");

const ROOT = path.join(__dirname, "..", "..");
const OUT = path.join(__dirname, "out", "app");
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
// Read here rather than taken from the server: a config the server can't read would go unnoticed.
const APP_CSP = JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8")).app.security.csp;

let failed = 0;
function check(ok, what, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${!ok && detail ? `\n     ${String(detail).replace(/\n/g, "\n     ")}` : ""}`);
  if (!ok) failed += 1;
}
const note = (what) => console.log(`     ${what}`);

const count = (text, re) => (text.match(re) ?? []).length;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const json = (v) => JSON.stringify(v);

/**
 * Page errors and CSP messages are always problems (but for the one
 * violation the test makes on purpose, under expectCsp); console errors
 * only when no failure is expected.
 */
function watchPage(page, watch) {
  page.on("pageerror", (err) => watch.problems.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    const text = msg.text();
    if (/Content Security Policy|Refused to/i.test(text)) {
      if (!watch.expectCsp) watch.problems.push(`CSP: ${text}`);
    } else if (msg.type() === "error" && !watch.expectErrors) watch.problems.push(`console.error: ${text}`);
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
  const results = async () => JSON.parse(await text("#results"));
  const tools = {
    text,
    flat: async (selector) => (await text(selector)).replace(/\s+/g, ""),
    results,
    status: () => text("#status"),
    statusKind: () => page.locator("#status").getAttribute("data-kind"),
    ready: () => page.waitForFunction(() => /Ready/.test(document.querySelector("#status").textContent), null, { timeout: 10000 }),
    /** Run fn in the page (window.__fake lives there). */
    fake: (fn, arg) => page.evaluate(fn, arg),
    /** The highest level that reached the fake CABLE Output in the next `ms`. */
    peak: (ms) => page.evaluate((m) => window.__fake.cablePeak(m), ms),
    /**
     * Click a button and wait for its action's end: the text of `where` matches
     * `until`, and the button is no longer marked busy (main.js sets data-busy
     * while an action runs; the text alone also works without it).
     */
    press: async (id, until, where = "#status", timeout = 40000) => {
      await page.click(`#${id}`);
      await page.waitForFunction(
        ([button, selector, source, flags]) =>
          new RegExp(source, flags).test(document.querySelector(selector).textContent) && !document.querySelector(button).dataset.busy,
        [`#${id}`, where, until.source, until.flags],
        { timeout },
      );
    },
    /** As press, waiting for an exact text (a WARNINGS constant) inside `where`. */
    pressFor: async (id, wanted, where = "#status", timeout = 15000) => {
      await page.click(`#${id}`);
      await page.waitForFunction(
        ([button, selector, t]) => document.querySelector(selector).textContent.includes(t) && !document.querySelector(button).dataset.busy,
        [`#${id}`, where, wanted],
        { timeout },
      );
    },
    /** Wait until the text of `selector` includes `wanted` (or not, with present false). → whether it did */
    waitText: async (selector, wanted, { timeout = 5000, present = true } = {}) =>
      page
        .waitForFunction(
          ([s, t, p]) => document.querySelector(s).textContent.includes(t) === p,
          [selector, wanted, present],
          { timeout },
        )
        .then(
          () => true,
          () => false,
        ),
    /** Poll the results until pred(results) holds. → the last results read (pred may still be false). */
    waitResults: async (pred, timeout = 5000) => {
      const end = Date.now() + timeout;
      let r = await results();
      while (!pred(r) && Date.now() < end) {
        await sleep(100);
        r = await results();
      }
      return r;
    },
    /** Poll pageFn in the page until it returns a truthy value. → that value, or the last one */
    waitPage: async (pageFn, arg, timeout = 5000) => {
      const end = Date.now() + timeout;
      let v = await page.evaluate(pageFn, arg);
      while (!v && Date.now() < end) {
        await sleep(100);
        v = await page.evaluate(pageFn, arg);
      }
      return v;
    },
  };
  return tools;
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

// ---------- 1 · Edge dev mode, no VB-CABLE ----------

async function devMode(browser, base, CHECK_TEXTS, VOICE_TEXTS) {
  console.log("Edge dev mode (src/platform/browser.js), no VB-CABLE:");
  const context = await browser.newContext();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  const watch = { problems: [], expectErrors: false, expectCsp: false };
  await stayOffline(context, base, watch.problems);
  const page = await context.newPage();
  watchPage(page, watch);
  const lines = []; // the developer console: Edge dev mode's log
  page.on("console", (msg) => lines.push(msg.text()));
  const { text, flat, results, status, statusKind, ready, press, pressFor, waitResults } = pageTools(page);

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
    const r0 = await waitResults((r) => r.voice?.state === "no-cable");
    check(
      r0.voice?.state === "no-cable" && /not installed yet/.test(await text("#voiceStatus")),
      "without VB-CABLE the voice waits for it, and step 2 says it is not installed yet",
      `${r0.voice?.state}: ${await text("#voiceStatus")}`,
    );
    check(
      (await page.locator("#outSelect option").first().textContent()) === "Automatic: not found",
      "the output list says CABLE Input was not found",
    );
    check(r0.settings?.source === "none", "no settings saved yet", json(r0.settings));
    check(lines.includes("settings none") && lines.includes("state no-cable"), "the log (the developer console here) says so in codes", lines.join("\n"));
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
    check(mic.ok && mic.microphones.length >= 1 && mic.outputs.length >= 1, "the microphone opens and devices are listed", json(mic));
    check(
      mic.echoCancellation === false && mic.noiseSuppression === false && mic.autoGainControl === false,
      "echo cancellation, noise suppression and auto gain are off",
      json(mic),
    );
    check(mic.cableInputFound === false && /not installed yet/.test(await text("#micInfo")), "VB-CABLE is reported as not installed");
    check(
      [mic.used, ...mic.microphones, ...mic.outputs].every((l) => !/Fake/.test(l)),
      "the results mask the device names",
      json(mic),
    );

    // Another microphone while VB-CABLE is missing: it is switched (the voice runs nowhere yet, and the status says so).
    const other = await page.$eval("#micSelect", (s) => [...s.options].map((o) => o.value).find((v) => v !== s.value) ?? "");
    const otherName = await page.$eval("#micSelect", (s, v) => [...s.options].find((o) => o.value === v)?.textContent ?? "", other);
    await page.selectOption("#micSelect", other);
    await page.waitForFunction(() => !/^Switching the microphone/.test(document.querySelector("#status").textContent), null, { timeout: 15000 });
    check(
      (await status()) === `Microphone switched.${VOICE_TEXTS.notReaching}` && (await statusKind()) === "warn",
      "a microphone picked while VB-CABLE is missing is switched, and the status says the voice is not reaching the meeting yet",
      `${await statusKind()}: ${await status()}`,
    );
    check(Boolean(otherName) && (await text("#voiceInfo")).includes(otherName), "step 2 shows the new microphone", await text("#voiceInfo"));

    // 3 · Hide works only in the installed app; a check needs the voice in the cable
    watch.expectErrors = true;
    await press("btnHide", /works only in the installed app/);
    check((await statusKind()) === "error", "Hide in Edge dev mode says it works only in the installed app", await status());
    await pressFor("btnMeasure", CHECK_TEXTS.notRunning);
    check(
      (await statusKind()) === "error" && (await text("#measureInfo")) === CHECK_TEXTS.notRunning,
      "Measure the delay waits for the voice to reach the cable, and says so",
      await text("#measureInfo"),
    );
    watch.expectErrors = false;

    // 4 · key: in dev mode the server holds it
    check(/No key saved yet/.test(await text("#keyInfo")), "no key yet");
    check(await page.locator("#btnDeleteKey").isDisabled(), "Remove key is off when there is nothing to remove");
    watch.expectErrors = true;
    await page.fill("#key", "sk_test_should_not_stay_1234567890");
    await press("btnSaveKey", /server window/);
    check((await statusKind()) === "error" && /server window/.test(await status()), "saving a key in dev mode says where the key goes", await status());
    check((await page.locator("#key").inputValue()) === "", "the pasted key is cleared from the box at once");

    // 5 · connect only without a key: a clear error that doesn't blame the key
    await press("btnConnect", /\S/, "#connectInfo");
    const err = await text("#connectInfo");
    check(/No Sanas API key loaded/.test(err), "Connect only without a key explains what is missing", err);
    check(!/refused/.test(err), "and does not send you to the Sanas Console", err);
    check((await statusKind()) === "error" && (await results()).sanas.ok === false, "the failure is recorded");
    watch.expectErrors = false;

    // 6 · copy
    await press("btnCopy", /\S/, "#copyInfo");
    const copyInfo = await text("#copyInfo");
    check(/^Copied/.test(copyInfo), "Copy results copies by itself (not the fallback)", copyInfo);
    const copied = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
    const parsed = JSON.parse(copied || "{}");
    check(
      parsed.tool === "accent-changer diagnostics" && parsed.schema === 2 && parsed.shell === "browser" && parsed.microphone?.ok,
      "Copy results gives the summary (schema 2)",
      copied.slice(0, 200),
    );
    // What the person would copy by hand if the clipboard failed, too.
    const shared = copied || (await text("#results"));
    check(!/sk_test|access_token|deviceId/.test(shared), "the summary holds no key, token or device ids");

    // 7 · a CSP violation (made on purpose): blocked, kept in the results, its directive in the log
    watch.expectCsp = true;
    await page.evaluate(() => {
      const script = document.createElement("script");
      script.textContent = "window.__inlineRan = true";
      document.body.append(script);
    });
    const withCsp = await waitResults((x) => x.csp.length > 0, 3000);
    watch.expectCsp = false;
    check(
      withCsp.csp.length === 1 && /^script-src/.test(withCsp.csp[0]) && !(await page.evaluate(() => window.__inlineRan)),
      "a CSP violation is blocked and kept in the results",
      json(withCsp.csp),
    );
    check(lines.some((l) => /^csp script-src/.test(l)), "and its directive is logged", lines.slice(-5).join("\n"));

    // 8 · the first start waiting for VB-CABLE "still tries" (its progress is step 2's status): no recovery is listed
    const end = Date.now() + 15000;
    while (!lines.some((l) => /^recovery still-trying /.test(l)) && Date.now() < end) await sleep(200);
    check(lines.some((l) => /^recovery still-trying /.test(l)), "the first start keeps trying while VB-CABLE is missing", lines.filter((l) => /^recovery /.test(l)).join("\n"));
    check(
      (await text("#recoveryLog")) === VOICE_TEXTS.noRecoveries && (await results()).voice?.recoveries?.length === 0,
      "the Recoveries list stays empty during the first start (it lists outages of a running voice)",
      await text("#recoveryLog"),
    );
  } catch (err) {
    check(false, "scenario finished", err.stack || err.message);
    console.log(`     status: ${await status().catch(() => "?")}`);
  } finally {
    check(watch.problems.length === 0, "no page errors, CSP violations or outside requests", watch.problems.join("\n"));
    await context.close();
  }
}

// ---------- 2 · no autoplay: Edge asks for a click, the app never does ----------

// Chromium lets a page that captures the microphone start audio without a click (headless Chromium 158: a
// context made while getUserMedia captures starts running; one made after the capture stopped stays
// suspended). The graph opens the microphone before its context, so here the fake's microphones are a
// synthetic tone (no capture): only then does a page without the autoplay flag need a click.
const NO_CAPTURE = () => {
  window.__fake = Object.assign(window.__fake || {}, { synthMic: true });
};

async function gesture(browser, base, build) {
  console.log("\nA browser without the autoplay flag (microphones without a capture):");
  // (a) Edge dev mode: Start, then the voice runs.
  {
    const context = await browser.newContext();
    const watch = { problems: [], expectErrors: false };
    await stayOffline(context, base, watch.problems);
    await context.addInitScript(fakeFlags);
    await context.addInitScript(NO_CAPTURE);
    await context.addInitScript(fakeAudio);
    const page = await context.newPage();
    watchPage(page, watch);
    const lines = [];
    page.on("console", (msg) => lines.push(msg.text()));
    const { status, peak, waitResults } = pageTools(page);
    try {
      await page.goto(`${base}/src/`);
      // Every Playwright evaluation counts as a click for the page, so nothing reads the page until Edge dev
      // mode's log line (the developer console) says the voice waits for a click.
      const end = Date.now() + 10000;
      while (!lines.includes("state needs-gesture") && Date.now() < end) await sleep(100);
      check(lines.includes("state needs-gesture"), "Edge dev mode: without a click the voice waits for one", lines.filter((l) => /^state /.test(l)).join(", "));
      const r = await waitResults((x) => x.voice?.state === "needs-gesture");
      check(
        (await page.locator("#btnStartVoice").isVisible()) && r.voice?.state === "needs-gesture",
        "Edge dev mode: Start is shown and the voice waits for one click",
        `${r.voice?.state}: ${await page.locator("#voiceStatus").textContent()}`,
      );
      await page.click("#btnStartVoice");
      const after = await waitResults((x) => x.voice?.state === "running", 3000);
      check(after.voice?.state === "running", "after the click the voice runs within 3 s", after.voice?.state);
      const p = await peak(1000);
      check(p > 0.01, "and reaches CABLE Output", `peak ${p}`);
      check(await page.locator("#btnStartVoice").isHidden(), "Start is hidden again");
      check(
        !/Starting your voice/.test(await status()) && (await page.locator("#voiceStatus").getAttribute("data-kind")) === "ok",
        "once the voice runs, no status line still says it is starting (step 2 is green)",
        `${await status()} | ${await page.locator("#voiceStatus").textContent()}`,
      );
    } catch (err) {
      check(false, "scenario finished", err.stack || err.message);
      console.log(`     status: ${await status().catch(() => "?")}`);
    } finally {
      check(watch.problems.length === 0, "no page errors, CSP violations or outside requests", watch.problems.join("\n"));
      await context.close();
    }
  }
  // (b) The app: it keeps trying by itself and never shows Start.
  {
    const context = await browser.newContext();
    const watch = { problems: [], expectErrors: false };
    await stayOffline(context, base, watch.problems);
    await context.addInitScript(fakeFlags);
    await context.addInitScript(NO_CAPTURE);
    await context.addInitScript(fakeTauri, { build, tokenResponse: "{}", refusedKey: "refused", refusedSavedKey: "refused" });
    await context.addInitScript(fakeAudio);
    const page = await context.newPage();
    watchPage(page, watch);
    const { status, waitPage } = pageTools(page);
    try {
      await page.goto(`${base}/src/`);
      // Nothing reads the page for 3 s (an evaluation would count as a click); then its log says what it did.
      await sleep(3000);
      const seen = await page.evaluate(() => ({
        states: window.__fake.log.map((l) => l.text).filter((t) => /^state /.test(t)),
        startHidden: document.querySelector("#btnStartVoice").hidden,
      }));
      check(
        seen.startHidden && seen.states.length > 0 && !seen.states.includes("state needs-gesture"),
        "the app never asks for a click: Start stays hidden for 3 s",
        json(seen),
      );
      const contexts = await waitPage(() => {
        const n = window.__fake.contexts.filter((c) => c.__everCable).length;
        return n >= 2 ? n : null;
      });
      check(contexts >= 2, "and keeps trying by itself (a new context each time)", `${contexts}`);
    } catch (err) {
      check(false, "scenario finished", err.stack || err.message);
      console.log(`     status: ${await status().catch(() => "?")}`);
    } finally {
      check(watch.problems.length === 0, "no page errors, CSP violations or outside requests", watch.problems.join("\n"));
      await context.close();
    }
  }
}

// ---------- 3 · the installed app's page: Rust side, Sanas portal and VB-CABLE faked ----------

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

// The id in a failure answer of Sanas's portal (portal.failWith): 64 hex digits, like Chromium's device ids.
// The SDK puts the answer into its error message, which reaches the results as it is: only the page's
// redactObject hides the id.
const PORTAL_REQUEST_ID = "3c9a5e1f".repeat(8);

const IN1 = "Fake Audio Input 1";
const IN2 = "Fake Audio Input 2";
const CABLE_IN_LABEL = "CABLE Input (VB-Audio Virtual Cable)";
const TONE_HZ = 1031.25;

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
  const reply = (status, body) => route.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (portal.refuseOrigin) return reply(403, { errorCode: "FORBIDDEN", message: "Origin not allowed" });
  if (portal.failWith) return reply(portal.failWith, { errorCode: "INTERNAL_ERROR", message: "Something went wrong", requestId: PORTAL_REQUEST_ID });
  if (pathname.endsWith("/entitlements")) {
    return reply(200, {
      data: {
        groupName: "Test group",
        settings: { timezone: "UTC", atConfiguration: { remoteInferencingConfig: { sipEndpoint: "ri.example.invalid" } } },
        features: {},
      },
    });
  }
  if (pathname.endsWith("/heartbeat")) {
    return reply(200, { data: { groupSettingsLastUpdatedAt: "2026-11-01T00:00:00Z", groupFeaturesLastUpdatedAt: "2026-11-01T00:00:00Z" } });
  }
  if (pathname.startsWith("/api/v2/app/endpoint/")) return reply(200, { data: { userId: USER_ID, firstName: "Test", lastName: "User" } });
  return reply(404, { errorCode: "NOT_FOUND", message: `the test has no answer for ${pathname}` });
}

/**
 * Copy results (by itself), then look in the copy and in the text under
 * "Show the results" for what must never leave the page: device ids (the
 * page's and Chromium's), group ids, device names, the key, the token,
 * Sanas's ids, and any 64-hex id (Chromium's device ids are 64 hex digits,
 * and so is the id in the portal's failure answer). → { copied, shown }
 */
async function leakCheck(app, what) {
  const { page, press, text } = app;
  await page.evaluate(() => {
    document.querySelector("#copyInfo").textContent = "";
  });
  await press("btnCopy", /\S/, "#copyInfo");
  const copied = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
  const shown = await text("#results");
  const listed = await page.evaluate(async () =>
    (await navigator.mediaDevices.enumerateDevices()).flatMap((d) => [d.deviceId, d.groupId]).filter((id) => id && !["default", "communications"].includes(id)),
  );
  // Chromium's own ids of the fake devices too (the page sees only the fake's).
  const native = await page.evaluate(() => Object.values(window.__fake.realIds));
  const secrets = [
    ...new Set([...listed, ...native, ...Object.values(app.ids), "fake-cable-output", "fake-cable-2", "fake-headset", "fake-laptop", "fake-cable"]),
    "Fake Audio Input",
    "Fake Default",
    "Fake Headset",
    ...Object.values(KEYS),
    TOKEN,
    USER_ID,
    GROUP_ID,
    PORTAL_REQUEST_ID,
  ];
  const found = [copied, shown].flatMap((t) => [...secrets.filter((s) => t.includes(s)), ...(t.match(/[0-9a-f]{64}/gi) ?? [])]);
  check(
    copied.length > 0 && listed.length > 0 && found.length === 0 && !/sk_live|access_token|deviceId/.test(copied + shown),
    `${what}: the copied results hold no key, token, Sanas ids, device ids, group ids, 64-hex ids or device names`,
    [...new Set(found)].join("\n") || `${listed.length} ids to look for; copied ${copied.length} characters`,
  );
  return { copied, shown };
}

/**
 * Connections to the destination of a graph context that never played into
 * the cable. On the audio element route the graph context runs on the
 * headset's earpiece, so anything connected there would play the user's
 * own voice in their headphones: there must be none. → { connects, open }
 * (open: such graph contexts still open, the element route's own among
 * them, so a check that finds no connection has looked at one)
 */
const graphOffCable = (app) =>
  app.fake(() => {
    const f = window.__fake;
    const off = (c) => Boolean(c && c.__graph && !c.__everCable);
    return {
      connects: f.destinationConnects.filter((d) => off(f.contexts[d.ctx])),
      open: f.contexts.filter((c) => off(c) && c.state !== "closed").length,
    };
  });

/** The app's page with everything faked, and the scenarios that run in it (one page, reloaded where they say). */
async function appMode(browser, base, WARNINGS, VOICE_TEXTS) {
  console.log("\nThe installed app's page (src/platform/tauri.js; Rust side, Sanas portal and VB-CABLE faked):");
  const context = await browser.newContext();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  const tokenResponse = JSON.stringify({ access_token: TOKEN, user_id: USER_ID, group_id: GROUP_ID, expires_in: 3600 });
  await context.addInitScript(fakeFlags);
  await context.addInitScript(fakeTauri, { build: BUILD, tokenResponse, refusedKey: REFUSED_KEY, refusedSavedKey: REFUSED_SAVED_KEY });
  await context.addInitScript(fakeAudio);
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
  const tools = pageTools(page);
  const logs = []; // every log line of every load (the fake's log starts over at each load)
  const harvest = async () => {
    logs.push(...(await page.evaluate(() => (window.__fake?.log ?? []).map((l) => `${l.level} ${l.text}`)).catch(() => [])));
  };
  const app = {
    page,
    watch,
    portal,
    WARNINGS,
    VOICE_TEXTS,
    ids: null,
    ...tools,
    /** Flags for the next loads (fakeFlags reads them before the page's scripts). */
    setFlags: (flags) => page.evaluate((f) => sessionStorage.setItem("fake-flags", JSON.stringify(f)), flags),
    reload: async () => {
      await harvest();
      await page.reload();
      await tools.ready();
    },
    /** Choose a microphone or an output by its id and wait for the page's answer. */
    choose: async (select, value, until) => {
      await page.selectOption(select, value);
      await page.waitForFunction((re) => new RegExp(re).test(document.querySelector("#status").textContent), until.source, { timeout: 15000 });
    },
    settingsFile: () => page.evaluate(() => JSON.parse(sessionStorage.getItem("fake-settings") || "null")),
    lastRecovery: (r) => r.voice?.recoveries?.[r.voice.recoveries.length - 1] ?? null,
  };

  try {
    const res = await page.goto(`${base}/src/`);
    check(
      res.headers()["content-security-policy"] === APP_CSP,
      "the page is served under the CSP from tauri.conf.json",
      res.headers()["content-security-policy"],
    );
    await tools.ready();
    app.ids = await page.evaluate(() => ({ ...window.__fake.ids }));
    const real = await page.evaluate(() => Object.keys(window.__fake.realIds).length);
    check(real === 4, "the fake VB-CABLE and headset are in place", json(app.ids));

    const scenarios = [
      ["3 · passthrough", passthrough],
      ["16 · key, Connect only (Step 1)", keyFlows],
      ["5 · Measure the delay", measureDelay],
      ["6 · monitor sounds stay off the cable", monitorSounds],
      ["7 · recovery", recovery],
      ["8 · headset lost", headsetLost],
      ["13 · overlapping operations", overlapping],
      ["10 · long check with the test tone, and Hide", longTone],
      ["11 · long check with the microphone", longMic],
      ["12 · Hide", hide],
      ["Advanced · the audio element route on request", routeChoice],
      ["14 · VB-CABLE gone during a recovery", cableGone],
      ["15 · Copy results", copyResults],
      ["4 · settings", settings],
      ["9 · sink fallbacks", sinkFallbacks],
      ["the page closes", pageClose],
      ["16 · relaunch and Remove key (Step 1)", relaunch],
    ];
    for (const [name, run] of scenarios) {
      console.log(`  ${name}`);
      try {
        await run(app);
      } catch (err) {
        check(false, `${name}: scenario finished`, err.stack || err.message);
        console.log(`     status: ${await tools.status().catch(() => "?")}`);
        // Leave the page in a known state for the next scenario.
        await app.setFlags({}).catch(() => {});
        watch.expectErrors = false;
        await app.reload().catch(() => {});
      }
    }

    // 15 (end) · the log file, over every load: codes and numbers only.
    await harvest();
    const ids = [...Object.values(app.ids), ...(await page.evaluate(() => Object.values(window.__fake.realIds)))];
    const texts = Object.values(WARNINGS).filter((t) => typeof t === "string" && t);
    const leaks = logs.filter(
      (line) =>
        /Fake Audio|Fake Headset|Fake Default|is not connected, so the app uses|fake-cable|fake-headset|fake-laptop/.test(line) ||
        ids.some((id) => line.includes(id)) ||
        texts.some((t) => line.includes(t)),
    );
    check(logs.length > 20 && leaks.length === 0, "the log holds codes and numbers only: no device names, ids or warning texts", leaks.join("\n") || `${logs.length} lines`);
    for (const wanted of [/^info state running$/, /^warn recovery lost /, /^info recovery back /, /^info first start /, /^info check delay done /, /^info check long done /, /^info route /]) {
      check(logs.some((line) => wanted.test(line)), `the log has a line like ${wanted.source}`, logs.slice(-30).join("\n"));
    }
    check((await page.evaluate(() => window.__csp)).length === 0, "no CSP violations", (await page.evaluate(() => window.__csp)).join("\n"));
  } catch (err) {
    check(false, "app scenarios finished", err.stack || err.message);
    console.log(`     status: ${await tools.status().catch(() => "?")}`);
  } finally {
    check(watch.problems.length === 0, "no page errors, CSP violations or outside requests", watch.problems.join("\n"));
    await context.close();
  }
}

// ---- 3 · passthrough ----

async function passthrough(app) {
  const { page, ids, results, waitResults, peak, fake, press, text } = app;
  let r = await waitResults((x) => x.voice?.state === "running");
  check(
    r.voice?.state === "running" && r.voice.output?.method === "context" && r.voice.output?.how === "auto",
    "the voice runs from launch, into CABLE Input through the app's audio engine",
    json(r.voice?.output ?? r.voice?.state),
  );
  check(r.shell === "app" && r.schema === 2, "the results say the app (schema 2)", `${r.shell} ${r.schema}`);
  check(r.settings?.source === "none", "no settings saved yet", json(r.settings));
  const loud = await peak(1500);
  check(loud > 0.01, "the microphone reaches CABLE Output", `peak ${loud}`);
  await fake(() => window.__fake.setMicGain(0));
  let quiet = 1;
  for (let i = 0; i < 2 && quiet >= 1e-4; i++) quiet = await peak(1000);
  check(quiet < 1e-4, "with the microphone silent, CABLE Output is silent within 2 s (it is the app's path)", `peak ${quiet}`);
  await fake(() => window.__fake.setMicGain(1));

  const mics = await page.$$eval("#micSelect option", (os) => os.map((o) => o.textContent));
  check(same(mics, [IN1, IN2]) && !mics.some((m) => /CABLE/.test(m)), "the microphone list has the two real microphones, not CABLE Output", json(mics));
  const auto = await page.locator("#outSelect option").first().textContent();
  check(auto === "Automatic: CABLE Input", "the output list starts with Automatic: CABLE Input", auto);
  check(r.voice.mic?.settings?.allOff === true, "processing is off on the microphone", json(r.voice.mic?.settings));
  check(r.voice.start?.attempts === 1, "the first start took one attempt", json(r.voice.start));
  check(r.voice.debug?.contexts === 1 && r.voice.debug?.micSources === 1, "one audio context and one microphone source", json(r.voice.debug));
  check(/Your voice goes into “CABLE Input”/.test(await text("#voiceStatus")), "step 2 says where the voice goes", await text("#voiceStatus"));
  check((await page.locator("#voiceStatus").getAttribute("data-kind")) === "ok", "and is green while the voice runs");
  check(/the app's audio engine/.test(await text("#voiceInfo")), "and how it is sent", await text("#voiceInfo"));
  // Gate 1's tick row: the headset's microphone and its earpiece, which is also Windows' default playback device.
  check(
    r.voice.devices?.micHasSiblingOutput === true && r.voice.devices?.defaultOutputIsMicSibling === true,
    "the results say the microphone has its own earpiece, and that it is Windows' default playback device",
    json(r.voice.devices),
  );
  const connects = await fake(() => ({ connects: window.__fake.destinationConnects, cable: window.__fake.contexts.map((c) => c.__everCable) }));
  const toCable = connects.connects.filter((c) => connects.cable[c.ctx]);
  check(
    toCable.length >= 1 && toCable.every((c) => c.sinkIdAtConnect === ids.cableIn),
    "outBus is connected to the destination only after setSinkId(CABLE Input) (never on the default device)",
    json(connects.connects),
  );

  // Check the microphone: a fresh look, no new microphone request while one is open.
  const before = await fake(() => window.__fake.mics.length);
  await press("btnMic", /Microphone checked/);
  r = await results();
  check((await fake(() => window.__fake.mics.length)) === before, "Check the microphone asks Windows for no new microphone while one is open");
  check(
    r.microphone?.ok === true && r.microphone.cableInputFound === true && r.microphone.used === "[name hidden]",
    "the microphone check finds CABLE Input, and masks the microphone's name",
    json(r.microphone),
  );
  check(/installed \(CABLE Input found\)/.test(await text("#micInfo")), "step 2 says VB-CABLE is installed", await text("#micInfo"));
}

// ---- 16 · Step 1's key flows (the passthrough runs meanwhile) ----

async function keyFlows(app) {
  const { page, watch, portal, text, flat, results, status, statusKind, press } = app;
  const removeOff = () => page.locator("#btnDeleteKey").isDisabled();
  const cspSeen = () => page.evaluate(() => window.__csp);

  let r = await results();
  const info = await flat("#appInfo");
  check(r.shell === "app", "the page uses the app's platform (window.__TAURI__ is there)", r.shell);
  check(info.includes(`AccentChanger0.1.0(build${BUILD.replace(/\s+/g, "")})`), "step 1 shows the build next to the version", info);
  check(r.app.version === "0.1.0" && r.app.build === BUILD, "the results say which build ran", json(r.app));
  check(/Runsastheinstalledapp/.test(info) && /Rustsideyes\(\d+ms\)/.test(info), "step 1 says the page talks to its Rust side", info);
  check(/No key saved yet/.test(await text("#keyInfo")) && (await removeOff()), "no key yet, and Remove key is off");
  watch.expectErrors = true;
  await press("btnConnect", CONNECTED_OR_NOT);
  const noKey = await text("#connectInfo");
  check(/No Sanas key saved yet/.test(noKey) && !/Sanas Console/.test(noKey), "Connect only without a key says so, and doesn't send you to the Sanas Console", noKey);
  watch.expectErrors = false;

  // key
  watch.expectErrors = true;
  await press("btnSaveKey", /into the box first/);
  check(
    (await statusKind()) === "error" && /password manager/.test(await status()) && !/Sanas Console/.test(await status()),
    "Save key with an empty box says to paste the key from the password manager, not the Console",
    await status(),
  );
  await page.fill("#key", KEYS.refused);
  await press("btnSaveKey", /^(?!Checking the key)/);
  check((await status()) === REFUSED_KEY && (await statusKind()) === "error", "a refused key shows the Rust side's text as it is (Tauri rejects with a string)", await status());
  r = await results();
  check(r.key.saved === false && r.errors.some((e) => e.message === REFUSED_KEY), "the refused key isn't saved, and the refusal is in the results", json(r.key));
  watch.expectErrors = false;

  await page.fill("#key", KEYS.offline);
  await press("btnSaveKey", /^(?!Checking the key)/);
  r = await results();
  check(
    (await statusKind()) === "warn" && r.key.saved === true && r.key.checked === "unknown" && /identity\.sanas\.ai/.test(r.key.note ?? ""),
    "a key Sanas couldn't be asked about is saved, and the results say it is unchecked, and why",
    json(r.key),
  );

  await page.fill("#key", `  ${KEYS.good}\n`);
  await press("btnSaveKey", /^(?!Checking the key)/);
  r = await results();
  check(/Sanas accepted the key/.test(await status()), "Save key: Sanas accepted it", await status());
  check((await page.locator("#key").inputValue()) === "", "the pasted key is cleared from the box at once");
  check((await page.evaluate(() => window.__fake.keySetGot.at(-1))) === KEYS.good, "the Rust side gets the key without the spaces around it");
  check(/ending in WXYZ/.test(await text("#keyInfo")) && !(await removeOff()), "step 4 shows the key's last 4 characters, and Remove key is on", await text("#keyInfo"));
  check(
    r.key.saved === true && r.key.heldBy === "credential manager" && r.key.checked === "accepted" && r.key.note === null,
    "the results keep Sanas's check of the key (checked: accepted)",
    json(r.key),
  );

  // connect only: the SDK all the way through, under the app's CSP
  await press("btnConnect", CONNECTED_OR_NOT);
  r = await results();
  check((await page.locator("#connectInfo").getAttribute("data-kind")) === "ok" && r.sanas?.ok === true, "Connect only works with the saved key", await text("#connectInfo"));
  const paths = portal.requests.map((q) => q.path);
  check(
    paths.some((p) => p.endsWith("/entitlements")) && paths.some((p) => p.startsWith("/api/v2/app/endpoint/")) && paths.some((p) => p.endsWith("/heartbeat")),
    "the SDK asked the portal for entitlements, endpoint and heartbeat",
    paths.join("\n"),
  );
  check(portal.requests.every((q) => q.auth === `Bearer ${TOKEN}`), "each with the token from the Rust side", json(portal.requests));
  check(
    (await cspSeen()).length === 0 && !watch.problems.some((p) => p.startsWith("CSP")),
    "no CSP violations: the app's CSP lets the page reach Sanas's portal",
    [...(await cspSeen()), ...watch.problems].join("\n"),
  );
  check(r.key.checked === "accepted", "the key's check is still in the results after Connect only", json(r.key));
  check((await results()).gate.find((g) => g.row === "Connect only")?.status === "pass", "the checklist's Connect only row passes");

  // The portal fails with an id in its answer. The SDK's message keeps the answer and reaches the results
  // as it is (results.sanas, results.errors): the page's redactObject hides the id.
  watch.expectErrors = true;
  portal.failWith = 500;
  await press("btnConnect", CONNECTED_OR_NOT);
  portal.failWith = 0;
  watch.expectErrors = false;
  r = await results();
  check(
    r.sanas?.ok === false &&
      /HTTP 500/.test(r.sanas.message ?? "") &&
      r.sanas.message.includes("[redacted]") &&
      !(await text("#results")).includes(PORTAL_REQUEST_ID),
    "a portal failure with an id in its answer: the results keep the answer and hide the id",
    r.sanas?.message,
  );

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
    (await results()).sanas.code === "authentication_failed" && count(refusedText, /refused the saved key/g) === 1 && count(refusedText, /Sanas Console/g) === 1,
    "a refused saved key gets its advice once, not twice",
    refusedText,
  );
  watch.expectErrors = false;
  await press("btnConnect", CONNECTED_OR_NOT);
  check((await results()).sanas?.ok === true, "Connect only works again", await text("#connectInfo"));
}

// ---- 5 · Measure the delay ----

async function measureDelay(app) {
  const { results, text, press } = app;
  await press("btnMeasure", /Delay measured/, "#status", 40000);
  const r = await results();
  const d = r.checks.delay[0] ?? {};
  check(d.ok === true, "the delay was measured", json(d));
  check(Number.isFinite(d.passthroughMs) && d.passthroughMs >= 0 && d.passthroughMs <= 300, "passthroughMs is in 0…300 ms", `${d.passthroughMs}`);
  const capture = Number.isFinite(d.captureLatencyMs) ? d.captureLatencyMs : 10;
  check(
    Number.isFinite(d.estimateMs) && Math.abs(d.estimateMs - (d.passthroughMs + capture + 10)) <= 0.1001,
    "estimateMs = passthroughMs + the capture latency + 10 ms",
    `${d.estimateMs} vs ${d.passthroughMs} + ${capture} + 10`,
  );
  check(d.score >= 0.3, "the match is clear (score ≥ 0.3)", `${d.score}`);
  check(Number.isFinite(d.micFifoMs) && Math.abs(d.micFifoMs) <= 40, "the microphone's buffer is measured (|micFifoMs| ≤ 40)", `${d.micFifoMs}`);
  check(["good", "borderline", "slow"].includes(d.verdict), "with a verdict", d.verdict);
  check(d.route === "context" && d.site === "graph", "on the app's own route, recorded in the graph's context", `${d.route} ${d.site}`);
  const shown = await text("#measureInfo");
  check(/ms/.test(shown) && shown.includes(d.text), "step 3 shows the delay", shown);
  const row = r.gate.find((g) => g.row === "Delay at most 120 ms");
  check(row && row.status !== "todo", "the checklist's delay row uses it", json(row));
  note(`delay: passthrough ${d.passthroughMs} ms, estimate ${d.estimateMs} ms, micFifo ${d.micFifoMs} ms (${d.verdict})`);
}

// ---- 6 · monitor sounds never reach the cable ----

async function monitorSounds(app) {
  const { page, ids, WARNINGS, watch, fake, press, pressFor, results, status, statusKind, waitText, waitResults, choose } = app;
  const oscillators = () => fake(() => window.__fake.oscillators);
  // The monitor's contexts: never on the cable, and not the voice graph's.
  const monitorConnects = async () => {
    const c = await fake(() => ({
      connects: window.__fake.destinationConnects,
      monitor: window.__fake.contexts.map((x) => !x.__everCable && !x.__graph),
    }));
    return c.connects.filter((x) => c.monitor[x.ctx]);
  };
  await fake(() => window.__fake.setMicGain(0));
  await sleep(400);

  // (a) a beep plays in the headset, never into CABLE Output
  let before = (await oscillators()).length;
  let during = page.evaluate(() => window.__fake.cablePeak(900));
  await press("btnBeep", /Beep played/);
  let p = await during;
  let osc = await oscillators();
  check(p < 1e-4, "while a beep plays, CABLE Output stays silent", `peak ${p}`);
  check(osc.length > before && osc.every((o) => o.sinkId === ids.headsetOut), "the beep's oscillators play on the headset's earpiece", json(osc));
  let r = await results();
  check(same(r.checks.beep.at(-1), { at: r.checks.beep.at(-1)?.at, ok: true, sink: "mic-sibling" }), "the results record the beep and where it played", json(r.checks.beep));

  // (b) Windows' default playback device is CABLE Input: a warning; beeps still go to the earpiece; no test tone
  await fake(() => {
    window.__fake.defaultOutputIsCable = true;
    window.__fake.devicechange();
  });
  check(await waitText("#voiceWarnings", WARNINGS.OUTPUT_IS_CABLE), "step 2 warns that Windows' default playback device is CABLE Input");
  before = (await oscillators()).length;
  during = page.evaluate(() => window.__fake.cablePeak(900));
  await press("btnBeep", /Beep played/);
  p = await during;
  osc = (await oscillators()).slice(before);
  check(osc.length > 0 && osc.every((o) => o.sinkId === ids.headsetOut) && p < 1e-4, "beeps still play on the earpiece, and the cable stays silent", `peak ${p} ${json(osc)}`);
  watch.expectErrors = true;
  await page.selectOption("#longSource", "tone");
  await page.fill("#longMinutes", "1");
  before = (await oscillators()).length;
  await pressFor("btnLongStart", WARNINGS.OUTPUT_IS_CABLE);
  check(
    (await statusKind()) === "error" && (await status()) === WARNINGS.OUTPUT_IS_CABLE,
    "the long check refuses the test tone while the default playback device is CABLE Input",
    await status(),
  );
  check(!(await oscillators()).slice(before).some((o) => o.hz === TONE_HZ), "and no test tone was started");
  watch.expectErrors = false;
  await fake(() => {
    window.__fake.defaultOutputIsCable = false;
    window.__fake.devicechange();
  });
  check(await waitText("#voiceWarnings", WARNINGS.OUTPUT_IS_CABLE, { present: false }), "the warning goes when the default device is back");

  // (c) a stand-in microphone (the headset unplugged): no sounds at all
  await choose("#micSelect", ids.in1, /Microphone switched/);
  await fake(() => {
    window.__fake.unplug("Fake Audio Input 1");
    window.__fake.endMic();
  });
  r = await waitResults((x) => x.voice?.mic?.standIn === true, 3000);
  check(r.voice?.mic?.standIn === true, "the headset's microphone is gone: a stand-in takes over", json(r.voice?.mic));
  watch.expectErrors = true;
  before = (await oscillators()).length;
  await pressFor("btnBeep", WARNINGS.STAND_IN_QUIET);
  check((await status()) === WARNINGS.STAND_IN_QUIET && (await oscillators()).length === before, "no beep while a stand-in is in use (it would reach the meeting)", await status());
  watch.expectErrors = false;
  await fake(() => window.__fake.plug("Fake Audio Input 1"));
  r = await waitResults((x) => x.voice?.mic?.standIn === false && x.voice?.state === "running", 3000);
  check(r.voice?.mic?.standIn === false, "the headset's microphone is back", json(r.voice?.mic));

  // (d) the names are hidden: no idea where the headphones are, so no beep
  await fake(() => {
    window.__fake.hideLabels = true;
    window.__fake.devicechange();
  });
  r = await waitResults((x) => x.voice?.devices?.labelsVisible === false, 3000);
  watch.expectErrors = true;
  before = (await oscillators()).length;
  await pressFor("btnBeep", WARNINGS.NAMES_HIDDEN);
  check((await status()) === WARNINGS.NAMES_HIDDEN && (await oscillators()).length === before, "no beep while the device names are hidden", await status());
  watch.expectErrors = false;
  await fake(() => {
    window.__fake.hideLabels = false;
    window.__fake.devicechange();
  });
  r = await waitResults((x) => x.voice?.devices?.labelsVisible === true && x.voice?.state === "running", 3000);
  check(r.voice?.devices?.labelsVisible === true && r.voice?.state === "running", "the names are back and the voice still runs", r.voice?.state);
  r = await results();
  check(
    same(r.checks.beep.slice(-2).map((b) => b.error), ["STAND_IN_QUIET", "NAMES_HIDDEN"]),
    "the results record the refused beeps by their codes",
    json(r.checks.beep),
  );
  const mc = await monitorConnects();
  check(mc.length > 0 && mc.every((c) => c.sinkIdAtConnect === ids.headsetOut), "every monitor sound was connected on the earpiece's sink", json(mc));

  // (e) the earpiece unplugged: a device change reaches the monitor, which closes its context there
  await press("btnBeep", /Beep played/);
  await fake(() => window.__fake.unplug("Fake Audio Output 2"));
  const closedThere = await app.waitPage(
    (earpiece) => {
      const there = window.__fake.contexts.filter((c) => !c.__everCable && c.sinkId === earpiece);
      return there.length > 0 && there.every((c) => c.state === "closed") ? there.length : null;
    },
    ids.headsetOut,
    3000,
  );
  check(Boolean(closedThere), "the earpiece unplugged: the monitor closes its context on it");
  watch.expectErrors = true;
  await pressFor("btnBeep", WARNINGS.NO_HEADPHONES);
  check((await status()) === WARNINGS.NO_HEADPHONES, "and plays no beep until the headphones are back", await status());
  watch.expectErrors = false;
  await fake(() => window.__fake.plug("Fake Audio Output 2"));
  r = await waitResults((x) => x.voice?.monitor?.refusal === null, 3000);
  await press("btnBeep", /Beep played/);
  check(r.voice?.monitor?.sink === "mic-sibling", "the earpiece is back: beeps play there again", json(r.voice?.monitor));
  await fake(() => window.__fake.setMicGain(1));
}

// ---- 7 · recovery ----

async function recovery(app) {
  const { results, waitResults, fake, peak, lastRecovery } = app;
  const backAfter = async (n, timeout = 3000) =>
    waitResults((x) => (x.voice?.recoveries?.length ?? 0) > n && x.voice?.state === "running", timeout);
  let n = (await results()).voice.recoveries.length;

  await fake(() => window.__fake.cableContext().suspend());
  let r = await backAfter(n);
  let rec = lastRecovery(r);
  check(rec?.cause === "context-suspended" && rec.outageMs < 2000, "a suspended context is resumed (back in < 2 s)", json(rec));
  check(same(rec?.steps, ["resume"]), "by a resume", json(rec?.steps));
  let p = await peak(1500);
  check(p > 0.01, "the voice is on the cable again", `peak ${p}`);

  n = r.voice.recoveries.length;
  await fake(() => window.__fake.cableContext().dispatchEvent(new Event("error")));
  r = await backAfter(n);
  rec = lastRecovery(r);
  check(rec?.cause === "render-error", "a render error is recovered", json(rec));

  n = r.voice.recoveries.length;
  await fake(() => {
    window.__fake.resumeHangsOnce = true;
    window.__fake.cableContext().dispatchEvent(new Event("error"));
  });
  r = await backAfter(n);
  rec = lastRecovery(r);
  check(
    rec?.cause === "render-error" && same(rec.steps, ["resume", "rebuild"]) && rec.outageMs < 1500,
    "a resume that fails again (a second error) is given up at once and the context rebuilt",
    json(rec),
  );

  n = r.voice.recoveries.length;
  const before = await fake(() => window.__fake.contexts.indexOf(window.__fake.cableContext()));
  await fake(() => window.__fake.cableContext().close());
  r = await backAfter(n);
  rec = lastRecovery(r);
  const now = await fake(() => window.__fake.contexts.indexOf(window.__fake.cableContext()));
  check(rec?.cause === "context-closed" && (rec.steps ?? []).includes("rebuild") && now > before, "a closed context is rebuilt (a new context on the cable)", json(rec));
  p = await peak(1500);
  check(p > 0.01, "and the voice is back", `peak ${p}`);

  n = r.voice.recoveries.length;
  await fake(() => window.__fake.endMic());
  r = await backAfter(n);
  rec = lastRecovery(r);
  check(rec?.cause === "mic-ended" && same(rec.steps, ["reopen-mic"]), "a microphone that ended is opened again", json(rec));
  p = await peak(1500);
  check(p > 0.01, "and the voice is back", `peak ${p}`);
  check(rec?.micToo === false && rec?.restart === undefined, "a microphone alone is no Windows Audio restart", json(rec));

  r = await waitResults((x) => x.voice?.debug?.contexts === 1 && x.voice?.debug?.micSources === 1, 3000);
  check(r.voice.debug.contexts === 1 && r.voice.debug.micSources === 1, "after all that: one context and one microphone source", json(r.voice.debug));
  const closed = await fake(() => {
    const cur = window.__fake.cableContext();
    return window.__fake.contexts.filter((c) => c.__everCable && c !== cur).map((c) => c.state);
  });
  check(closed.length >= 2 && closed.every((s) => s === "closed"), "every older graph context is closed", json(closed));
  const lines = await app.text("#recoveryLog");
  check(/\d\d:\d\d:\d\d · the audio was paused: back after \d+\.\d s/.test(lines), "the recovery log says when, why and after how long", lines);
}

// ---- 8 · headset lost ----

async function headsetLost(app) {
  const { ids, fake, peak, waitResults, results, text, choose, settingsFile, press, status, statusKind } = app;
  const voiceKind = () => app.page.locator("#voiceStatus").getAttribute("data-kind");
  await choose("#micSelect", ids.in1, /Microphone switched/);
  check((await settingsFile())?.micLabel === IN1, "the chosen microphone is saved", json(await settingsFile()));
  await fake(() => {
    window.__fake.unplug("Fake Audio Input 1");
    window.__fake.endMic();
  });
  let r = await waitResults((x) => x.voice?.mic?.standIn === true && x.voice?.state === "running", 3000);
  check(r.voice?.mic?.standIn === true, "the headset is unplugged: a stand-in microphone within 3 s", json(r.voice?.mic));
  check((await text("#voiceWarnings")).includes("is not connected, so the app uses"), "step 2 says which microphone stands in", await text("#voiceWarnings"));
  check((await voiceKind()) === "warn", "and its status is yellow while a stand-in is used", await voiceKind());
  check((await app.page.$eval("#micSelect", (s) => s.selectedOptions[0]?.textContent ?? "")).endsWith("(for now)"), "the list shows the stand-in (for now)");
  // The stand-in's warning names both microphones on the page; the copied results must not.
  check((r.voice?.warnings ?? []).some((w) => w.code === "STAND_IN"), "the results list the stand-in's warning", json(r.voice?.warnings));
  await leakCheck(app, "during a stand-in");
  const p = await peak(1500);
  check(p > 0.01, "the voice stays on the cable through the stand-in", `peak ${p}`);
  await fake(() => window.__fake.plug("Fake Audio Input 1"));
  r = await waitResults((x) => x.voice?.mic?.standIn === false && x.voice?.state === "running", 3000);
  check(r.voice?.mic?.standIn === false && r.voice.mic.how === "saved-id", "the headset is back within 3 s, and used again", json(r.voice?.mic));
  check((await settingsFile())?.micLabel === IN1, "the settings still name the headset's microphone (a stand-in is never saved)", json(await settingsFile()));

  // No microphone at all: Check the microphone says so as an error, and the results say it is not ok.
  await fake(() => {
    window.__fake.unplug("Fake Audio Input 1");
    window.__fake.unplug("Fake Audio Input 2");
    window.__fake.endMic();
  });
  r = await waitResults((x) => x.voice?.state === "no-mic", 5000);
  check(r.voice?.state === "no-mic", "both microphones gone: the voice waits for one", r.voice?.state);
  await press("btnMic", /^(?!Checking the microphone)/);
  r = await results();
  check(
    (await statusKind()) === "error" && (await status()) === (await text("#voiceStatus")) && r.microphone?.ok === false && r.microphone?.error === "no-mic",
    "Check the microphone without any microphone: an error with step 2's words, and the results say not ok",
    `${await statusKind()}: ${await status()} | ${json(r.microphone)}`,
  );
  await fake(() => {
    window.__fake.plug("Fake Audio Input 2");
    window.__fake.plug("Fake Audio Input 1");
  });
  r = await waitResults((x) => x.voice?.state === "running" && x.voice?.mic?.standIn === false && x.voice?.mic?.how === "saved-id", 5000);
  check(r.voice?.state === "running" && r.voice.mic?.how === "saved-id", "the microphones are back: the headset's is used again", json(r.voice?.mic));
  await press("btnMic", /^(?!Checking the microphone)/);
  r = await results();
  check(
    (await status()) === "Microphone checked." && (await statusKind()) === "ok" && r.microphone?.ok === true,
    "and Check the microphone is ok again",
    `${await status()} | ${json(r.microphone)}`,
  );
}

// ---- 13 · overlapping operations ----

async function overlapping(app) {
  const { page, ids, fake, peak, waitResults, waitPage, choose } = app;
  const openCable = () => fake(() => window.__fake.contexts.filter((c) => c.__everCable && c.state !== "closed").length);
  await fake(() => {
    window.__fake.gumDelayMs = 300;
    window.__fake.sinkDelayMs = 300;
  });

  // (a) the microphone ends, and the user picks another one while it is reopened
  await fake(() => window.__fake.endMic());
  await sleep(50);
  await page.selectOption("#micSelect", ids.in2);
  let r = await waitResults((x) => x.voice?.state === "running" && x.voice?.mic?.how === "saved-id" && x.voice?.debug?.micSources === 1, 5000);
  let live = await waitPage(() => {
    const l = window.__fake.liveMics();
    return l.length === 1 && l[0] === "Fake Audio Input 2" ? l : null;
  });
  check(r.voice?.state === "running" && r.voice.mic?.how === "saved-id", "(a) the user's choice wins over the reopening microphone", json(r.voice?.mic));
  check((await page.$eval("#micSelect", (s) => s.value)) === ids.in2, "(a) the list shows the chosen microphone");
  check(same(live, [IN2]), "(a) only the chosen microphone stays open", json(await fake(() => window.__fake.liveMics())));
  check(r.voice?.debug?.micSources === 1, "(a) one microphone source", json(r.voice?.debug));

  // (b) the context closes, and the user picks the output while it is rebuilt
  await fake(() => window.__fake.cableContext().close());
  await sleep(50);
  await page.selectOption("#outSelect", ids.cableIn);
  r = await waitResults((x) => x.voice?.state === "running" && x.voice?.debug?.contexts === 1, 5000);
  const open = await waitPage(async () => {
    const n = window.__fake.contexts.filter((c) => c.__everCable && c.state !== "closed").length;
    return n === 1 ? n : null;
  });
  check(r.voice?.state === "running" && r.voice.debug?.contexts === 1, "(b) the voice runs on one context", json(r.voice?.debug));
  check(open === 1 && (await openCable()) === 1, "(b) exactly one context on the cable is open, every other one closed", `${await openCable()}`);
  check(r.voice?.output?.how === "saved-id", "(b) the chosen output is used", json(r.voice?.output?.how));

  // (c) the microphone ends and comes and goes five times within half a second
  for (let i = 0; i < 5; i++) {
    await fake(() => {
      window.__fake.endMic();
      window.__fake.unplug("Fake Audio Input 2");
    });
    await sleep(50);
    await fake(() => window.__fake.plug("Fake Audio Input 2"));
    await sleep(50);
  }
  r = await waitResults((x) => x.voice?.state === "running" && x.voice?.debug?.micSources === 1 && x.voice?.debug?.contexts === 1, 8000);
  live = await waitPage(() => (window.__fake.liveMics().length === 1 ? window.__fake.liveMics() : null), null, 3000);
  check(
    r.voice?.state === "running" && r.voice.debug?.micSources === 1 && r.voice.debug?.contexts === 1,
    "(c) after a burst of microphone changes: running, one microphone source, one context",
    json(r.voice?.debug),
  );
  check(Array.isArray(live) && live.length === 1, "(c) exactly one microphone stays open", json(await fake(() => window.__fake.liveMics())));
  const p = await peak(1500);
  check(p > 0.01, "(c) and the voice is on the cable", `peak ${p}`);

  await fake(() => {
    window.__fake.gumDelayMs = 0;
    window.__fake.sinkDelayMs = 0;
  });
  await choose("#micSelect", ids.in1, /Microphone switched/);
  await choose("#outSelect", "", /Switched where your voice goes/);
  r = await waitResults((x) => x.voice?.state === "running" && x.voice?.output?.how === "auto", 3000);
  check(r.voice?.output?.how === "auto" && r.voice.mic?.how === "saved-id", "back to the headset's microphone and the automatic output", json(r.voice?.output?.how));
}

// ---- 10 · the long check with the test tone, and Hide ----

async function longTone(app) {
  const { page, fake, results, peak, press, text, waitResults, waitText } = app;
  await page.selectOption("#longSource", "tone");
  await page.fill("#longMinutes", "0.25");
  await fake(() => {
    window.__fake.hideMs = 5000;
  });
  const t0 = Date.now();
  await press("btnLongStart", /Long check running/);
  check(
    /test tone/.test(await text("#voiceStatus")) && (await page.locator("#voiceStatus").getAttribute("data-kind")) === "warn",
    "step 2 says, in yellow, that the meeting hears a test tone",
    await text("#voiceStatus"),
  );
  check(await page.locator("#btnLongStop").isEnabled(), "Stop and check is on while the check runs");
  check(await page.locator("#micSelect").isDisabled(), "the device choices wait while a check runs");
  await sleep(Math.max(0, t0 + 3000 - Date.now()));
  await press("btnHide", /hidden for 30 minutes/);
  check(/The long check now ends at \d\d:\d\d/.test(await text("#hideInfo")), "Hide during the check says when the check now ends", await text("#hideInfo"));
  await sleep(Math.max(0, t0 + 6000 - Date.now()));
  await fake(() => window.__fake.cutCable(300));
  await sleep(Math.max(0, t0 + 9000 - Date.now()));
  const running = await text("#longInfo");
  check(/^Long check: \d+:\d\d of \d+:\d\d · now \w+ · minimized so far \d+:\d\d · hidden so far \d+:\d\d · tone −\d+\.\d dB · clicks \d+ · gaps \d+$/.test(running), "the long check shows its progress", running);
  await sleep(Math.max(0, t0 + 12000 - Date.now()));
  await page.click("#btnLongStop");
  await page.waitForFunction(() => /Long check done/.test(document.querySelector("#longInfo").textContent), null, { timeout: 40000 });
  const r = await results();
  const L = r.checks.long.at(-1) ?? {};
  check(L.mode === "tone", "the tone check is in the results", L.mode);
  check(Math.abs((L.extendedToSec ?? 0) - 128) <= 3, "Hide during the check extended it to the hide's end plus 2 minutes", `${L.extendedToSec}`);
  check(
    Math.abs((L.tone?.levelDb ?? 0) + 12) <= 1 && Math.abs((L.tone?.minStableDb ?? 0) + 12) <= 1,
    "the tone arrives at −12 dBFS",
    `${L.tone?.levelDb} / ${L.tone?.minStableDb}`,
  );
  const gaps = (L.tone?.events ?? []).filter((e) => e.kind === "gap");
  check(L.tone?.counts?.gaps === 1 && gaps.length === 1 && gaps[0].ms >= 240 && gaps[0].ms <= 360, "the 300 ms cut is found as one gap of about 300 ms", json(L.tone?.counts) + json(gaps));
  check(L.phases?.hiddenSec >= 3 && L.phases?.hiddenSec <= 7, "the hidden phase is counted (about 5 s)", json(L.phases));
  const readings = L.micPath?.readings ?? [];
  check(readings.length >= 1 && readings.every((x) => Math.abs(x.lagMs) <= 40), "the microphone's buffer was read", json(readings));
  check(Array.isArray(L.renderPauses) && L.renderPauses.length === 0, "no rendering pauses", json(L.renderPauses));
  check(L.verdict === "fail" && L.reasons.some((x) => /sound stopped/.test(x)), "the gap fails the check", json(L.reasons));
  note(`ticks per 30 min: tone ${L.tonePath?.ticksPer30Min}, microphone ${L.micPath?.ticksPer30Min} (not asserted: fake clocks)`);
  const done = await text("#longInfo");
  check(done.startsWith("Long check done: not passed:") && done.includes("Gaps: 1"), "step 3 says why it did not pass, with its lines", done);
  const toneGone = await waitText("#voiceStatus", "test tone", { present: false, timeout: 3000 });
  const back = await waitResults((x) => x.voice?.state === "running", 3000);
  check(toneGone && back.voice?.state === "running", "the voice is back on the cable afterwards (the test source removed)", await text("#voiceStatus"));
  const p = await peak(1500);
  check(p > 0.01, "the microphone reaches the cable again", `peak ${p}`);
  check(await page.locator("#btnLongStart").isEnabled(), "Start the long check is on again");
  check(await page.locator("#btnLongStop").isDisabled(), "and Stop and check is off");
  check(await page.locator("#micSelect").isEnabled(), "and the device choices are back");
  await fake(() => {
    window.__fake.hiddenUntil = 0;
  });
}

// ---- 11 · the long check with the microphone ----

async function longMic(app) {
  const { page, fake, results, press } = app;
  await page.selectOption("#longSource", "mic");
  await page.fill("#longMinutes", "0.25");
  await press("btnLongStart", /Long check running/);
  await sleep(6000);
  await fake(() => window.__fake.cutCable(300));
  await page.waitForFunction(() => /Long check done/.test(document.querySelector("#longInfo").textContent), null, { timeout: 40000 });
  const r = await results();
  const L = r.checks.long.at(-1) ?? {};
  const drops = L.speech?.dropouts ?? [];
  const long = drops.filter((d) => d.ms >= 200);
  check(L.mode === "mic" && long.length === 1 && long[0].ms >= 240 && long[0].ms <= 360, "the 300 ms cut is one drop-out of about 300 ms", json(drops));
  note(`shorter drop-outs: ${drops.filter((d) => d.ms < 200).length} (reported only)`);
  check([0, 1].includes(L.speech?.gaps?.length), "at most one gap in the speech", json(L.speech?.gaps));
  check(L.recordedSec >= 14 && L.recordedSec <= 17, "it recorded about 15 s and ended by itself", `${L.recordedSec}`);
}

// ---- 12 · Hide ----

async function hide(app) {
  const { fake, press, text, results } = app;
  await fake(() => {
    window.__fake.hideMs = 1000;
  });
  const before = await fake(() => window.__fake.hides.length);
  await press("btnHide", /hidden for 30 minutes/);
  const hides = await fake(() => window.__fake.hides);
  check(hides.length === before + 1 && hides.at(-1).minutes === 30, "Hide asks the Rust side to hide the window for 30 minutes", json(hides));
  check(/comes back by itself/.test(await text("#hideInfo")), "step 3 says the app comes back by itself", await text("#hideInfo"));
  const r = await results();
  check(r.checks.hide.length >= 1 && r.checks.hide[0].minutes === 30 && r.checks.hide.at(-1).minutes === 30, "the results record the Hide", json(r.checks.hide));
  await sleep(1100);
}

// ---- Advanced: the audio element route on request (Session B step 7.6) ----

async function routeChoice(app) {
  const { results, waitResults, peak, press, choose, text } = app;
  const methods = (r) => (r.voice?.output?.tried ?? []).map((t) => t.method);
  await app.page.click("details.advanced summary"); // "Advanced (only if I ask)"
  await choose("#routeSelect", "element", /Output route switched/);
  let r = await waitResults((x) => x.voice?.state === "running" && x.voice.output?.method === "element", 5000);
  check(
    r.voice?.output?.method === "element" && r.voice.output.routePreference === "element" && same(methods(r), ["element"]),
    "Advanced: the voice goes through an audio element on request",
    json(r.voice?.output),
  );
  let p = await peak(1500);
  check(p > 0.01, "and reaches the cable", `peak ${p}`);
  const off = await graphOffCable(app);
  check(
    off.open === 1 && off.connects.length === 0,
    "nothing is connected to the graph context's own output (the earpiece): the user does not hear their own voice",
    json(off),
  );
  await press("btnMeasure", /Delay measured/, "#status", 40000);
  r = await results();
  const d = r.checks.delay.at(-1) ?? {};
  check(
    d.ok === true && d.route === "element" && d.routePreference === "element" && d.site === "own-context" && d.micFifoMs === null,
    "the delay through the audio element is measured in a context of its own on VB-CABLE's clock",
    json(d),
  );
  const row = r.gate.find((g) => g.row === "Delay at most 120 ms");
  check(row && row.text.includes("not counted"), "the checklist lists it without counting it", row?.text);
  check(/an audio element \(fallback\)/.test(await text("#voiceInfo")), "step 2 says how the voice is sent", await text("#voiceInfo"));
  await choose("#routeSelect", "auto", /Output route switched/);
  r = await waitResults((x) => x.voice?.state === "running" && x.voice.output?.method === "context", 5000);
  check(r.voice?.output?.method === "context" && r.voice.output.routePreference === "auto", "back to the app's audio engine", json(r.voice?.output?.method));
  check((r.voice?.output?.routeChanges ?? []).length === 2, "both route changes are in the results", json(r.voice?.output?.routeChanges));
  p = await peak(1500);
  check(p > 0.01, "and the voice is on the cable", `peak ${p}`);
}

// ---- the page closes: everything stops ----

async function pageClose(app) {
  const { fake, press, waitPage, waitResults } = app;
  await press("btnBeep", /Beep played/); // a monitor context is open too
  await fake(() => window.dispatchEvent(new Event("pagehide")));
  const stopped = await waitPage(() => {
    const f = window.__fake;
    const open = f.contexts.filter((c) => c.state !== "closed").length;
    return open === 0 && f.liveMics().length === 0 ? { open, mics: f.liveMics() } : null;
  }, null, 5000);
  check(Boolean(stopped), "when the page closes, every audio context closes and the microphone is released");
  const r = await waitResults((x) => x.voice?.state === "stopped", 3000);
  check(r.voice?.state === "stopped", "and the voice says it stopped", r.voice?.state);
}

// ---- 14 · VB-CABLE gone during a recovery ----

async function cableGone(app) {
  const { fake, results, waitResults, peak, text, lastRecovery } = app;
  const start = await fake(() => ({ connects: window.__fake.destinationConnects.length, contexts: window.__fake.contexts.length }));
  const n = (await results()).voice.recoveries.length;
  await fake(() => {
    window.__fake.noCable = true;
    window.__fake.devicechange();
  });
  await sleep(300);
  await fake(() => window.__fake.cableContext().dispatchEvent(new Event("error")));
  await sleep(3000);
  let r = await results();
  check(r.voice.state === "recovering" && r.voice.recoveries.length === n, "with VB-CABLE gone the voice is not back after 3 s", r.voice.state);
  check(/waiting for “CABLE Input”/.test(await text("#voiceStatus")), "step 2 says it waits for CABLE Input", await text("#voiceStatus"));
  check(
    (await app.page.locator("#micSelect").isEnabled()) && (await app.page.locator("#outSelect").isEnabled()),
    "the device choices stay usable while the voice recovers",
  );
  const mid = await fake((from) => ({
    connects: window.__fake.destinationConnects.length,
    none: window.__fake.contexts.slice(from).filter((c) => String(c.sinkId?.type ?? c.sinkId) === "none").length,
  }), start.contexts);
  check(mid.connects === start.connects && mid.none === 0, "meanwhile nothing is connected and no silent sink is used", json(mid));
  await fake(() => {
    window.__fake.noCable = false;
    window.__fake.cableAlias("fake-cable-2");
    window.__fake.devicechange();
  });
  r = await waitResults((x) => x.voice?.state === "running" && x.voice.recoveries.length > n, 3000);
  check(r.voice?.state === "running" && r.voice.recoveries.length > n, "VB-CABLE is back (under another id): the voice is back within 3 s", r.voice?.state);
  check(lastRecovery(r)?.cause === "render-error", "the recovery is recorded", json(lastRecovery(r)));
  check((await fake(() => window.__fake.cableContext()?.sinkId)) === "fake-cable-2", "the new context plays into the new id");
  const added = await fake((from) => window.__fake.destinationConnects.slice(from), start.connects);
  check(added.length >= 1 && added.every((c) => c.sinkIdAtConnect === "fake-cable-2"), "connected only after its setSinkId", json(added));
  const p = await peak(1500);
  check(p > 0.01, "the voice is on the cable", `peak ${p}`);
}

// ---- 15 · Copy results ----

async function copyResults(app) {
  const { page, press, text, results } = app;
  const { copied } = await leakCheck(app, "after every scenario");
  const copyInfo = await text("#copyInfo");
  check(/^Copied/.test(copyInfo), "Copy results copies by itself (not the fallback)", copyInfo);
  const parsed = JSON.parse(copied || "{}");
  check(
    parsed.schema === 2 &&
      parsed.shell === "app" &&
      parsed.app?.build === BUILD &&
      parsed.key?.checked === "accepted" &&
      parsed.sanas?.ok === true &&
      parsed.microphone?.ok === true &&
      parsed.voice?.state === "running" &&
      parsed.checks?.delay?.length >= 1 &&
      parsed.checks?.long?.length >= 2 &&
      parsed.checks?.hide?.length >= 2 &&
      parsed.gate?.length === 9,
    "the copied results hold the build, the key's check, Connect only, the voice, the checks and the checklist",
    copied.slice(0, 600),
  );
  check(copied.includes(CABLE_IN_LABEL), "they keep VB-CABLE's own names");
  check(
    (parsed.errors ?? []).some((e) => /HTTP 500/.test(e.message) && e.message.includes("[redacted]")),
    "the portal's failure is among the errors, its id hidden",
    json(parsed.errors),
  );
  const gate = await page.$$eval("#gateList li", (lis) => lis.map((li) => [li.dataset.kind, li.textContent]));
  check(
    gate.length === 9 && gate.every(([kind, t]) => ["ok", "error", "info", "warn"].includes(kind) && /^[✓✗…!] · /.test(t)),
    "step 3 shows the Session B checklist",
    json(gate),
  );

  // Copied by hand: a selection of the results stays (they used to be redrawn every second while the voice runs).
  const selected = () => page.evaluate(() => getSelection().toString());
  await page.click("details:not(.advanced) summary"); // Show the results
  const before = await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("#results"));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    return getSelection().toString();
  });
  await sleep(1500);
  check(before.length > 1000 && (await selected()) === before, "a selection of the results stays while it is copied by hand", `${before.length} → ${(await selected()).length}`);

  // The clipboard refuses: the results alone are selected (never the whole page, whose step 2 shows the
  // devices' real names), and the page asks for Ctrl+C only.
  await page.evaluate(() => {
    getSelection().removeAllRanges();
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: () => Promise.reject(new DOMException("Write permission denied.", "NotAllowedError")),
    });
    document.querySelector("#copyInfo").textContent = "";
  });
  await press("btnCopy", /\S/, "#copyInfo");
  const info = await text("#copyInfo");
  let sel = await selected();
  const pre = await text("#results");
  check(
    /Ctrl\+C/.test(info) && !/Ctrl\+A/.test(info) && sel === pre && sel.length > 1000,
    "when the clipboard refuses, the results alone are selected, for Ctrl+C",
    `${info} | selected ${sel.length} of ${pre.length} characters`,
  );
  check(!/Fake Audio|Fake Headset|[0-9a-f]{64}/i.test(sel), "and the selection holds no device names or ids");
  await sleep(1500);
  sel = await selected();
  check(sel === pre, "and it stays selected", `${sel.length} characters selected`);

  // Back to normal: once nothing is selected and the results are closed, they are drawn again.
  await page.evaluate(() => {
    delete navigator.clipboard.writeText; // the browser's own again
    getSelection().removeAllRanges();
    document.querySelector("#results").closest("details").open = false;
  });
  const at = (await results()).at;
  const later = await app.waitResults((x) => x.at !== at, 3000);
  check(later.at !== at, "the results are drawn again once nothing is selected", `${at} → ${later.at}`);
}

// ---- 4 · settings ----

async function settings(app) {
  const { page, ids, fake, waitResults, choose, reload, setFlags, results } = app;
  await choose("#micSelect", ids.in2, /Microphone switched/);
  const saved = await fake(() => window.__fake.settingsSaved.at(-1));
  check(JSON.parse(saved ?? "{}").micLabel === IN2, "choosing a microphone saves it (settings_save)", saved);
  check(!/key|token/i.test(Object.keys(JSON.parse(saved ?? "{}")).join(" ").replace(/hotkey\w*|keyExpiresOn/gi, "")), "the settings hold no key");
  await reload();
  let r = await waitResults((x) => x.voice?.state === "running", 5000);
  check(r.settings?.source === "saved" && r.voice?.mic?.how === "saved-id", "after a relaunch the saved microphone is used by its id", json(r.voice?.mic?.how));
  check((await page.$eval("#micSelect", (s) => s.value)) === ids.in2, "and the list shows it");

  await setFlags({ settingsLoadFails: true });
  await reload();
  r = await waitResults((x) => x.voice?.state === "running", 5000);
  check(
    r.settings?.source === "unreadable" && r.settings.errors.some((e) => /Could not read the settings file/.test(e)),
    "unreadable settings: the results say so",
    json(r.settings),
  );
  check(r.voice?.state === "running" && r.voice.mic?.how === "default", "and the voice runs on the defaults", json(r.voice?.mic?.how));
  await setFlags({});

  // A choice that cannot be saved still applies, and the page says it was not saved.
  await choose("#micSelect", ids.in1, /^Microphone switched\.$/);
  check((await app.settingsFile())?.micLabel === IN1, "the headset's microphone is saved again", json(await app.settingsFile()));
  await fake(() => {
    window.__fake.settingsSaveFails = true;
  });
  await choose("#micSelect", ids.in2, /Could not save the settings/);
  r = await waitResults((x) => x.voice?.state === "running" && x.voice?.mic?.how === "saved-id", 5000);
  check(
    (await app.statusKind()) === "warn" && /^Microphone switched\. Could not save the settings: /.test(await app.status()),
    "a choice that cannot be saved still applies, with a warning",
    await app.status(),
  );
  check(
    (await page.$eval("#micSelect", (sel) => sel.value)) === ids.in2 && (await app.settingsFile())?.micLabel === IN1,
    "the microphone is switched but not saved",
    json(await app.settingsFile()),
  );
  await fake(() => {
    window.__fake.settingsSaveFails = false;
  });
  await choose("#micSelect", ids.in1, /^Microphone switched\.$/);
  r = await results();
  check(r.voice?.mic?.how === "saved-id" && (await app.settingsFile())?.micLabel === IN1, "back to the headset's microphone, saved", r.voice?.mic?.how);

  // The output: CABLE Input picked in the list is saved (its id and name) and used by its id after a
  // relaunch; Automatic saves no output.
  const lastSaved = async () => JSON.parse((await fake(() => window.__fake.settingsSaved.at(-1))) ?? "{}");
  await choose("#outSelect", ids.cableIn, /^(?!Switching where your voice goes)/);
  let out = await lastSaved();
  check(
    out.cableDeviceId === ids.cableIn && out.cableLabel === CABLE_IN_LABEL && (await app.status()) === "Switched where your voice goes.",
    "choosing CABLE Input saves its id and name (settings_save)",
    `${await app.status()} | ${json(out)}`,
  );
  await reload();
  r = await waitResults((x) => x.voice?.state === "running" && x.voice?.output?.how === "saved-id", 5000);
  check(
    r.voice?.output?.how === "saved-id" && (await page.$eval("#outSelect", (s) => s.value)) === ids.cableIn,
    "after a relaunch the saved output is used by its id, and the list shows it",
    json(r.voice?.output?.how),
  );
  await choose("#outSelect", "", /^(?!Switching where your voice goes)/);
  out = await lastSaved();
  r = await waitResults((x) => x.voice?.state === "running" && x.voice?.output?.how === "auto", 5000);
  check(
    out.cableDeviceId === "" && out.cableLabel === "" && r.voice?.output?.how === "auto",
    "choosing Automatic saves no output, and CABLE Input is found by itself",
    `${json(out)} ${r.voice?.output?.how}`,
  );
}

// ---- 9 · sink fallbacks ----

async function sinkFallbacks(app) {
  const { ids, fake, waitResults, peak, reload, setFlags, press, text, status, statusKind, choose, lastRecovery, VOICE_TEXTS } = app;
  const methods = (r) => (r.voice?.output?.tried ?? []).map((t) => t.method);
  const oks = (r) => (r.voice?.output?.tried ?? []).map((t) => t.ok);
  const permissionCalls = () => fake(() => window.__fake.permissionCalls);
  const nothingOnTheEarpiece = async (what) => {
    const off = await graphOffCable(app);
    check(
      off.open === 1 && off.connects.length === 0,
      `${what} nothing is connected to the graph context's own output (the earpiece), so the user does not hear their own voice`,
      json(off),
    );
  };

  // (a) the context route refused: the audio element
  await setFlags({ refuseContextSink: true });
  await reload();
  let r = await waitResults((x) => x.voice?.state === "running", 5000);
  const tried = r.voice?.output?.tried ?? [];
  check(r.voice?.output?.method === "element", "(a) the context route refused: the voice goes through an audio element", json(r.voice?.output));
  check(
    tried[0]?.method === "context" && tried[0]?.ok === false && tried[0]?.errorName === "NotAllowedError" && tried[1]?.method === "element" && tried[1]?.ok === true,
    "(a) the results list both tries",
    json(tried),
  );
  let p = await peak(1500);
  check(p > 0.01, "(a) the voice reaches the cable", `peak ${p}`);
  check((await permissionCalls()) === 0, "(a) the permission fix is not needed");
  check(r.voice?.output?.contextSink === "mic-sibling", "(a) the graph's context runs on the headset's earpiece", r.voice?.output?.contextSink);
  await nothingOnTheEarpiece("(a)");
  check(/an audio element \(fallback\)/.test(await text("#voiceInfo")), "(a) step 2 says so", await text("#voiceInfo"));
  // Chromium names the device in the refusal ("access to the device <64-hex id> is not permitted."): kept, id hidden.
  check(
    tried[0]?.errorMessage === "access to the device [redacted] is not permitted." && !/[0-9a-f]{64}/i.test(await text("#results")),
    "(a) the refusal's text is kept in the results without the device id",
    json(tried[0]),
  );

  // (f) the element route lost: rebuilt on the same route only
  const n = r.voice.recoveries.length;
  await fake(() => window.__fake.pauseElement());
  r = await waitResults((x) => x.voice?.state === "running" && x.voice.recoveries.length > n, 3000);
  check(lastRecovery(r)?.cause === "sink-changed", "(f) a paused audio element is a lost route", json(lastRecovery(r)));
  check(same(methods(r), ["element"]) && (await permissionCalls()) === 0, "(f) the rebuild tried the audio element only, without the permission fix", json(r.voice?.output?.tried));
  check((r.voice?.output?.routeChanges ?? []).length === 0, "(f) no route change", json(r.voice?.output?.routeChanges));
  p = await peak(1500);
  check(p > 0.01, "(f) the voice is back", `peak ${p}`);
  await nothingOnTheEarpiece("(f)");

  // (b) both refused, the permission fix helps
  await setFlags({ refuseContextSink: true, refuseElementSink: true, permissionFixes: true });
  await reload();
  r = await waitResults((x) => x.voice?.state === "running", 5000);
  check(
    r.voice?.output?.method === "context-after-permission" &&
      same(methods(r), ["context", "element", "permission", "context-after-permission"]) &&
      same(oks(r), [false, false, true, true]),
    "(b) both refused: the permission fix, then the context route works",
    json(r.voice?.output?.tried),
  );
  check((await permissionCalls()) === 1, "(b) the permission fix ran once");
  p = await peak(1500);
  check(p > 0.01, "(b) the voice reaches the cable", `peak ${p}`);
  check(/\+ the permission fix/.test(await text("#voiceInfo")), "(b) step 2 says the permission fix was used", await text("#voiceInfo"));

  // (c) both refused, the permission fix answers but changes nothing
  await setFlags({ refuseContextSink: true, refuseElementSink: true });
  await reload();
  r = await waitResults((x) => x.voice?.state === "sink-refused", 8000);
  check(
    r.voice?.state === "sink-refused" &&
      same(methods(r), ["context", "element", "permission", "context-after-permission", "element-after-permission"]) &&
      same(oks(r), [false, false, true, false, false]),
    "(c) everything refused: the voice is not sent, and every try is listed",
    json(r.voice?.output?.tried ?? r.voice?.state),
  );
  check(/could not send your voice/.test(await text("#voiceStatus")), "(c) step 2 says the voice could not be sent", await text("#voiceStatus"));
  p = await peak(1000);
  check(p < 1e-4, "(c) nothing reaches the cable", `peak ${p}`);
  check(r.gate.find((g) => g.row === "Voice into CABLE Input")?.status === "fail", "(c) the checklist's row fails");
  // An output picked meanwhile is taken (saved, and used by every try), though nothing reaches the meeting yet.
  await choose("#outSelect", ids.cableIn, /^(?!Switching where your voice goes)/);
  check(
    (await status()) === `Switched where your voice goes.${VOICE_TEXTS.notReaching}` && (await statusKind()) === "warn",
    "(c) an output picked while nothing can be sent: switched, and the voice is not reaching the meeting yet",
    `${await statusKind()}: ${await status()}`,
  );

  // (e) the user fixed it: Check the microphone tries again (no second permission fix on this page)
  await setFlags({});
  await fake(() => {
    window.__fake.refuseContextSink = false;
    window.__fake.refuseElementSink = false;
  });
  await press("btnMic", /Microphone checked/);
  r = await waitResults((x) => x.voice?.state === "running", 5000);
  check(r.voice?.state === "running" && (await permissionCalls()) === 1, "(e) Check the microphone starts the voice again, without a second permission fix", `${r.voice?.state}`);
  check(r.voice?.output?.how === "saved-id", "(e) on the output picked in (c)", r.voice?.output?.how);
  await choose("#outSelect", "", /^(?!Switching where your voice goes)/);
  r = await waitResults((x) => x.voice?.state === "running" && x.voice?.output?.how === "auto", 5000);
  check(
    (await status()) === "Switched where your voice goes." && (await statusKind()) === "ok" && r.voice?.output?.how === "auto",
    "(e) back to Automatic while the voice runs: switched",
    `${await statusKind()}: ${await status()}`,
  );

  // (d) both refused, the permission fix fails
  await setFlags({ refuseContextSink: true, refuseElementSink: true, permissionFails: true });
  await reload();
  r = await waitResults((x) => x.voice?.state === "sink-refused", 8000);
  const last = (r.voice?.output?.tried ?? []).at(-1);
  check(
    r.voice?.state === "sink-refused" && same(methods(r), ["context", "element", "permission"]) && last?.ok === false && Boolean(last?.note),
    "(d) the permission fix failed: the results say so",
    json(r.voice?.output?.tried ?? r.voice?.state),
  );
  await setFlags({});
}

// ---- 16 · relaunch and Remove key ----

async function relaunch(app) {
  const { page, reload, text, results, status, press, waitResults } = app;
  const removeOff = () => page.locator("#btnDeleteKey").isDisabled();
  await reload();
  let r = await results();
  check(/ending in WXYZ/.test(await text("#keyInfo")) && !(await removeOff()), "after a relaunch the saved key is found, and Remove key is on", await text("#keyInfo"));
  check(r.sanas === null && r.app.build === BUILD && r.checks.delay.length === 0, "the results start over (so the session copies them before closing)", json(r).slice(0, 300));
  r = await waitResults((x) => x.voice?.state === "running", 5000);
  check(r.voice?.state === "running", "the voice runs again after the relaunch", r.voice?.state);
  await press("btnConnect", CONNECTED_OR_NOT);
  check((await results()).sanas?.ok === true, "Connect only works with the key read back after the relaunch", await text("#connectInfo"));

  // Remove key. The relaunch started the results over, so save the key again
  // first: then there is a check (checked, note) for Remove key to drop.
  await page.fill("#key", KEYS.good);
  await press("btnSaveKey", /^(?!Checking the key)/);
  r = await results();
  check(r.key?.saved === true && r.key.checked === "accepted", "the key is saved again before Remove key", json(r.key));
  await press("btnDeleteKey", /removed/);
  r = await results();
  check(/removed/.test(await status()) && /No key saved yet/.test(await text("#keyInfo")), "Remove key removes the key", await status());
  check(await removeOff(), "and Remove key ends off: nothing is left to remove");
  check(r.key.saved === false && !("checked" in r.key), "the results drop the removed key's check", json(r.key));
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true }); // never wiped here: run.cjs wipes out/ when it starts
  const { synthSpeech, addNoise } = await load("tests/helpers/synth.js");
  const { encodeWav } = await load("src/core/wav.js");
  const { WARNINGS } = await load("src/core/device-choice.js");
  const { CHECK_TEXTS } = await load("src/audio/measure.js");
  const { VOICE_TEXTS } = await load("src/ui/voice.js");
  const { startSpikeServer } = await load("spike/serve.mjs");

  // Fake microphone: ~10 s of speech-like audio (Chromium loops the file) with −70 dBFS noise, so its pauses
  // are not digital silence (a cut inside one must still show, and sampleLag needs non-zero samples).
  const speech = synthSpeech({ seconds: 10, seed: 7, leadSec: 0.4, tailSec: 0.6 });
  const wavPath = path.join(OUT, "app-mic.wav");
  fs.writeFileSync(wavPath, encodeWav([addNoise(speech.samples, -70)], 48000));

  const server = await startSpikeServer({ port: 0, getApiKey: () => "" });
  const base = `http://localhost:${server.port}`;
  const args = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wavPath}`];
  const browser = await chromium.launch({ args: [...args, "--autoplay-policy=no-user-gesture-required"] });
  const noAutoplay = await chromium.launch({ args });
  const t0 = Date.now();
  const only = new Set((process.env.ONLY || "dev,gesture,app").split(",").map((x) => x.trim()));
  try {
    if (only.has("dev")) await devMode(browser, base, CHECK_TEXTS, VOICE_TEXTS);
    if (only.has("gesture")) await gesture(noAutoplay, base, BUILD);
    if (only.has("app")) await appMode(browser, base, WARNINGS, VOICE_TEXTS);
  } finally {
    await browser.close();
    await noAutoplay.close();
    await server.close();
  }
  console.log(`\n${Math.round((Date.now() - t0) / 1000)} s`);
  console.log(failed ? `${failed} check(s) failed` : "all checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
