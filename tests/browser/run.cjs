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

  // A finished Sanas address check, as the server holds it after a key was accepted.
  const originCheck = {
    ran: true,
    at: "2026-11-26T10:00:00.000Z",
    pageOrigin: "http://localhost:8080",
    results: [],
    appReady: true,
    conclusion: "Good: the app can load its page from http://tauri.localhost.",
    lines: [],
  };
  const server = await startSpikeServer({ port: 0, getApiKey: () => "", getOriginCheck: () => originCheck });
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
  // "Fake Audio Input 2" plays as another app's microphone would: 250 ms late.
  // Every microphone gets a volume the test can turn down: silence (you stop
  // talking, and the "app" falls silent 250 ms later).
  // window.__noise(sec) plays a short noise into "Fake Audio Input 1" only (a cough or a
  // knock on the headset that the other app leaves out). window.__group, when set, is
  // the groupId every microphone reports (one physical device behind two names).
  await context.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.__micGains = [];
    window.__noiseInto = [];
    window.__noise = (sec = 0.5, amp = 0.3) => {
      for (const { ctx, out } of window.__noiseInto) {
        if (ctx.state === "closed") continue;
        const n = Math.round(sec * ctx.sampleRate);
        const buffer = ctx.createBuffer(1, n, ctx.sampleRate);
        const d = buffer.getChannelData(0);
        for (let i = 0; i < n; i++) d[i] = amp * (Math.random() * 2 - 1) * Math.sin((Math.PI * i) / n);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(out);
        src.start();
      }
    };
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await original(constraints);
      const id = constraints?.audio?.deviceId?.exact;
      const label = id ? (await navigator.mediaDevices.enumerateDevices()).find((d) => d.deviceId === id)?.label ?? "" : "";
      const ctx = new AudioContext({ sampleRate: 48000 });
      const source = ctx.createMediaStreamSource(stream);
      const out = ctx.createMediaStreamDestination();
      const gain = ctx.createGain();
      window.__micGains.push({ label, gain });
      if (/Fake Audio Input 2/.test(label)) {
        const delay = ctx.createDelay(1);
        delay.delayTime.value = 0.25;
        source.connect(gain).connect(delay).connect(out);
      } else {
        source.connect(gain).connect(out);
        if (/Fake Audio Input 1/.test(label)) window.__noiseInto.push({ ctx, out });
      }
      const track = out.stream.getAudioTracks()[0];
      const settings = track.getSettings.bind(track);
      track.getSettings = () => ({ ...settings(), ...(window.__group ? { groupId: window.__group } : {}) });
      const stop = track.stop.bind(track);
      track.stop = () => {
        stop();
        stream.getTracks().forEach((t) => t.stop());
        ctx.close().catch(() => {});
      };
      return out.stream;
    };
  });
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
  const micVolume = (v, only = "") =>
    spike(([x, which]) => window.__micGains.filter((m) => m.label.includes(which)).forEach((m) => (m.gain.gain.value = x)), [v, only]);

  try {
    await page.goto(`${base}/spike/`);
    await page.waitForFunction(() => /Ready/.test(document.querySelector("#status").textContent), null, { timeout: 10000 });
    check(true, "page loads and says Ready");
    await page.waitForFunction(() => /app can load/.test(document.querySelector("#originInfo").textContent), null, { timeout: 5000 });
    check(true, "the page shows the server's Sanas address check");
    check((await page.locator("#longMinutes").getAttribute("max")) === "90", "the long run allows 90 minutes");
    check(await page.locator("#blindWords").isDisabled(), "the blind-listener boxes stay closed while there is no run to rate");
    check(
      (await page.locator("#btnRun").isDisabled()) && /Record the script first/.test(await page.locator("#runInfo").textContent()),
      "Run says it needs a recording first",
    );

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

    // 1b · headphones remembered from an earlier sitting are plugged in after the page opened:
    // once step 1 shows them, the sound plays there too
    const sinkFollows = await spike(async () => {
      const s = window.__spike.state;
      const out = document.querySelector("#out");
      const headphones = [...out.options].map((o) => o.value).find(Boolean);
      if (!headphones || typeof s.ctx?.setSinkId !== "function") return { skipped: true };
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const calls = [];
      const setSink = s.ctx.setSinkId.bind(s.ctx);
      s.ctx.setSinkId = (id) => {
        calls.push(id);
        return setSink(id).catch(() => {});
      };
      const md = navigator.mediaDevices;
      const enumerate = md.enumerateDevices.bind(md);
      out.value = "";
      out.dispatchEvent(new Event("change"));
      localStorage.setItem("accentChanger.out", headphones);
      md.enumerateDevices = async () => (await enumerate()).filter((d) => d.deviceId !== headphones);
      md.dispatchEvent(new Event("devicechange"));
      await wait(300);
      const before = out.value;
      md.enumerateDevices = enumerate;
      md.dispatchEvent(new Event("devicechange"));
      await wait(300);
      const after = out.value;
      out.value = "";
      out.dispatchEvent(new Event("change"));
      localStorage.removeItem("accentChanger.out");
      await wait(100);
      s.ctx.setSinkId = setSink;
      return { before, after, headphones, calls };
    });
    check(
      !sinkFollows.skipped && sinkFollows.before === "" && sinkFollows.after === sinkFollows.headphones && sinkFollows.calls.includes(sinkFollows.headphones),
      "headphones that appear later are used, not only shown",
      JSON.stringify(sinkFollows),
    );

    // 4 · rate and play
    check((await page.locator("#score").textContent()) === "–" && (await lastRun()).rating.score10 === null, "a run nobody rated is unrated, not 0/10");
    check((await page.locator("#utts li").first().locator("input[type=checkbox]").count()) === 4, "each line has four boxes, “sounds American” included");
    check((await page.locator("#runInfo").textContent()) !== "" && !/Record the script first/.test(await page.locator("#runInfo").textContent()), "the hint goes once there is a recording");
    const boxes = page.locator("#utts li").first().locator("input[type=checkbox]");
    await boxes.first().click();
    check((await page.locator("#score").textContent()) === "0.0", "one box alone doesn't count the line");
    await boxes.evaluateAll((all) => all.slice(1, 3).forEach((b) => b.click()));
    check((await page.locator("#score").textContent()) === "0.0", "natural, your voice and every word right without “sounds American” don't count the line either");
    await boxes.nth(3).click();
    const score = Number(await page.locator("#score").textContent());
    check(score > 0, "ticking all four boxes on a line raises the score", `${score}`);
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
    check(
      live.speechAtSec.length > 0 && live.heardAtSec.length > 0 && Number.isFinite(live.silenceLongestSec) && live.silenceLongestSec < 10,
      "the live run keeps both timelines for the quiet test",
      JSON.stringify({ speech: live.speechAtSec, heard: live.heardAtSec, silence: live.silenceLongestSec }),
    );
    check(live.delayMs >= MOCK_DELAY_MS && live.delayMs < MOCK_DELAY_MS + 150, "live delay measured from the microphone", `${live.delayMs} ms`);
    check((await openSessions()) === 0, "Stop closed the live session");

    // 5a · the quiet test: talk, 14 s of silence, then speech. The converted voice comes back...
    const quietCall = async ({ engineGoesQuiet }) => {
      await page.click("#btnLive");
      await page.waitForFunction(() => window.__spike.state.mode === "live", null, { timeout: 10000 });
      await page.waitForTimeout(7000);
      await micVolume(0);
      await page.waitForTimeout(14000);
      if (engineGoesQuiet) await spike(() => (window.__spike.state.live.handle.fromEngine.mediaStream.getAudioTracks()[0].enabled = false));
      await micVolume(1);
      await page.waitForTimeout(10000);
      await page.click("#btnStopLive");
      await waitIdle(10000);
      return lastRun();
    };
    const back = await quietCall({ engineGoesQuiet: false });
    check(
      back.silenceLongestSec >= 12 && back.silenceLongestSec <= 20 && back.convertedBackAfterSec !== null && back.convertedBackAfterSec <= 6,
      "quiet test: the converted voice comes back at once after a silence",
      JSON.stringify({ silence: back.silenceLongestSec, resumed: back.speechResumedAtSec, after: back.convertedBackAfterSec }),
    );
    check(/came back at once/.test(await status()), "and the page says so", await status());
    // ...or it doesn't: the call stays up but nothing is converted any more.
    const gone = await quietCall({ engineGoesQuiet: true });
    check(
      gone.silenceLongestSec >= 12 && gone.speechResumedAtSec !== null && gone.convertedBackAfterSec === null,
      "quiet test: speech after the silence with nothing converted is told apart from silence",
      JSON.stringify({ silence: gone.silenceLongestSec, resumed: gone.speechResumedAtSec, after: gone.convertedBackAfterSec }),
    );
    check(/did not come back/.test(await status()) && (await page.locator("#status").getAttribute("data-kind")) === "warn", "and the page warns", await status());
    // Nothing converted at all while you speak: not "no speech detected".
    await page.click("#btnLive");
    await page.waitForFunction(() => window.__spike.state.mode === "live", null, { timeout: 10000 });
    await spike(() => (window.__spike.state.live.handle.fromEngine.mediaStream.getAudioTracks()[0].enabled = false));
    await page.waitForTimeout(8000);
    await page.click("#btnStopLive");
    await waitIdle(10000);
    const mute = await lastRun();
    check(!mute.ok && mute.reason === "you spoke, but no converted speech came back", "a muted engine while you speak is reported as such", mute.reason);

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

    // 7 · quick check: the same fake microphone twice
    const firstMic = await page.locator("#mic").inputValue();
    await page.selectOption("#pairDevice", firstMic);
    await page.click("#btnPair");
    await waitIdle(30000);
    const pair = await spike(() => window.__spike.state.pairs.at(-1));
    check(pair && pair.ok && Math.abs(pair.delayMs) < 60, "quick check measures two inputs", JSON.stringify(pair));

    // 7b · read the script with "another app's" microphone: needs a different device
    const runsBeforeRead = await spike(() => window.__spike.state.runs.length);
    expectErrors = true;
    await page.click("#btnRead");
    await waitIdle(5000);
    check(/same as yours/.test(await status()), "Read the script refuses your own microphone as the other one", await status());
    const inputs = await page.locator("#mic option").evaluateAll((os) => os.map((o) => ({ value: o.value, label: o.textContent })));
    const one = inputs.find((o) => /Fake Audio Input 1/.test(o.label));
    const two = inputs.find((o) => /Fake Audio Input 2/.test(o.label));
    await page.selectOption("#mic", one.value);
    await page.selectOption("#pairDevice", two.value);
    // Windows lists the default device twice: "Default - Headset" and "Headset".
    const realName = await page.locator("#pairDevice option:checked").textContent();
    await page.locator("#pairDevice option:checked").evaluate((o, name) => (o.textContent = `Default - ${name}`), one.label);
    await page.click("#btnRead");
    await waitIdle(5000);
    check(/same as yours/.test(await status()), "it also refuses your microphone under its “Default - …” name", await status());
    await page.locator("#pairDevice option:checked").evaluate((o, name) => (o.textContent = name), realName);
    // Two names, one physical device: the same groupId.
    await spike(() => (window.__group = "one-headset"));
    await page.click("#btnRead");
    await waitIdle(5000);
    check(/same as yours/.test(await status()) && (await spike(() => window.__spike.state.runs.length)) === runsBeforeRead, "and two names for one device (same group)", await status());
    await spike(() => (window.__group = ""));
    expectErrors = false;
    await page.dblclick("#btnRead");
    await page.waitForFunction(() => window.__spike.state.mode === "read", null, { timeout: 10000 });
    check(await page.locator("#btnStopRead").isEnabled(), "Stop is available while reading");
    let readLevel = -60;
    let otherLevel = -60;
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(300);
      readLevel = Math.max(readLevel, await page.locator("#readLevelA").evaluate((m) => m.value));
      otherLevel = Math.max(otherLevel, await page.locator("#readLevelB").evaluate((m) => m.value));
    }
    // Like a person: stop talking, then press Stop. The page keeps listening for the app's last words.
    await micVolume(0);
    await page.waitForTimeout(400);
    await page.click("#btnStopRead");
    await waitIdle(15000);
    await micVolume(1);
    const read = await lastRun();
    check((await spike(() => window.__spike.state.runs.length)) === runsBeforeRead + 1, "a double click on Read the script made one run");
    check(read.kind === "read" && read.ok && read.engine === two.label, "the read-aloud run is analysed like a Sanas run", JSON.stringify({ kind: read.kind, ok: read.ok, reason: read.reason, engine: read.engine }));
    check(Math.abs(read.delayMs - 250) < 60 && read.utterances.length >= 3, "it measures the other app's 250 ms delay, the right way round", `${read.delayMs} ms, ${read.utterances.length} lines`);
    check(read.gapCount === 0 && read.durationSec >= 12, "and no gap at the end: Stop waits 3 s for the app's last words", JSON.stringify({ gaps: read.gaps, sec: read.durationSec }));
    check(readLevel > -60 && otherLevel > -60, "both level meters move while reading (you, and the other app)", `${readLevel} / ${otherLevel}`);
    check(read.settings.engine === "device" && read.settings.device === two.label, "it keeps the device it measured");
    check(/read aloud/.test(await page.locator("#runs tbody tr").last().textContent()), "the table marks it as read aloud");
    check((await page.locator("#utts li").count()) === read.utterances.length, "its lines are ready to rate");
    check(/Rating run \d+ \(Fake Audio Input 2\)/.test(await page.locator("#rateFor").textContent()), "and the page says which run is rated");

    // 7b' · the other app stays silent (not running): a failed run with nothing to rate
    const runsBeforeSilent = await spike(() => window.__spike.state.runs.length);
    await page.click("#btnRead");
    await page.waitForFunction(() => window.__spike.state.mode === "read", null, { timeout: 10000 });
    await micVolume(0, "Fake Audio Input 2");
    await page.waitForTimeout(6000);
    await page.click("#btnStopRead");
    await waitIdle(15000);
    await micVolume(1);
    const silentApp = await lastRun();
    check(
      (await spike(() => window.__spike.state.runs.length)) === runsBeforeSilent + 1 && !silentApp.ok && /stayed silent/.test(silentApp.reason ?? ""),
      "an app that stays silent gives a failed run that says so",
      JSON.stringify({ ok: silentApp.ok, reason: silentApp.reason }),
    );
    check(
      /stayed silent/.test(await status()) && (await page.locator("#status").getAttribute("data-kind")) === "error" && (await page.locator("#blindWords").isDisabled()),
      "shown as an error, with the blind-listener boxes closed",
      await status(),
    );

    // 4b · switch back to run 1 and score its blind-listener test
    check(await page.locator("#rateRunLabel").isVisible(), "the run picker appears once two runs have audio");
    await page.selectOption("#rateRun", "1");
    check(/Rating run 1/.test(await page.locator("#rateFor").textContent()), "picking run 1 rates run 1 again");
    check((await page.locator("#utts li").first().locator("input[type=checkbox]").first().isChecked()), "run 1 kept its ticks");
    check(await page.locator("#blindWords").isEnabled(), "the blind-listener boxes are open for a run with lines");
    await page.fill("#blindWords", "4");
    await page.fill("#blindUs", "3");
    await page.fill("#blindVoice", "9");
    let blind = await spike(() => window.__spike.state.runs[0].rating.blind);
    check(
      blind && blind.lines === 5 && blind.allWordsRight === 4 && blind.soundsAmerican === 3 && blind.soundsLikeYou === null,
      "blind-listener counts are stored with run 1; a count above the lines played is not",
      JSON.stringify(blind),
    );
    check(/from 0 to the number of lines played/.test(await page.locator("#blindInfo").textContent()), "and the page says why, instead of changing it");
    await page.fill("#blindVoice", "5");
    blind = await spike(() => window.__spike.state.runs[0].rating.blind);
    check(blind.soundsLikeYou === 5 && /Saved with run 1/.test(await page.locator("#blindInfo").textContent()), "a corrected count is saved");
    await page.selectOption("#rateRun", String(runsBeforeRead + 1));
    check((await page.locator("#blindWords").inputValue()) === "", "the read-aloud run has its own blind-listener counts");

    // 7c · long check of another app's microphone (the interview rehearsal)
    await page.click("#btnWatch");
    await page.waitForFunction(() => window.__spike.state.mode === "watch", null, { timeout: 10000 });
    check((await page.locator("#btnRun").isDisabled()) && (await page.locator("#btnStopWatch").isEnabled()), "the long check holds the page until Stop");
    await page.waitForTimeout(10000);
    await page.click("#btnStopWatch");
    await waitIdle(10000);
    const watch = await lastRun();
    check(
      watch.kind === "watch" && watch.ok && Math.abs(watch.delayMedianMs - 250) < 60 && watch.speechAtSec.length > 0,
      "the long check follows the other app's delay",
      JSON.stringify({ kind: watch.kind, ok: watch.ok, delay: watch.delayMedianMs, reason: watch.reason }),
    );
    check(/long check/.test(await page.locator("#runs tbody tr").last().textContent()), "the table marks it as a long check");

    // 7d · its quiet test: you knock the headset 9 s before you talk again; the app leaves the knock out
    await page.click("#btnWatch");
    await page.waitForFunction(() => window.__spike.state.mode === "watch", null, { timeout: 10000 });
    await page.waitForTimeout(7000);
    await micVolume(0);
    await page.waitForTimeout(13000);
    await spike(() => window.__noise(0.5));
    await page.waitForTimeout(9000);
    await micVolume(1);
    await page.waitForTimeout(10000);
    await page.click("#btnStopWatch");
    await waitIdle(10000);
    const knock = await lastRun();
    check(
      knock.silenceLongestSec >= 15 && knock.convertedBackAfterSec !== null && knock.convertedBackAfterSec <= 6,
      "a knock on the headset before you talk again doesn't make the app look late",
      JSON.stringify({ silence: knock.silenceLongestSec, resumed: knock.speechResumedAtSec, after: knock.convertedBackAfterSec, speech: knock.speechAtSec, sound: knock.speechSoundSec, heard: knock.heardAtSec }),
    );
    check(/came back at once/.test(await status()), "and the page says it came back at once", await status());

    // 4c · only the newest runs keep their sound: runs with nothing to rate go first
    const kept = await spike(() => {
      const s = window.__spike.state;
      const before = s.keepAudioRuns;
      const saved = new Map(s.audio);
      const lastBefore = s.last;
      s.keepAudioRuns = 2;
      s.audio.clear();
      const fake = (number, ok) => ({
        number,
        analysis: { ok, utterances: [], delayMs: 0 },
        run: { engine: "x", kind: "script", settings: { engine: "mock" }, rating: { rated: false, perUtterance: [], blind: null }, reason: ok ? null : "x" },
      });
      s.audio.set(1, fake(1, true));
      s.audio.set(2, fake(2, false));
      const quiet = window.__spike.keepAudio(fake(3, true));
      const afterFailed = [...s.audio.keys()];
      const warned = window.__spike.keepAudio(fake(4, true));
      const afterGood = [...s.audio.keys()];
      s.keepAudioRuns = before;
      s.audio.clear();
      saved.forEach((v, k) => s.audio.set(k, v));
      s.last = lastBefore;
      window.__spike.refreshRating();
      return { afterFailed, afterGood, quiet, warned };
    });
    check(
      kept.afterFailed.join() === "1,3" && kept.quiet === "" && kept.afterGood.join() === "3,4" && /Run 1's sound was let go/.test(kept.warned),
      "a run with nothing to rate goes before a good one, and losing a good one is said in the status",
      JSON.stringify(kept),
    );
    await page.selectOption("#rateRun", "1");

    // 8a · a server that stopped answering must not block saving the results
    await page.route("**/origin-check", () => {});
    const hung = page.waitForEvent("download", { timeout: 5000 }).then(() => true, () => false);
    await page.click("#btnSaveJson");
    check(await hung, "the results still download when the server doesn't answer");
    await page.unroute("**/origin-check");

    // 8 · downloads
    const [jsonDl] = await Promise.all([page.waitForEvent("download"), page.click("#btnSaveJson")]);
    const jsonPath = path.join(OUT, await jsonDl.suggestedFilename());
    await jsonDl.saveAs(jsonPath);
    const text = fs.readFileSync(jsonPath, "utf8");
    const results = JSON.parse(text);
    const runCount = await spike(() => window.__spike.state.runs.length);
    check(results.schema === 3 && results.runs.length === runCount && runCount >= 10, "results JSON has every run", `${results.runs.length} of ${runCount}`);
    check(results.originCheck?.appReady === true && Array.isArray(results.pairs) && results.pairs.length === 1, "it holds the address check and the quick check");
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

    // Part 2 opens the page again days later: your script and settings come back
    await page.fill("#script", "My own first line.\nMy own second line.");
    await page.fill("#model", "AT5.2_Feminine");
    await page.selectOption("#rate", "48000");
    const leave = new Promise((resolve) =>
      page.once("dialog", async (d) => {
        const type = d.type();
        await d.accept();
        resolve(type);
      }),
    );
    await page.reload();
    const asked = await Promise.race([leave, new Promise((r) => setTimeout(() => r("no question"), 3000))]);
    check(asked === "beforeunload", "the page asks before you leave it with runs that aren't saved", asked);
    await page.waitForFunction(() => /Ready/.test(document.querySelector("#status").textContent), null, { timeout: 10000 });
    check(
      (await page.locator("#btnRun").isDisabled()) && /Record the script first/.test(await page.locator("#runInfo").textContent()),
      "a reopened page says Run needs the script recorded again",
    );
    check(
      (await page.locator("#script").inputValue()) === "My own first line.\nMy own second line." &&
        (await page.locator("#model").inputValue()) === "AT5.2_Feminine" &&
        (await page.locator("#rate").inputValue()) === "48000",
      "the page remembers your script, model name and sample rate",
    );
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
