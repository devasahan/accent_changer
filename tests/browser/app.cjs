// Headless check of the app's page in Edge dev mode (npm run test:app): the
// same src/ the installed app shows, served by the spike server under the
// app's CSP, in Chromium with a fake microphone. Covers the Diagnostics page:
// app info, the microphone check, the key section (held by the dev server)
// and "Connect only" failing clearly without a key. The Tauri side (key in
// Windows Credential Manager, the real origin) is tested on the laptop (A2).
// PLAYWRIGHT=<path to playwright> overrides where Playwright is loaded from.
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..", "..");
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

let failed = 0;
function check(ok, what, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${!ok && detail ? `\n     ${String(detail).replace(/\n/g, "\n     ")}` : ""}`);
  if (!ok) failed += 1;
}

async function main() {
  const { startSpikeServer, APP_CSP } = await load("spike/serve.mjs");
  const server = await startSpikeServer({ port: 0, getApiKey: () => "" });
  const base = `http://localhost:${server.port}`;
  const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const context = await browser.newContext();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  const page = await context.newPage();
  const problems = [];
  let expectErrors = false;
  page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    const text = msg.text();
    if (/Content Security Policy|Refused to/i.test(text)) problems.push(`CSP: ${text}`);
    else if (msg.type() === "error" && !expectErrors) problems.push(`console.error: ${text}`);
  });
  const status = () => page.locator("#status").textContent();
  const statusKind = () => page.locator("#status").getAttribute("data-kind");
  const results = async () => JSON.parse(await page.locator("#results").textContent());

  try {
    const res = await page.goto(`${base}/src/`);
    check(res.headers()["content-security-policy"] === APP_CSP, "the dev server serves the app page under the app's CSP", res.headers()["content-security-policy"]);
    await page.waitForFunction(() => /Ready/.test(document.querySelector("#status").textContent), null, { timeout: 10000 });
    check(true, "the page loads and says Ready");
    const info = await page.locator("#appInfo").textContent();
    const flat = info.replace(/\s+/g, "");
    check(/Edgedevmode/.test(flat) && /Securepageyes/.test(flat), "step 1 shows the shell and a secure page", info);
    check(/Rustsidenotin/.test(flat), "and doesn't claim a Rust side in dev mode", info);

    // 2 · microphone
    await page.dblclick("#btnMic");
    await page.waitForFunction(() => /Microphone checked/.test(document.querySelector("#status").textContent), null, { timeout: 10000 });
    const mic = (await results()).microphone;
    check(mic.ok && mic.microphones.length >= 1 && mic.outputs.length >= 1, "the microphone opens and devices are listed", JSON.stringify(mic));
    check(mic.echoCancellation === false && mic.noiseSuppression === false && mic.autoGainControl === false, "echo cancellation, noise suppression and auto gain are off", JSON.stringify(mic));
    check(mic.cableInputFound === false && /not installed yet/.test(await page.locator("#micInfo").textContent()), "VB-CABLE is reported as not installed");

    // 3 · key: in dev mode the server holds it
    check(/No key saved yet/.test(await page.locator("#keyInfo").textContent()), "no key yet");
    check(await page.locator("#btnDeleteKey").isDisabled(), "Remove key is off when there is nothing to remove");
    expectErrors = true;
    await page.fill("#key", "sk_test_should_not_stay_1234567890");
    await page.click("#btnSaveKey");
    await page.waitForFunction(() => document.querySelector("#status").dataset.kind === "error", null, { timeout: 5000 });
    check(/server window/.test(await status()), "saving a key in dev mode says where the key goes", await status());
    check((await page.locator("#key").inputValue()) === "", "the pasted key is cleared from the box at once");

    // 4 · connect only without a key: a clear error that doesn't blame the key
    await page.click("#btnConnect");
    await page.waitForFunction(() => document.querySelector("#connectInfo").dataset.kind === "error", null, { timeout: 40000 });
    const err = await page.locator("#connectInfo").textContent();
    check(/No Sanas API key loaded/.test(err), "Connect only without a key explains what is missing", err);
    check(!/refused/.test(err), "and does not send you to the Sanas Console", err);
    check((await statusKind()) === "error" && (await results()).sanas.ok === false, "the failure is recorded");
    expectErrors = false;

    // 5 · copy
    await page.click("#btnCopy");
    await page.waitForFunction(() => /Copied|select the text/.test(document.querySelector("#copyInfo").textContent), null, { timeout: 5000 });
    const copied = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
    const text = copied || (await page.locator("#results").textContent());
    const parsed = JSON.parse(text);
    check(parsed.tool === "accent-changer diagnostics" && parsed.shell === "browser" && parsed.microphone.ok, "Copy results gives the summary", text.slice(0, 200));
    check(!/sk_test|access_token|deviceId/.test(text), "the summary holds no key, token or device ids");
  } catch (err) {
    check(false, "scenario finished", err.stack || err.message);
    console.log(`     status: ${await status().catch(() => "?")}`);
  } finally {
    check(problems.length === 0, "no page errors or CSP violations", problems.join("\n"));
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
