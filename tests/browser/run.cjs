// End-to-end check of the Step 0 probe page (npm run test:browser): starts
// the spike server, opens the page in headless Chromium with a fake
// microphone that plays synthetic speech, and drives every step with the
// Mock engine (no Sanas account or network needed). The Mock behaves like
// the Sanas SDK where the page depends on it: a dropped call is reported as
// "disconnected" and stops the session's input track. Also checks that the
// Sanas engine fails clearly when no key is loaded.
// PLAYWRIGHT=<path to playwright> overrides where Playwright is loaded from.
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..", "..");
const OUT = path.join(__dirname, "out");
const MOCK_DELAY_MS = 300;

let failed = 0;
function check(ok, what, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${!ok && detail ? `\n     ${String(detail).replace(/\n/g, "\n     ")}` : ""}`);
  if (!ok) failed += 1;
}

const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const { synthSpeech } = await load("tests/helpers/synth.js");
  const { encodeWav, decodeWav } = await load("src/core/wav.js");
  const { startSpikeServer } = await load("spike/serve.mjs");

  // Fake microphone: ~10 s of speech-like audio (Chromium loops the file).
  const speech = synthSpeech({ seconds: 10, seed: 5, leadSec: 0.4, tailSec: 0.6 });
  const wavPath = path.join(OUT, "fake-mic.wav");
  fs.writeFileSync(wavPath, encodeWav([speech.samples], 48000));

  const server = await startSpikeServer({ port: 0, getApiKey: () => "" });
  const base = `http://localhost:${server.port}`;
  const browser = await chromium.launch({
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${wavPath}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const context = await browser.newContext({ acceptDownloads: true });
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
  const spike = (expr, arg) => page.evaluate(expr, arg);
  const mode = () => spike(() => window.__spike.state.mode);
  const openSessions = () => spike(() => window.__spike.openSessions());
  const waitRuns = (n, timeout) => page.waitForFunction((k) => window.__spike.state.runs.length >= k, n, { timeout });
  const waitIdle = (timeout) => page.waitForFunction(() => window.__spike.state.mode === "idle", null, { timeout });
  const lastRun = () => spike(() => window.__spike.state.runs.at(-1));

  try {
    await page.goto(`${base}/spike/`);
    await page.waitForFunction(() => /Ready/.test(document.querySelector("#status").textContent), null, { timeout: 10000 });
    check(true, "page loads and says Ready");

    await page.selectOption("#engine", "mock");
    await page.fill("#mockDelay", String(MOCK_DELAY_MS));
    check(await page.locator("#mockDelay").isVisible(), "mock settings appear for the Mock engine");
    check(await page.locator("#btnConnect").isDisabled(), "Connect is only for Sanas");

    await page.click("#btnMic");
    await page.waitForFunction(() => /Microphone allowed/.test(document.querySelector("#status").textContent), null, { timeout: 10000 });
    const mics = await page.locator("#mic option").count();
    check(mics >= 1, "microphones are listed after allowing", `options: ${mics}`);

    // 2 · record ~9 s of the fake microphone (a double click must not start two recordings)
    await page.dblclick("#btnRecord");
    await page.waitForFunction(() => window.__spike.state.mode === "recording", null, { timeout: 10000 });
    check(await page.locator("#engine").isDisabled(), "settings are locked while something runs");
    await page.waitForTimeout(9000);
    await page.click("#btnStopRecord");
    await page.waitForFunction(() => window.__spike.state.recording && window.__spike.state.mode === "idle", null, { timeout: 10000 });
    const recSec = await spike(() => window.__spike.state.recording.length / 48000);
    check(recSec > 8 && recSec < 11, "recording is about 9 s", `${recSec} s`);
    const recInfo = await page.locator("#recInfo").textContent();
    await page.waitForTimeout(1500);
    check(/recorded/i.test(recInfo) && (await page.locator("#recInfo").textContent()) === recInfo, "double click on Record left no second recording running", recInfo);

    // 3 · run through the mock engine
    await page.click("#btnRun");
    await waitRuns(1, 40000);
    await waitIdle(10000);
    const run = await spike(() => window.__spike.state.runs[0]);
    check(run.ok, "run 1 analysed", run.reason);
    check(run.delayMs >= MOCK_DELAY_MS && run.delayMs < MOCK_DELAY_MS + 120, `delay is the mock's ${MOCK_DELAY_MS} ms plus a little`, `${run.delayMs} ms`);
    check(run.gapCount === 0, "no gaps through the mock", JSON.stringify(run.gaps));
    check(run.utterances.length >= 3, "utterances found", `${run.utterances.length}`);
    check(Math.abs(run.delayP95Ms - run.delayMedianMs) < 25, "per-utterance delay is steady", `${run.delayMedianMs} / ${run.delayP95Ms}`);
    check(run.settings.engine === "mock" && run.settings.mockDelayMs === MOCK_DELAY_MS, "the run keeps the settings it used");
    check((await page.locator("#runs tbody tr").count()) === 1, "results table has the run");
    check((await page.locator("#utts li").count()) === run.utterances.length, "one rating row per utterance");
    check((await openSessions()) === 0, "the run's session is closed afterwards");

    // 4 · rate and play
    await page.locator("#utts li").first().locator("input[type=checkbox]").evaluateAll((boxes) => boxes.forEach((b) => b.click()));
    const score = Number(await page.locator("#score").textContent());
    check(score > 0, "ticking all three boxes on a line raises the score", `${score}`);
    const stored = await spike(() => window.__spike.state.runs[0].rating);
    check(stored.score10 === score && stored.perUtterance[0].natural, "the rating is stored with run 1", JSON.stringify(stored).slice(0, 200));
    check(/Rating run 1/.test(await page.locator("#rateFor").textContent()), "the page says which run is being rated");
    await page.click("#btnPlayConv");
    check(await spike(() => Boolean(window.__spike.state.playing)), "converted audio plays");
    await page.click("#btnStopPlay");
    check(await spike(() => !window.__spike.state.playing), "stop ends playback");

    // 5 · live through the mock; a double click must open one session only
    await page.dblclick("#btnLive");
    await page.waitForFunction(() => window.__spike.state.mode === "live", null, { timeout: 10000 });
    await page.waitForTimeout(300);
    check((await openSessions()) === 1, "double click on Start live opened one session", `${await openSessions()} open`);
    await page.waitForFunction(() => /delay \d+ ms/.test(document.querySelector("#liveInfo").textContent), null, { timeout: 20000 });
    const liveText = await page.locator("#liveInfo").textContent();
    await page.click("#btnStopLive");
    await waitIdle(10000);
    const live = await lastRun();
    check(live.kind === "live" && live.ok, "live run recorded", liveText);
    check(live.delayMs >= MOCK_DELAY_MS && live.delayMs < MOCK_DELAY_MS + 150, "live delay measured from the microphone", `${live.delayMs} ms`);
    check((await openSessions()) === 0, "Stop closed the live session");

    // 5b · Stop while live is still connecting: nothing may stay open
    await page.fill("#mockConnect", "3000");
    await page.click("#btnLive");
    await page.waitForTimeout(700);
    check(await page.locator("#btnStopLive").isEnabled(), "Stop is available while live is connecting");
    await page.click("#btnStopLive");
    await waitIdle(5000);
    await page.waitForTimeout(3500);
    check(
      (await openSessions()) === 0 && (await spike(() => window.__spike.state.live === null)) && (await mode()) === "idle",
      "Stop during start-up cancels the start (no session left running)",
      `${await openSessions()} open, mode ${await mode()}, status: ${await status()}`,
    );
    check(/cancelled/i.test(await status()), "the page says the live start was cancelled", await status());
    await page.fill("#mockConnect", "0");

    // 3b · a call that drops during a script run is reported as a drop
    const runsBefore = await spike(() => window.__spike.state.runs.length);
    await page.fill("#mockFail", "3");
    await page.click("#btnRun");
    await waitRuns(runsBefore + 1, 40000);
    await waitIdle(10000);
    const dropped = await lastRun();
    check(dropped.dropped === "Media connection lost", "a drop during a run is recorded with the run", JSON.stringify(dropped.dropped));
    check(
      /dropped the call/i.test(await status()) && (await page.locator("#status").getAttribute("data-kind")) === "error",
      "and shown as an error",
      await status(),
    );

    // 6 · long run with a simulated drop every 15 s: every drop reconnects, and the new sessions carry audio
    await page.fill("#mockFail", "15");
    await page.fill("#longMinutes", "1");
    await page.click("#btnLong");
    await page.waitForFunction(() => window.__spike.state.runs.at(-1)?.kind === "long", null, { timeout: 150000 });
    await waitIdle(10000);
    const long = await lastRun();
    check(long.loops >= 3, "long run loops the recording", `${long.loops} loops`);
    check(long.failures.length >= 1, "a dropped session is detected", JSON.stringify(long.failures));
    const retried = long.failures.filter((f) => !f.notRetried);
    check(
      retried.length >= 1 && retried.every((f) => Number.isFinite(f.reconnectMs) && f.reconnectMs < 3000),
      "and reconnected quickly",
      JSON.stringify(long.failures),
    );
    check(long.loopsWithoutAudio === 0, "every loop after a reconnect got converted audio back", JSON.stringify(long.perLoop.map((l) => l.reason)));
    check(
      long.loopsCutShortByDrop >= 1 && long.loopsCutShortByDrop <= long.failures.length,
      "every loop interrupted by a drop is counted as a drop",
      `${long.loopsCutShortByDrop} cut short, ${long.failures.length} drops`,
    );
    check(long.perLoop.length === long.loops && Number.isFinite(long.delayMaxMs), "per-loop numbers and the delay maximum are kept");
    check((await openSessions()) === 0, "the long run closed its sessions");
    await page.fill("#mockFail", "");

    // 6b · Stop in the middle of a loop: the output is still collected, so no phantom gap
    await page.click("#btnLong");
    await page.waitForTimeout(4500);
    await page.click("#btnStopLong");
    await page.waitForFunction(() => window.__spike.state.runs.at(-1)?.kind === "long" && window.__spike.state.mode === "idle", null, {
      timeout: 30000,
    });
    const stopped = await lastRun();
    check(
      stopped.loops === 1 && stopped.perLoop[0].stoppedEarly && stopped.gapCount === 0 && stopped.loopsWithoutAudio === 0,
      "Stop mid-loop ends the run without a phantom gap",
      JSON.stringify({ loops: stopped.loops, gaps: stopped.gapCount, perLoop: stopped.perLoop }),
    );

    // 7 · device pair: the same fake microphone twice
    const firstMic = await page.locator("#mic").inputValue();
    await page.selectOption("#pairDevice", firstMic);
    await page.click("#btnPair");
    await waitIdle(30000);
    const pair = await spike(() => window.__spike.state.pair);
    check(pair && pair.ok && Math.abs(pair.delayMs) < 60, "device pair measures two inputs", JSON.stringify(pair));

    // 8 · downloads
    const [jsonDl] = await Promise.all([page.waitForEvent("download"), page.click("#btnSaveJson")]);
    const jsonPath = path.join(OUT, await jsonDl.suggestedFilename());
    await jsonDl.saveAs(jsonPath);
    const text = fs.readFileSync(jsonPath, "utf8");
    const results = JSON.parse(text);
    const runCount = await spike(() => window.__spike.state.runs.length);
    check(results.schema === 2 && results.runs.length === runCount && runCount >= 5, "results JSON has every run", `${results.runs.length} of ${runCount}`);
    check(results.runs[0].rating?.perUtterance.length === results.runs[0].utterances.length, "each script run carries its own rating");
    check(
      results.script === "default" && /\d/.test(results.browser) && !/Mozilla/.test(results.browser),
      "script and browser are summarised",
      `${results.script} · ${results.browser}`,
    );
    check(!/"ref"|"sig"|Float32Array/.test(text), "results JSON holds no audio");
    check(fs.statSync(jsonPath).size < 300000, "results JSON is small", `${fs.statSync(jsonPath).size} bytes`);
    const [wavDl] = await Promise.all([page.waitForEvent("download"), page.click("#btnSaveWav")]);
    const wavOut = path.join(OUT, await wavDl.suggestedFilename());
    await wavDl.saveAs(wavOut);
    const wav = decodeWav(new Uint8Array(fs.readFileSync(wavOut)));
    check(wav.channels.length === 2 && wav.sampleRate === 48000, "WAV download: original left, converted right");

    // Sanas engine without a key: a clear error that does not blame the key, no crash
    expectErrors = true;
    await page.selectOption("#engine", "sanas");
    await page.click("#btnConnect");
    await page.waitForFunction(() => document.querySelector("#status").dataset.kind === "error", null, { timeout: 40000 });
    const err = await status();
    check(/No Sanas API key loaded/i.test(err), "Sanas without a key explains what is missing", err);
    check(!/refused the key/i.test(err), "and does not send you to the Sanas Console for it", err);
    expectErrors = false;
    await waitIdle(5000);
    check(await page.locator("#btnRun").isEnabled(), "page stays usable after the error");
  } catch (err) {
    check(false, "scenario finished", err.stack || err.message);
    await page.screenshot({ path: path.join(OUT, "failure.png"), fullPage: true }).catch(() => {});
    console.log(`     status: ${await status().catch(() => "?")}`);
    console.log(`     log:\n${(await page.locator("#log").textContent().catch(() => "")).split("\n").slice(-15).join("\n")}`);
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
