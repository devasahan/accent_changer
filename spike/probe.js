/**
 * Step 0 probe: is Sanas Accent Translation good and fast enough?
 *
 * Records you reading a script, sends that recording through the engine at
 * live speed, and measures what comes back against what went in: delay,
 * holes, level, bandwidth, and the WebRTC link (RTT, jitter buffer, loss).
 * Also: live listening, a long stability run, and step 7, which measures
 * another app's virtual microphone (Krisp, the Sanas desktop app) the same
 * way while you read the script aloud, so the engines can be compared.
 */
import { socketHosts, watchStats } from "./webrtc-stats.js"; // first: watches WebRTC before the SDK opens any
import { analyzeRun, estimateDelay, median, percentile } from "../src/core/delay-estimate.js";
import { encodeWav } from "../src/core/wav.js";
import { DEFAULT_SCRIPT } from "./script.js";
import { quietNote, quietTest, soundSec } from "./quiet-test.js";
import { connectSanas, disconnectSanas, mockEngine, sanasEngine } from "./engines.js";

const PRICE_PER_MIN = 0.009; // AT5.2 on Sanas Cloud (developer.sanas.ai pricing, 2026-10-01)
const TAIL_SEC = 2.5; // keep recording after the script ends, to catch the delayed output
const DELAY_LIMIT_MS = 380; // GO needs a median at or under this (spike/FINDINGS.md)
// A ready-made app's delay includes its microphone path, which our app adds on top of the
// Sanas figure (Gate 1 allows 120 ms): INTERVIEW.md's bar is about 500 ms.
const APP_DELAY_LIMIT_MS = DELAY_LIMIT_MS + 120;
const LONG_MAX_MIN = 90; // the README asks for one 65-minute run
const READ_MAX_SEC = 300; // "Read the script" stops by itself after 5 minutes
const READ_TAIL_SEC = 3; // after Stop, "Read the script" listens this long for the app's last words
const KEEP_AUDIO_RUNS = 6; // runs whose sound stays playable here (25-50 MB each)
const SPEECH_DB = -45; // a level above this counts as speech for the live and read hints
// Other apps' virtual microphones: never picked as your "real" microphone by default.
const VIRTUAL_MIC = /cable output|krisp|sanas|voicemeeter|steam streaming/i;
const SAME_MIC =
  "Pick the other app's microphone (for example “Krisp Microphone”) as the other microphone in step 7: it is now the same as yours.";
const RATINGS = [
  ["natural", "sounds natural"],
  ["voice", "still my voice"],
  ["words", "every word right"],
  ["american", "sounds American"],
];
const NO_AUDIO = /no converted audio/;
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (v, digits = 0) => (Number.isFinite(v) ? Number(v.toFixed(digits)) : v ?? null);

const state = {
  ctx: null,
  mode: "idle", // idle | busy | recording | running | starting | live | long | pair | read | watch
  recording: null,
  recordingSession: null,
  runs: [],
  last: null, // the run being rated and played: { ref, sig, analysis, sampleRate, run, number }
  audio: new Map(), // run number → the same, for the runs whose sound is still kept
  keepAudioRuns: KEEP_AUDIO_RUNS,
  pairs: [], // step 7 quick checks
  pairChosen: false, // the other-microphone choice was made by hand
  read: null, // step 7 "Read the script" while it records
  watch: null, // step 7 "Long check" while it runs
  originCheck: null, // the server's check of which page addresses Sanas accepts
  live: null,
  liveStart: null, // AbortController while live is starting
  long: null,
  sessions: new Set(), // engine sessions still open
  sanasSeconds: 0,
  init: null,
  defaultOutputRate: null,
  errors: [],
  log: [],
  playing: null,
};
window.__spike = {
  state,
  results: () => buildResults(),
  openSessions: () => state.sessions.size,
  // for the browser test
  keepAudio: (e) => keepAudio(e),
  refreshRating: () => {
    renderRateChoices();
    renderUtterances();
  },
};

// ---------- status, log, buttons ----------

function log(message) {
  const line = `${new Date().toLocaleTimeString()}  ${message}`;
  state.log.push(line);
  if (state.log.length > 1000) state.log.shift();
  const el = $("log");
  el.textContent = state.log.slice(-300).join("\n");
  el.scrollTop = el.scrollHeight;
}

function setStatus(message, kind = "info") {
  const el = $("status");
  el.textContent = message;
  el.dataset.kind = kind;
  if (kind === "error") state.errors.push({ at: new Date().toISOString(), message });
  log(message);
}

const BUTTONS = {
  btnMic: () => state.mode === "idle",
  btnConnect: () => state.mode === "idle" && $("engine").value === "sanas",
  btnRecord: () => state.mode === "idle",
  btnStopRecord: () => state.mode === "recording",
  btnRun: () => state.mode === "idle" && Boolean(state.recording),
  btnPlayOrig: () => Boolean(state.last) && ["idle", "long"].includes(state.mode),
  btnPlayConv: () => Boolean(state.last) && ["idle", "long"].includes(state.mode),
  btnStopPlay: () => Boolean(state.playing),
  btnLive: () => state.mode === "idle",
  btnStopLive: () => state.mode === "live" || (state.mode === "starting" && Boolean(state.liveStart)),
  btnLong: () => state.mode === "idle" && Boolean(state.recording),
  btnStopLong: () => state.mode === "long" && !state.long?.stopping,
  btnPair: () => state.mode === "idle",
  btnRead: () => state.mode === "idle",
  btnStopRead: () => state.mode === "read",
  btnWatch: () => state.mode === "idle",
  btnStopWatch: () => state.mode === "watch",
  btnSaveJson: () => true,
  btnSaveWav: () => Boolean(state.last || state.recording),
};
// Settings stay fixed while something runs (each run also keeps a copy of the ones it used).
const SETUP_IDS = ["engine", "model", "rate", "jitter", "mockDelay", "mockFail", "mockConnect", "mic", "out", "longMinutes", "pairDevice"];

// Run and the stability run use step 2's recording, which lives only in the open page.
const NEEDS_RECORDING = "Record the script first (step 2): this uses that recording. A reopened page has none.";

function refreshButtons() {
  for (const [id, enabled] of Object.entries(BUTTONS)) $(id).disabled = !enabled();
  for (const id of ["runInfo", "longInfo"]) {
    if (!state.recording) $(id).textContent = NEEDS_RECORDING;
    else if ($(id).textContent === NEEDS_RECORDING) $(id).textContent = "";
  }
  for (const id of SETUP_IDS) $(id).disabled = state.mode !== "idle";
  $("rateRun").disabled = !["idle", "long"].includes(state.mode);
  const mock = $("engine").value === "mock";
  for (const el of document.querySelectorAll(".mock-only")) el.classList.toggle("hidden", !mock);
  updateCost();
}

/**
 * Run an action from a button, errors shown in the status line. With a
 * `mode`, the page enters that mode at the click, before anything is
 * awaited (so a double click can't start it twice), and is idle afterwards
 * unless the action moved on to another mode (like "live").
 */
function action(id, mode, fn) {
  $(id).addEventListener("click", async () => {
    if (!BUTTONS[id]()) return;
    if (mode) state.mode = mode;
    refreshButtons();
    try {
      await fn();
    } catch (err) {
      console.error(err);
      setStatus(err?.message ?? String(err), "error");
    } finally {
      if (mode && state.mode === mode) state.mode = "idle";
      refreshButtons();
    }
  });
}

// ---------- settings this browser remembers ----------
// Part 2 runs days after Part 1 on a freshly opened page: your own script, the
// model name, the sample rate and your device choices come back. (Per browser,
// on this PC only; nothing is sent anywhere.)

const STORE = "accentChanger.";

function remember(key, value) {
  try {
    localStorage.setItem(STORE + key, value);
  } catch {
    // storage blocked: the page still works, it just won't remember
  }
}

function recall(key) {
  try {
    return localStorage.getItem(STORE + key);
  } catch {
    return null;
  }
}

const usingExampleScript = () => $("script").value.trim() === DEFAULT_SCRIPT.trim();

// ---------- audio plumbing ----------

async function ensureCtx() {
  if (!state.ctx || state.ctx.state === "closed") {
    state.ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    await state.ctx.audioWorklet.addModule("./recorder.worklet.js");
    await applySink();
  }
  if (state.ctx.state !== "running") await state.ctx.resume();
  return state.ctx;
}

async function applySink() {
  const ctx = state.ctx;
  if (!ctx || typeof ctx.setSinkId !== "function") return;
  try {
    await ctx.setSinkId($("out").value || "");
  } catch (err) {
    setStatus(`Could not play on that output: ${err.message}`, "warn");
  }
}

/** Sample rate of Windows' default playback device (the Sanas SDK renders there). */
function readDefaultOutputRate() {
  try {
    const probe = new AudioContext();
    const rate = probe.sampleRate;
    probe.close().catch(() => {});
    return rate;
  } catch {
    return null;
  }
}

function micConstraints(deviceId) {
  return {
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  };
}

function micErrorText(err) {
  const name = err?.name ?? "";
  const message = err?.message ?? String(err);
  if (name === "NotAllowedError" && /system/i.test(message)) {
    return "Windows blocked the microphone: Settings → Privacy & security → Microphone → turn on microphone access and “Let desktop apps access your microphone”, then reload this page.";
  }
  if (name === "NotAllowedError") {
    return "The browser blocked the microphone for this page: click the icon left of the address bar → Permissions for this site → Microphone → Allow, then reload the page.";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "The microphone could not be opened: another app may be holding it, or Windows blocked it. Close apps that use it and try again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "That microphone was not found (unplugged?). Plug it in, press “Allow microphone” again and pick it.";
  }
  return `Microphone error: ${message}`;
}

async function getMic(deviceId) {
  try {
    return await navigator.mediaDevices.getUserMedia(micConstraints(deviceId));
  } catch (err) {
    throw new Error(micErrorText(err));
  }
}

const stopTracks = (stream) => stream?.getTracks().forEach((t) => t.stop());

function concat(list) {
  const out = new Float32Array(list.reduce((n, a) => n + a.length, 0));
  let offset = 0;
  for (const a of list) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

/** A recorder worklet with `inputs` inputs, recorded side by side. */
function makeRecorder(ctx, inputs) {
  const node = new AudioWorkletNode(ctx, "spike-recorder", {
    numberOfInputs: inputs,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: "explicit",
    channelInterpretation: "speakers",
  });
  const chunks = Array.from({ length: inputs }, () => []);
  let onStopped = null;
  node.port.onmessage = (e) => {
    if (e.data.type === "chunk") e.data.parts.forEach((p, i) => chunks[i].push(p));
    else if (e.data.type === "stopped") onStopped?.();
  };
  const mute = ctx.createGain(); // keeps the worklet pulled by the graph, silently
  mute.gain.value = 0;
  node.connect(mute).connect(ctx.destination);
  return {
    node,
    start: () => node.port.postMessage("start"),
    stop: () =>
      new Promise((resolve) => {
        onStopped = () => resolve(chunks.map(concat));
        node.port.postMessage("stop");
      }),
    /** The last `seconds` of every input (older chunks are dropped, in step). */
    recent(seconds) {
      const keep = Math.round(seconds * ctx.sampleRate);
      for (const list of chunks) {
        let total = list.reduce((n, a) => n + a.length, 0);
        while (list.length > 1 && total - list[0].length >= keep) {
          total -= list[0].length;
          list.shift();
        }
      }
      return chunks.map(concat);
    },
    dispose() {
      node.port.onmessage = null;
      node.disconnect();
      mute.disconnect();
    },
  };
}

function peakDb(samples) {
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

function rmsDb(samples) {
  let sum = 0;
  for (const v of samples) sum += v * v;
  return 10 * Math.log10(sum / Math.max(1, samples.length) + 1e-12);
}

/** The level of `source` in dBFS (-60 at most quiet), read on demand. */
function levelMeter(ctx, source) {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  return {
    read() {
      analyser.getFloatTimeDomainData(buf);
      return Math.max(-60, rmsDb(buf));
    },
    dispose: () => analyser.disconnect(),
  };
}

// ---------- settings and engines ----------

function numberOrUndefined(id) {
  const raw = $(id).value.trim();
  if (raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** The settings a run uses: read once when it starts and saved with it. */
function settings() {
  const mock = $("engine").value === "mock";
  return {
    engine: $("engine").value,
    modelName: $("model").value.trim() || "AT5.2",
    sampleRate: Number($("rate").value),
    jitterBufferTargetMs: numberOrUndefined("jitter") ?? null,
    mockDelayMs: mock ? numberOrUndefined("mockDelay") ?? 300 : null,
    mockFailAfterSec: mock ? numberOrUndefined("mockFail") ?? null : null,
    mockConnectMs: mock ? numberOrUndefined("mockConnect") ?? 0 : null,
    micLabel: $("mic").selectedOptions[0]?.textContent ?? "",
    outputLabel: $("out").selectedOptions[0]?.textContent ?? "",
    defaultOutputRate: state.defaultOutputRate,
  };
}

function engineFor(cfg) {
  if (cfg.engine === "mock") return mockEngine({ delayMs: cfg.mockDelayMs, failAfterSec: cfg.mockFailAfterSec, connectMs: cfg.mockConnectMs });
  return sanasEngine({ modelName: cfg.modelName, sampleRate: cfg.sampleRate, jitterBufferTargetMs: cfg.jitterBufferTargetMs ?? undefined });
}

/** A warning when Windows' default playback device would band-limit the converted audio, else "". */
function outputRateWarning(cfg) {
  if (cfg.engine !== "sanas" || cfg.sampleRate !== 48000 || !cfg.defaultOutputRate || cfg.defaultOutputRate >= 44100) return "";
  const text =
    ` Note: Windows' default playback device runs at ${cfg.defaultOutputRate / 1000} kHz (a Bluetooth headset in call mode?). ` +
    "Sanas plays its audio through that device, so this 48 kHz test can't sound better than that: make wired or USB headphones the default device.";
  log(text.trim());
  return text;
}

/**
 * Start an engine session fed from the page's AudioContext. Returns a
 * handle with `toEngine` (connect sources to it: each session gets its own,
 * because the SDK stops its input track when the call ends) and
 * `fromEngine` (the converted audio, kept pulled by the graph so nothing
 * queues up while it isn't recorded). Counts the Sanas time it stays open.
 */
async function openSession(engine, ctx, { onDrop, signal } = {}) {
  const toEngine = ctx.createMediaStreamDestination();
  toEngine.channelCount = 1;
  const t0 = performance.now();
  let session;
  try {
    session = await engine.start({
      input: toEngine.stream,
      signal,
      onState: (s, reason) => log(`${engine.name}: ${s}${reason ? ` (${reason})` : ""}`),
      onDrop: (reason) => {
        log(`${engine.name}: the call dropped (${reason})`);
        onDrop?.(reason);
      },
    });
  } catch (err) {
    stopTracks(toEngine.stream);
    throw err;
  }
  log(`${engine.name}: audio can flow after ${session.warmupMs} ms`);
  const fromEngine = ctx.createMediaStreamSource(session.outputStream);
  const keepPulled = ctx.createGain();
  keepPulled.gain.value = 0;
  fromEngine.connect(keepPulled).connect(ctx.destination);
  const handle = {
    engine: engine.name,
    toEngine,
    fromEngine,
    warmupMs: session.warmupMs,
    get droppedReason() {
      return session.droppedReason;
    },
    getState: () => session.getState(),
    async stop() {
      if (!state.sessions.has(handle)) return;
      state.sessions.delete(handle);
      fromEngine.disconnect();
      keepPulled.disconnect();
      await session.stop();
      if (engine.name === "sanas") state.sanasSeconds += (performance.now() - t0) / 1000;
      updateCost();
    },
  };
  state.sessions.add(handle);
  return handle;
}

function updateCost() {
  const minutes = state.sanasSeconds / 60;
  $("costInfo").textContent = `Sanas time this session: ${minutes.toFixed(1)} min ≈ $${(minutes * PRICE_PER_MIN).toFixed(3)}`;
}

// ---------- 1 · setup ----------

async function listDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const outBefore = $("out").value;
  const fill = (select, list, defaultLabel) => {
    const previous = select.value;
    const options = list.map((d, i) => new Option(d.label || `${d.kind} ${i + 1}`, d.deviceId));
    if (defaultLabel) options.unshift(new Option(defaultLabel, ""));
    select.replaceChildren(...options);
    const has = (value) => value != null && [...select.options].some((o) => o.value === value);
    if (has(previous) && (previous !== "" || !has(recall(select.id)))) select.value = previous;
    else if (has(recall(select.id))) {
      select.value = recall(select.id);
      if (select.id === "pairDevice") state.pairChosen = true;
    }
  };
  const inputs = devices.filter((d) => d.kind === "audioinput");
  fill($("mic"), inputs);
  fill($("pairDevice"), inputs);
  fill($("out"), devices.filter((d) => d.kind === "audiooutput"), "Default output");
  // Never pick a virtual microphone (VB-CABLE, Krisp, Sanas…) as the "real" one by default.
  const mic = $("mic");
  if (VIRTUAL_MIC.test(mic.selectedOptions[0]?.textContent ?? "")) {
    const real = [...mic.options].find((o) => !VIRTUAL_MIC.test(o.textContent));
    if (real) mic.value = real.value;
  }
  // And for step 7, start from another app's microphone if there is one.
  const pair = $("pairDevice");
  if (!state.pairChosen) {
    const other = [...pair.options].find((o) => VIRTUAL_MIC.test(o.textContent));
    if (other) pair.value = other.value;
  }
  state.defaultOutputRate = readDefaultOutputRate();
  // The list changed what the output shows (headphones plugged in or out): play there too.
  if ($("out").value !== outBefore) await applySink();
}

action("btnMic", "busy", async () => {
  const stream = await getMic("");
  stopTracks(stream);
  await listDevices();
  setStatus("Microphone allowed. Pick your headset microphone and headphones above.", "ok");
});

action("btnConnect", "busy", async () => {
  setStatus("Connecting to Sanas…");
  state.init = await connectSanas();
  $("connInfo").textContent = `Connected in ${state.init.initMs} ms.`;
  setStatus("Connected to Sanas (token and entitlements OK). Now record the script.", "ok");
});

$("out").addEventListener("change", () => applySink());
$("pairDevice").addEventListener("change", () => (state.pairChosen = true));
for (const id of ["mic", "out", "pairDevice", "model", "rate"]) $(id).addEventListener("change", () => remember(id, $(id).value));
$("model").addEventListener("input", () => remember("model", $("model").value));
$("script").addEventListener("input", () => remember("script", $("script").value));
$("engine").addEventListener("change", refreshButtons);
navigator.mediaDevices?.addEventListener?.("devicechange", () => listDevices().catch(() => {}));

// ---------- 2 · record ----------

action("btnRecord", "busy", async () => {
  const ctx = await ensureCtx();
  const stream = await getMic($("mic").value);
  let session;
  try {
    const source = ctx.createMediaStreamSource(stream);
    const rec = makeRecorder(ctx, 1);
    source.connect(rec.node, 0, 0);
    const level = levelMeter(ctx, source);
    const t0 = performance.now();
    rec.start();
    const meter = setInterval(() => {
      $("recLevel").value = level.read();
      $("recInfo").textContent = `Recording… ${((performance.now() - t0) / 1000).toFixed(0)} s`;
    }, 100);
    session = { stream, source, rec, level, meter };
  } catch (err) {
    stopTracks(stream);
    throw err;
  }
  state.recordingSession = session;
  state.mode = "recording";
  setStatus(
    "Recording: read the script, then press Stop." +
      (usingExampleScript() ? " (This is the example script: for the real test, put your own words in the box first.)" : ""),
  );
});

action("btnStopRecord", "busy", async () => {
  const r = state.recordingSession;
  if (!r) return;
  clearInterval(r.meter);
  const [samples] = await r.rec.stop();
  r.rec.dispose();
  r.level.dispose();
  r.source.disconnect();
  stopTracks(r.stream);
  state.recordingSession = null;
  state.recording = samples;
  const seconds = samples.length / state.ctx.sampleRate;
  const peak = peakDb(samples);
  $("recLevel").value = -60;
  $("recInfo").textContent = `${seconds.toFixed(1)} s recorded, peak ${peak.toFixed(1)} dBFS.`;
  if (peak > -0.5) setStatus("Recorded, but it clipped (too loud). Move the mic away a little and record again.", "warn");
  else if (peak < -30) setStatus("Recorded, but it is very quiet. Check the microphone choice and level, then record again.", "warn");
  else if (seconds < 30) setStatus("Recorded, but it is short: read the whole script (about a minute) so the numbers mean something.", "warn");
  else setStatus("Recorded. Now run it through the engine (step 3).", "ok");
});

// ---------- 3 · run through the engine ----------

/**
 * Play the recording into an open session at live speed and record what
 * went in and what came back, side by side. When `stopAsked()` turns true
 * the playback stops and the recording goes on until the output has caught
 * up; when the call drops it ends at once.
 */
async function runOnce({ handle, ctx, onProgress, stopAsked = () => false }) {
  const rec = makeRecorder(ctx, 2);
  handle.fromEngine.connect(rec.node, 0, 1);
  const buffer = ctx.createBuffer(1, state.recording.length, ctx.sampleRate);
  buffer.copyToChannel(state.recording, 0);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(handle.toEngine);
  src.connect(rec.node, 0, 0);
  const stats = watchStats();
  rec.start();
  await sleep(150);
  src.start();
  const t0 = performance.now();
  let endAt = t0 + buffer.duration * 1000 + TAIL_SEC * 1000;
  let stoppedEarly = false;
  let cutByDrop = false;
  while (performance.now() < endAt) {
    onProgress?.(Math.min(1, (performance.now() - t0) / (endAt - t0)));
    await sleep(100);
    if (handle.droppedReason) {
      cutByDrop = true;
      break;
    }
    if (!stoppedEarly && stopAsked()) {
      stoppedEarly = true;
      try {
        src.stop();
      } catch {
        // already ended
      }
      endAt = Math.min(endAt, performance.now() + TAIL_SEC * 1000);
    }
  }
  const [ref, sig] = await rec.stop();
  src.disconnect();
  try {
    handle.fromEngine.disconnect(rec.node);
  } catch {
    // the session was already closed (page closing)
  }
  rec.dispose();
  const webrtc = await stats.stop();
  const analysis = analyzeRun({ ref, sig, sampleRate: ctx.sampleRate });
  return { ref, sig, analysis, webrtc, engineState: handle.getState(), stoppedEarly, cutByDrop, droppedReason: handle.droppedReason };
}

function roundStats(webrtc) {
  return webrtc
    ? {
        rttMs: round(webrtc.rttMs, 1),
        jitterMs: round(webrtc.jitterMs, 1),
        jitterBufferMs: round(webrtc.jitterBufferMs, 1),
        packetLossPct: round(webrtc.packetLossPct, 2),
        concealedPct: round(webrtc.concealedPct, 2),
        codec: webrtc.codec,
        remote: webrtc.remote,
      }
    : null;
}

function summarize(result, extra, cfg) {
  const a = result.analysis;
  return {
    at: new Date().toISOString(),
    ...extra,
    settings: cfg,
    ok: a.ok,
    reason: a.reason ?? null,
    engineStateAfter: result.engineState,
    dropped: result.droppedReason ?? null,
    stoppedEarly: result.stoppedEarly,
    delayMs: round(a.delayMs, 1),
    delayScore: round(a.delayScore, 3),
    delayMedianMs: round(a.delayMedianMs, 1),
    delayP95Ms: round(a.delayP95Ms, 1),
    delayMinMs: round(a.delayMinMs, 1),
    delayMaxMs: round(a.delayMaxMs, 1),
    gapCount: a.gapCount ?? null,
    gapMissingMs: round(a.gapMissingMs),
    longestGapMs: round(a.longestGapMs),
    gaps: (a.gaps ?? []).map((g) => ({
      atSec: round(g.atSec, 2),
      holeMs: round(g.holeMs),
      missingSpeechMs: round(g.missingSpeechMs),
      silentMs: round(g.silentMs),
      pastEnd: g.pastEnd,
    })),
    levelDiffDb: round(a.levelDiffDb, 1),
    bandwidthRefHz: a.bandwidthRefHz,
    bandwidthSigHz: a.bandwidthSigHz,
    speechSec: round(a.speechSec, 1),
    durationSec: round(a.durationSec, 1),
    utterances: (a.utterances ?? []).map((u) => ({
      startSec: round(u.startSec, 2),
      endSec: round(u.endSec, 2),
      lagMs: round(u.lagMs, 1),
      score: round(u.score, 2),
      trusted: u.trusted,
    })),
    webrtc: roundStats(result.webrtc),
  };
}

function fmtKHz(hz) {
  return Number.isFinite(hz) ? `${(hz / 1000).toFixed(1)} kHz` : "–";
}

function gapsCell(r) {
  if (!r.ok || r.gapCount == null) return r.kind === "live" && r.dropped ? "dropped" : "–";
  const parts = [`${r.gapCount} (${r.longestGapMs ?? 0})`];
  if (r.loopsWithoutAudio) parts.push(`${r.loopsWithoutAudio} silent loop${r.loopsWithoutAudio > 1 ? "s" : ""}`);
  if (r.failures?.length) parts.push(`${r.failures.length} drop${r.failures.length > 1 ? "s" : ""}`);
  if (r.dropped) parts.push("dropped");
  return parts.join(", ");
}

function gapsBad(r) {
  if (r.dropped || r.loopsWithoutAudio || r.failures?.length || r.reconnectError) return true;
  return r.kind === "long" ? r.gapCount > r.loops : r.gapCount > 1;
}

function renderRuns() {
  const body = $("runs").tBodies[0];
  body.replaceChildren(
    ...state.runs.map((r, i) => {
      const tr = document.createElement("tr");
      const spread = r.ok ? `${Math.round(r.delayMedianMs ?? NaN)} / ${Math.round(r.delayP95Ms ?? NaN)}` : "–";
      const cells = [
        String(i + 1),
        r.kind === "script" ? r.engine : `${r.engine} (${{ read: "read aloud", watch: "long check" }[r.kind] ?? r.kind})`,
        r.settings.engine === "sanas" ? `${r.settings.sampleRate / 1000} kHz` : "–",
        r.ok ? String(Math.round(r.delayMs)) : r.reason ?? "failed",
        r.kind === "long" && r.ok ? `${spread} (max ${Math.round(r.delayMaxMs ?? NaN)})` : spread,
        gapsCell(r),
        fmtKHz(r.bandwidthSigHz),
        r.levelDiffDb == null ? "–" : (r.levelDiffDb > 0 ? "+" : "") + r.levelDiffDb,
        r.webrtc?.rttMs ?? "–",
        r.webrtc?.jitterBufferMs ?? "–",
        r.webrtc ? `${r.webrtc.packetLossPct ?? "–"} / ${r.webrtc.concealedPct ?? "–"}` : "–",
        r.webrtc?.codec ?? "–",
        r.warmupMs ?? "–",
      ];
      cells.forEach((text, c) => {
        const td = document.createElement("td");
        td.textContent = text;
        const limit = r.settings?.engine === "device" ? APP_DELAY_LIMIT_MS : DELAY_LIMIT_MS;
        if ((c === 3 && (!r.ok || r.delayMs > limit)) || (c === 5 && gapsBad(r))) td.className = "bad";
        tr.append(td);
      });
      return tr;
    }),
  );
}

action("btnRun", "running", async () => {
  const cfg = settings();
  const note = outputRateWarning(cfg);
  const ctx = await ensureCtx();
  const engine = engineFor(cfg);
  setStatus(`Starting ${engine.name}…`);
  const handle = await openSession(engine, ctx);
  try {
    await sleep(500); // let audio settle before measuring
    setStatus(`Sending the recording through ${engine.name} at live speed…`);
    const result = await runOnce({ handle, ctx, onProgress: (p) => ($("runProgress").value = p) });
    const summary = summarize(result, { kind: "script", engine: engine.name, warmupMs: handle.warmupMs }, cfg);
    summary.rating = newRating(summary.utterances.length);
    state.runs.push(summary);
    const letGo = keepAudio({ ref: result.ref, sig: result.sig, analysis: result.analysis, sampleRate: ctx.sampleRate, run: summary, number: state.runs.length });
    renderRuns();
    $("runProgress").value = 1;
    const n = state.runs.length;
    if (result.droppedReason) {
      setStatus(`Run ${n}: ${engine.name} dropped the call partway (${result.droppedReason}). Its numbers cover only the part before the drop.${letGo}`, "error");
    } else if (!summary.ok) setStatus(`Run ${n} finished, but: ${summary.reason}.${letGo}`, "error");
    else {
      $("runInfo").textContent = `Delay ${Math.round(summary.delayMs)} ms, ${summary.gapCount} gap(s).`;
      setStatus(`Run ${n} done: delay ${Math.round(summary.delayMs)} ms. Listen and rate below.${note}${letGo}`, note || letGo ? "warn" : "ok");
    }
  } finally {
    await handle.stop();
  }
});

// ---------- 4 · listen and rate ----------

function stopPlayback() {
  if (state.playing) {
    try {
      state.playing.stop();
    } catch {
      // already ended
    }
    state.playing = null;
  }
  refreshButtons();
}

async function play(samples) {
  stopPlayback();
  const ctx = await ensureCtx();
  const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
  buffer.copyToChannel(samples, 0);
  const node = ctx.createBufferSource();
  node.buffer = buffer;
  node.connect(ctx.destination);
  node.onended = () => {
    if (state.playing === node) {
      state.playing = null;
      refreshButtons();
    }
  };
  node.start();
  state.playing = node;
  refreshButtons();
}

/** A new run's rating: nothing ticked, and not rated until a box is ticked. */
function newRating(lines) {
  return {
    rated: false,
    score10: null,
    perUtterance: Array.from({ length: lines }, () => Object.fromEntries(RATINGS.map(([key]) => [key, false]))),
    blind: null,
  };
}

/**
 * Keep a run's sound playable and rate it next. Only the newest few runs keep
 * their sound (memory): runs with nothing to rate go first. Returns a warning
 * for the status line when a run that could still be rated or played to
 * the blind listener had to go, else "".
 */
function keepAudio(entry) {
  state.audio.set(entry.number, entry);
  let warning = "";
  while (state.audio.size > state.keepAudioRuns) {
    const others = [...state.audio.values()].filter((e) => e !== entry);
    const victim = others.find((e) => !e.analysis?.ok) ?? others[0];
    state.audio.delete(victim.number);
    if (victim.analysis?.ok) {
      warning = ` Run ${victim.number}'s sound was let go to save memory: it can no longer be played for rating or the blind test (its numbers and ratings stay).`;
      log(warning.trim());
    } else log(`Run ${victim.number} (nothing to rate) was let go to save memory.`);
  }
  stopPlayback();
  state.last = entry;
  renderRateChoices();
  renderUtterances();
  return warning;
}

function runLabel(entry) {
  const r = entry.run;
  const rate = r.settings.engine === "sanas" ? `, ${r.settings.sampleRate / 1000} kHz` : "";
  return `Run ${entry.number} · ${r.engine}${rate}${r.kind === "read" ? ", read aloud" : ""}`;
}

function renderRateChoices() {
  const select = $("rateRun");
  select.replaceChildren(...[...state.audio.values()].map((e) => new Option(runLabel(e), String(e.number))));
  if (state.last) select.value = String(state.last.number);
  $("rateRunLabel").classList.toggle("hidden", state.audio.size < 2);
}

$("rateRun").addEventListener("change", () => {
  const entry = state.audio.get(Number($("rateRun").value));
  if (!entry || entry === state.last) return;
  stopPlayback();
  state.last = entry;
  renderUtterances();
});

const BLIND = [
  ["blindWords", "allWordsRight"],
  ["blindVoice", "soundsLikeYou"],
  ["blindUs", "soundsAmerican"],
];

/** A whole number typed in a box: null when empty, NaN when it isn't one. */
function wholeNumber(id) {
  const raw = $(id).value.trim();
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : NaN;
}

/** Store the blind listener's counts with the run being rated; say what is wrong instead of changing it. */
function saveBlind() {
  const rating = state.last?.run.rating;
  if (!rating) return;
  const lines = wholeNumber("blindLines");
  let problem = Number.isNaN(lines) || lines === 0 ? "“Lines played” must be a whole number, like 5." : "";
  const blind = { lines: problem ? null : lines };
  for (const [id, key] of BLIND) {
    const n = wholeNumber(id);
    const bad = Number.isNaN(n) || (n != null && (blind.lines == null || n > blind.lines));
    if (bad && !problem) problem = "Each count must be a whole number from 0 to the number of lines played.";
    blind[key] = bad ? null : n;
  }
  rating.blind = blind;
  $("blindInfo").textContent = problem || `Saved with run ${state.last.number}.`;
  $("blindInfo").dataset.kind = problem ? "warn" : "";
}

for (const id of ["blindLines", ...BLIND.map(([id]) => id)]) $(id).addEventListener("input", saveBlind);

function slice(samples, startSec, endSec, sampleRate) {
  const a = Math.max(0, Math.round(startSec * sampleRate));
  const b = Math.min(samples.length, Math.round(endSec * sampleRate));
  return samples.slice(a, Math.max(a, b));
}

function updateScore() {
  const rating = state.last?.run.rating;
  const list = rating?.perUtterance ?? [];
  const good = list.filter((r) => RATINGS.every(([key]) => r[key])).length;
  // A run nobody rated stays unrated ("–"), not 0 out of 10.
  if (rating) rating.score10 = rating.rated && list.length ? round((good / list.length) * 10, 1) : null;
  $("score").textContent = rating?.score10 == null ? "–" : rating.score10.toFixed(1);
}

function renderUtterances() {
  const list = $("utts");
  const last = state.last;
  const blind = last?.run.rating?.blind;
  $("blindLines").value = blind?.lines ?? 5;
  for (const [id, key] of BLIND) $(id).value = blind?.[key] ?? "";
  $("blindInfo").textContent = "";
  for (const id of ["blindLines", ...BLIND.map(([id]) => id)]) $(id).disabled = !last?.analysis?.ok || !last.run.rating;
  if (!last?.analysis?.ok) {
    list.replaceChildren();
    $("rateFor").textContent = last ? `Run ${last.number} has nothing to rate: ${last.run.reason ?? "no result"}.` : "";
    updateScore();
    return;
  }
  const { analysis, sampleRate, run } = last;
  const rate = run.settings.engine === "sanas" ? `, ${run.settings.sampleRate / 1000} kHz` : "";
  $("rateFor").textContent = `Rating run ${last.number} (${run.engine}${rate}). Every run keeps its own ratings.`;
  list.replaceChildren(
    ...analysis.utterances.map((u, i) => {
      const lagSec = (u.trusted ? u.lagMs : analysis.delayMs) / 1000;
      const li = document.createElement("li");
      const row = document.createElement("div");
      row.className = "row";
      const label = document.createElement("span");
      label.textContent = `${u.startSec.toFixed(1)}–${u.endSec.toFixed(1)} s`;
      const orig = document.createElement("button");
      orig.type = "button";
      orig.textContent = "▶ original";
      orig.addEventListener("click", () => play(slice(last.ref, u.startSec - 0.15, u.endSec + 0.15, sampleRate)));
      const conv = document.createElement("button");
      conv.type = "button";
      conv.textContent = "▶ converted";
      conv.addEventListener("click", () => play(slice(last.sig, u.startSec + lagSec - 0.15, u.endSec + lagSec + 0.25, sampleRate)));
      row.append(label, orig, conv);
      for (const [key, text] of RATINGS) {
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = run.rating.perUtterance[i]?.[key] ?? false;
        box.addEventListener("change", () => {
          run.rating.perUtterance[i][key] = box.checked;
          run.rating.rated = true;
          updateScore();
        });
        const lab = document.createElement("label");
        lab.append(box, ` ${text}`);
        row.append(lab);
      }
      li.append(row);
      return li;
    }),
  );
  updateScore();
}

action("btnPlayOrig", null, () => play(state.last.ref));
action("btnPlayConv", null, () => play(state.last.sig));
action("btnStopPlay", null, () => stopPlayback());

// ---------- following a call (Live, and step 7's long check) ----------

const clock = (secs) => `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, "0")}`;

/**
 * Follows a call while you talk. Every 3 s it looks at the last 12 s of your
 * microphone and of the converted voice: when converted speech follows
 * yours, it notes the delay. It also notes when your microphone had speech,
 * and how many seconds of it were loud, so the quiet test (quiet-test.js) can
 * tell "you were silent" from "nothing came back", and a cough from talk.
 * Only the last 12 s are kept, so it can run for an hour.
 */
function followCall(ctx, rec) {
  const t0 = performance.now();
  const f = { t0, delays: [], heard: [], speech: [], sound: [], last: null };
  f.tick = () => {
    const [ref, sig] = rec.recent(12);
    const secs = round((performance.now() - t0) / 1000, 1);
    const est = ref.length > ctx.sampleRate * 4 ? estimateDelay(ref, sig, ctx.sampleRate) : null;
    f.last = est && est.score >= 0.3 ? est : null;
    if (f.last) {
      f.delays.push(f.last.lagMs);
      f.heard.push(secs);
    }
    // The last 3 s, or what there is of it at the start (the first look comes
    // before 3 s have arrived, and your first words would be missed).
    const last3 = Math.round(ctx.sampleRate * 3);
    const tail = ref.length >= ctx.sampleRate ? ref.subarray(Math.max(0, ref.length - last3)) : null;
    if (tail && rmsDb(tail) > SPEECH_DB) {
      f.speech.push(secs);
      f.sound.push(soundSec(tail, ctx.sampleRate, SPEECH_DB));
    }
    return secs;
  };
  return f;
}

/** What a followed call saves: delays, the quiet test, and both timelines (seconds). */
function callSummary(f) {
  const endSec = round((performance.now() - f.t0) / 1000, 1);
  return {
    ok: f.delays.length > 0,
    reason: f.delays.length ? null : f.speech.length ? "you spoke, but no converted speech came back" : "no speech detected",
    durationSec: endSec,
    ...quietTest(f.speech, f.heard, endSec, f.sound),
    heardAtSec: f.heard,
    speechAtSec: f.speech,
    speechSoundSec: f.sound,
    delayMs: round(median(f.delays), 1),
    delayMedianMs: round(median(f.delays), 1),
    delayP95Ms: round(percentile(f.delays, 95), 1),
    delayMaxMs: f.delays.length ? round(Math.max(...f.delays), 1) : null,
    gapCount: null,
    longestGapMs: null,
  };
}

// ---------- 5 · live ----------

action("btnLive", "starting", async () => {
  const controller = new AbortController();
  state.liveStart = controller;
  refreshButtons();
  const cfg = settings();
  const note = outputRateWarning(cfg);
  const cancelled = () => {
    if (controller.signal.aborted) throw Object.assign(new Error("Cancelled."), { name: "AbortError" });
  };
  let mic = null;
  let micNode = null;
  let handle;
  try {
    const ctx = await ensureCtx();
    cancelled();
    mic = await getMic($("mic").value);
    cancelled();
    micNode = ctx.createMediaStreamSource(mic);
    const engine = engineFor(cfg);
    setStatus(`Starting live ${engine.name}… (Stop cancels)`);
    handle = await openSession(engine, ctx, {
      signal: controller.signal,
      onDrop: (reason) => {
        if (handle && state.live?.handle === handle) setStatus(`Live: ${engine.name} dropped the call (${reason}). Press Stop.`, "error");
      },
    });
  } catch (err) {
    micNode?.disconnect();
    stopTracks(mic);
    if (err?.name === "AbortError") {
      setStatus("Live start cancelled.", "info");
      return;
    }
    throw err;
  } finally {
    state.liveStart = null;
  }
  const ctx = state.ctx;
  // Sanas gets the microphone through the page's AudioContext, like the
  // script runs, so live and script delays measure the same chain.
  micNode.connect(handle.toEngine);
  handle.fromEngine.connect(ctx.destination);
  const rec = makeRecorder(ctx, 2);
  micNode.connect(rec.node, 0, 0);
  handle.fromEngine.connect(rec.node, 0, 1);
  rec.start();
  const stats = watchStats();
  const follow = followCall(ctx, rec);
  const timer = setInterval(() => {
    const secs = follow.tick();
    const link = handle.droppedReason ? `dropped (${handle.droppedReason})` : handle.getState();
    $("liveInfo").textContent = `${clock(secs)} · ${handle.engine} ${link} · delay ${follow.last ? `${Math.round(follow.last.lagMs)} ms` : "– (speak)"}`;
  }, 3000);
  state.live = { cfg, mic, micNode, handle, rec, stats, timer, follow };
  state.mode = "live";
  setStatus(`Live: speak. Press Stop when done.${note}`, note ? "warn" : "ok");
});

action("btnStopLive", null, async () => {
  if (state.liveStart) {
    state.liveStart.abort(); // the starting action cleans up and reports
    return;
  }
  const l = state.live;
  if (!l) return;
  state.mode = "busy";
  refreshButtons();
  try {
    clearInterval(l.timer);
    l.follow.tick(); // one last look, so a short final stretch of speech counts
    await l.rec.stop();
    l.rec.dispose();
    l.micNode.disconnect();
    stopTracks(l.mic);
    const webrtc = await l.stats.stop();
    const dropped = l.handle.droppedReason;
    await l.handle.stop();
    state.live = null;
    const summary = {
      at: new Date().toISOString(),
      kind: "live",
      engine: l.handle.engine,
      settings: l.cfg,
      dropped: dropped ?? null,
      ...callSummary(l.follow),
      webrtc: roundStats(webrtc),
      warmupMs: l.handle.warmupMs,
    };
    state.runs.push(summary);
    renderRuns();
    const quiet = quietNote(summary);
    if (dropped) setStatus(`Live stopped. ${l.handle.engine} had dropped the call (${dropped}).${quiet.text}`, "warn");
    else if (!summary.ok) setStatus(`Live stopped: ${summary.reason}.${quiet.text}`, "warn");
    else setStatus(`Live stopped.${quiet.text}`, quiet.bad ? "warn" : "ok");
  } finally {
    state.mode = "idle";
  }
});

// ---------- 6 · long stability run ----------

action("btnLong", "long", async () => {
  state.long = { stopNow: false, stopping: false };
  try {
    await longRun();
  } finally {
    state.long = null;
  }
});

async function longRun() {
  const cfg = settings();
  const note = outputRateWarning(cfg);
  const minutes = Math.min(LONG_MAX_MIN, Math.max(1, numberOrUndefined("longMinutes") ?? 10));
  const ctx = await ensureCtx();
  const engine = engineFor(cfg);
  const failures = [];
  let droppedAt = null; // a drop (or a silent loop) not yet handled
  let dropReason = "";
  const onDrop = (reason) => {
    if (droppedAt == null) {
      droppedAt = performance.now();
      dropReason = reason;
    }
  };
  setStatus(`Long run: ${minutes} min through ${engine.name}…`);
  let handle = await openSession(engine, ctx, { onDrop });
  const loops = [];
  const t0 = performance.now();
  const endAt = t0 + minutes * 60000;
  let reconnectError = null;
  try {
    await sleep(500);
    while (!state.long.stopNow && performance.now() < endAt) {
      if (droppedAt != null) {
        // Reconnect with a new session, as the app will have to.
        const lostAt = droppedAt;
        const failure = { atMin: round((lostAt - t0) / 60000, 2), reason: dropReason };
        failures.push(failure);
        await handle.stop();
        handle = null;
        droppedAt = null;
        try {
          handle = await openSession(engine, ctx, { onDrop });
          failure.reconnectMs = Math.round(performance.now() - lostAt);
          log(`long run: reconnected after ${failure.reconnectMs} ms`);
        } catch (err) {
          failure.reconnectError = err.message;
          reconnectError = err.message;
          break;
        }
        await sleep(500);
        continue;
      }
      const result = await runOnce({
        handle,
        ctx,
        onProgress: () => ($("longProgress").value = Math.min(1, (performance.now() - t0) / (endAt - t0))),
        stopAsked: () => state.long.stopNow,
      });
      const s = summarize(result, { kind: "loop", engine: engine.name, cutShortByDrop: result.cutByDrop }, cfg);
      loops.push(s);
      if (!s.ok && NO_AUDIO.test(s.reason ?? "") && droppedAt == null && !result.stoppedEarly) {
        // Still "connected", but nothing came back for a whole loop: count it as a drop.
        droppedAt = performance.now();
        dropReason = "no converted audio for a whole loop while the call was up";
      }
      $("longInfo").textContent =
        `${loops.length} loop(s), last delay ${s.ok ? Math.round(s.delayMs) : "–"} ms, ` +
        `${loops.filter((l) => !l.ok).length} without audio, ${failures.length} drop(s)`;
    }
  } finally {
    state.long.stopping = true;
    refreshButtons();
    await handle?.stop();
  }
  if (droppedAt != null) {
    // Dropped during the last loop: count it, though the run ended before a retry.
    failures.push({ atMin: round((droppedAt - t0) / 60000, 2), reason: dropReason, notRetried: true });
  }
  const good = loops.filter((l) => l.ok);
  const silent = loops.filter((l) => !l.ok);
  // Every sentence of every loop counts, so one slow stretch shows in p95 and max.
  const lags = good.flatMap((l) => l.utterances.filter((u) => u.trusted).map((u) => u.lagMs));
  const summary = {
    at: new Date().toISOString(),
    kind: "long",
    engine: engine.name,
    settings: cfg,
    ok: good.length > 0,
    reason: good.length ? null : "no loop produced converted audio",
    minutes: round((performance.now() - t0) / 60000, 2),
    loops: loops.length,
    delayMs: round(median(lags), 1),
    delayMedianMs: round(median(lags), 1),
    delayP95Ms: round(percentile(lags, 95), 1),
    delayMaxMs: lags.length ? round(Math.max(...lags), 1) : null,
    driftMs: good.length > 1 ? round(good.at(-1).delayMs - good[0].delayMs, 1) : null,
    gapCount: good.reduce((n, l) => n + (l.gapCount ?? 0), 0),
    longestGapMs: good.reduce((m, l) => Math.max(m, l.longestGapMs ?? 0), 0),
    loopsWithoutAudio: silent.length,
    loopsCutShortByDrop: loops.filter((l) => l.cutShortByDrop).length,
    failures,
    reconnectError,
    perLoop: loops.map((l) => ({
      ok: l.ok,
      reason: l.reason,
      delayMs: l.delayMs,
      delayP95Ms: l.delayP95Ms,
      delayMaxMs: l.delayMaxMs,
      gapCount: l.gapCount,
      longestGapMs: l.longestGapMs,
      cutShortByDrop: l.cutShortByDrop,
      stoppedEarly: l.stoppedEarly,
      webrtc: l.webrtc,
    })),
    webrtc: loops.at(-1)?.webrtc ?? null,
    warmupMs: null,
  };
  state.runs.push(summary);
  $("longProgress").value = 1;
  renderRuns();
  const head = `Long run done: ${summary.loops} loops, ${summary.gapCount} gap(s), ${failures.length} drop(s)`;
  const delay = summary.ok ? `, delay median ${Math.round(summary.delayMedianMs)} ms, max ${Math.round(summary.delayMaxMs)} ms` : "";
  if (reconnectError) setStatus(`${head}. The connection dropped and could not be reopened: ${reconnectError}`, "error");
  else if (silent.length) setStatus(`${head}${delay}. ${silent.length} of ${summary.loops} loops got no converted audio back.`, "error");
  else setStatus(`${head}${delay}.${note}`, failures.length || summary.gapCount > summary.loops || note ? "warn" : "ok");
}

action("btnStopLong", null, () => {
  if (state.long) {
    state.long.stopNow = true;
    state.long.stopping = true;
    setStatus("Stopping: the current loop stops playing; its converted audio is still collected and measured…");
  }
});

// ---------- 7 · device pair ----------

/** Play `stream` into VB-CABLE's "CABLE Input", so "CABLE Output" carries it. */
async function feedCable(stream) {
  const outputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audiooutput");
  const cable = outputs.find((d) => /cable input/i.test(d.label));
  if (!cable) throw new Error("“CABLE Input” is not among the playback devices. Install VB-CABLE (vb-audio.com), reboot, then reload this page.");
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
  try {
    await ctx.setSinkId(cable.deviceId);
    if (ctx.state !== "running") await ctx.resume();
  } catch (err) {
    ctx.close().catch(() => {});
    throw new Error(`Could not play into CABLE Input: ${err.message}`);
  }
  const source = ctx.createMediaStreamSource(stream);
  source.connect(ctx.destination);
  return {
    close() {
      source.disconnect();
      ctx.close().catch(() => {});
    },
  };
}

/**
 * Your microphone and the other one for step 7. For "CABLE Output" the page
 * plays your microphone into VB-CABLE, so the cable itself is measured.
 */
async function openPair() {
  const otherLabel = $("pairDevice").selectedOptions[0]?.textContent ?? "";
  const viaCable = /cable output/i.test(otherLabel);
  const a = await getMic($("mic").value);
  let b = null;
  let feed = null;
  try {
    b = await getMic($("pairDevice").value);
    if (viaCable) feed = await feedCable(a); // your microphone → CABLE Input → CABLE Output
  } catch (err) {
    stopTracks(a);
    stopTracks(b);
    throw err;
  }
  return { a, b, feed, otherLabel, viaCable };
}

function closePair(p) {
  p.feed?.close();
  stopTracks(p.a);
  stopTracks(p.b);
}

action("btnPair", "pair", async () => {
  const ctx = await ensureCtx();
  const p = await openPair();
  const na = ctx.createMediaStreamSource(p.a);
  const nb = ctx.createMediaStreamSource(p.b);
  const rec = makeRecorder(ctx, 2);
  na.connect(rec.node, 0, 0);
  nb.connect(rec.node, 0, 1);
  rec.start();
  let recorded;
  try {
    for (let left = 12; left > 0; left--) {
      $("pairInfo").textContent = `Say "pa-ta-ka"… ${left} s`;
      await sleep(1000);
    }
  } finally {
    recorded = await rec.stop();
    rec.dispose();
    na.disconnect();
    nb.disconnect();
    closePair(p);
  }
  const [ref, sig] = recorded;
  const r = analyzeRun({ ref, sig, sampleRate: ctx.sampleRate });
  const reason = !r.reason
    ? null
    : NO_AUDIO.test(r.reason)
      ? `“${p.otherLabel}” stayed silent`
      : "your microphone stayed silent: say “pa-ta-ka” during the 12 s";
  state.pairs.push({
    at: new Date().toISOString(),
    device: p.otherLabel,
    viaCable: p.viaCable,
    ok: r.ok,
    reason,
    delayMs: round(r.delayMs, 1),
    score: round(r.delayScore, 3),
    levelDiffDb: round(r.levelDiffDb, 1),
  });
  const what = p.viaCable ? "Your microphone through CABLE Input → CABLE Output" : p.otherLabel;
  $("pairInfo").textContent = r.ok
    ? `${what}: ${Math.round(r.delayMs)} ms later than your microphone (match ${r.delayScore.toFixed(2)}).`
    : `Could not measure: ${reason}.`;
  setStatus(r.ok ? "Measured." : `Could not measure: ${reason}.`, r.ok ? "ok" : "warn");
});

const plainLabel = (label) => label.replace(/^(default|communications) - /i, "").trim().toLowerCase();

/** True when step 7's other microphone is your own one (by id, or by name under "Default - …"). */
function sameMicChoice() {
  const label = (id) => plainLabel($(id).selectedOptions[0]?.textContent ?? "");
  return $("pairDevice").value === $("mic").value || label("pairDevice") === label("mic");
}

/** Your microphone and the other one for step 7, refused when both are one physical device. */
async function openOtherApp() {
  if (sameMicChoice()) throw new Error(SAME_MIC);
  const p = await openPair();
  const group = (stream) => stream.getAudioTracks()[0]?.getSettings().groupId;
  if (group(p.a) && group(p.a) === group(p.b)) {
    closePair(p);
    throw new Error(SAME_MIC);
  }
  return p;
}

/** The settings a step-7 run saves: which devices it compared. */
function deviceSettings(p) {
  return {
    engine: "device",
    device: p.otherLabel,
    viaCable: p.viaCable,
    micLabel: $("mic").selectedOptions[0]?.textContent ?? "",
    outputLabel: $("out").selectedOptions[0]?.textContent ?? "",
    defaultOutputRate: state.defaultOutputRate,
  };
}

// "Read the script": the whole script read aloud, measured like a Sanas run.
action("btnRead", "busy", async () => {
  const ctx = await ensureCtx();
  const p = await openOtherApp();
  const r = { ...p, youSpoke: false, otherHeard: false, autoStopped: false };
  try {
    r.na = ctx.createMediaStreamSource(p.a);
    r.nb = ctx.createMediaStreamSource(p.b);
    r.rec = makeRecorder(ctx, 2);
    r.na.connect(r.rec.node, 0, 0);
    r.nb.connect(r.rec.node, 0, 1);
    r.levels = [levelMeter(ctx, r.na), levelMeter(ctx, r.nb)];
  } catch (err) {
    closePair(p);
    throw err;
  }
  r.cfg = deviceSettings(p);
  r.rec.start();
  r.t0 = performance.now();
  r.timer = setInterval(() => {
    const [you, other] = r.levels.map((m) => m.read());
    $("readLevelA").value = you;
    $("readLevelB").value = other;
    if (you > SPEECH_DB) r.youSpoke = true;
    if (other > SPEECH_DB) r.otherHeard = true;
    const secs = (performance.now() - r.t0) / 1000;
    const silent = r.youSpoke && !r.otherHeard && secs > 8;
    $("readInfo").textContent =
      `Reading… ${secs.toFixed(0)} s` + (silent ? ` · “${r.otherLabel}” is silent: is that app running, with accent conversion on?` : "");
    if (secs >= READ_MAX_SEC && !r.autoStopped) {
      r.autoStopped = true;
      $("btnStopRead").click();
    }
  }, 200);
  state.read = r;
  state.mode = "read";
  setStatus(
    `Recording your microphone and “${p.otherLabel}”. Read the whole script aloud, with about a second of pause between lines, then press Stop.` +
      (usingExampleScript() ? " (This is the example script: for the real comparison, put your own words in step 2's box first.)" : ""),
  );
});

action("btnStopRead", "busy", async () => {
  const r = state.read;
  if (!r) return;
  state.read = null;
  clearInterval(r.timer);
  let recorded;
  try {
    // Like the Sanas runs: keep listening a moment for the app's last words.
    $("readInfo").textContent = "Finishing: listening 3 more seconds for the app's last words…";
    await sleep(READ_TAIL_SEC * 1000);
    recorded = await r.rec.stop();
  } finally {
    r.rec.dispose();
    r.levels.forEach((m) => m.dispose());
    r.na.disconnect();
    r.nb.disconnect();
    closePair(r);
    $("readLevelA").value = -60;
    $("readLevelB").value = -60;
  }
  const [ref, sig] = recorded;
  const ctx = state.ctx;
  const analysis = analyzeRun({ ref, sig, sampleRate: ctx.sampleRate });
  const summary = summarize(
    { analysis, webrtc: null, engineState: null, stoppedEarly: false, droppedReason: null },
    { kind: "read", engine: r.otherLabel, warmupMs: null, autoStopped: r.autoStopped },
    r.cfg,
  );
  if (!analysis.ok) {
    summary.reason = NO_AUDIO.test(analysis.reason ?? "")
      ? `“${r.otherLabel}” stayed silent`
      : "your microphone picked up no speech";
  }
  summary.rating = newRating(summary.utterances.length);
  state.runs.push(summary);
  const letGo = keepAudio({ ref, sig, analysis, sampleRate: ctx.sampleRate, run: summary, number: state.runs.length });
  renderRuns();
  const n = state.runs.length;
  if (!analysis.ok) {
    $("readInfo").textContent = `Could not measure: ${summary.reason}.`;
    const hint = NO_AUDIO.test(analysis.reason ?? "")
      ? " Is that app running, with your headset as its microphone and accent conversion on?"
      : " Check that your headset microphone is picked in step 1.";
    setStatus(`Run ${n}: could not measure: ${summary.reason}.${hint}${letGo}`, "error");
    return;
  }
  const seconds = ref.length / ctx.sampleRate;
  $("readInfo").textContent = `${r.otherLabel}: ${Math.round(summary.delayMs)} ms later than your microphone, ${summary.gapCount} gap(s).`;
  const scriptLines = $("script").value.split("\n").filter((l) => l.trim()).length;
  const merged =
    summary.utterances.length < scriptLines * 0.7
      ? ` Step 4 shows ${summary.utterances.length} lines for a script of ${scriptLines}: read it again with about a second of pause between lines.`
      : "";
  const short = seconds < 30 ? " It was short: read the whole script so the numbers mean something." : "";
  setStatus(
    `Run ${n} (${r.otherLabel}, read aloud): delay ${Math.round(summary.delayMs)} ms. Rate it in step 4.${short}${merged}${letGo}`,
    short || merged || letGo ? "warn" : "ok",
  );
});

// "Long check": another app's microphone followed like a Live call, for up to 90 minutes,
// during a full-length test call (nothing is recorded beyond the last 12 s).
action("btnWatch", "busy", async () => {
  const ctx = await ensureCtx();
  const p = await openOtherApp();
  const w = { ...p, autoStopped: false };
  try {
    w.na = ctx.createMediaStreamSource(p.a);
    w.nb = ctx.createMediaStreamSource(p.b);
    w.rec = makeRecorder(ctx, 2);
    w.na.connect(w.rec.node, 0, 0);
    w.nb.connect(w.rec.node, 0, 1);
  } catch (err) {
    closePair(p);
    throw err;
  }
  w.cfg = deviceSettings(p);
  w.rec.start();
  w.follow = followCall(ctx, w.rec);
  w.timer = setInterval(() => {
    const secs = w.follow.tick();
    $("watchInfo").textContent = `${clock(secs)} · ${w.follow.last ? `delay ${Math.round(w.follow.last.lagMs)} ms` : "– (speak)"}`;
    if (secs >= LONG_MAX_MIN * 60 && !w.autoStopped) {
      w.autoStopped = true;
      $("btnStopWatch").click();
    }
  }, 3000);
  state.watch = w;
  state.mode = "watch";
  setStatus(`Long check: following your microphone and “${p.otherLabel}”. Leave it running through your test call, then press Stop.`);
});

action("btnStopWatch", "busy", async () => {
  const w = state.watch;
  if (!w) return;
  state.watch = null;
  clearInterval(w.timer);
  w.follow.tick(); // one last look
  try {
    await w.rec.stop();
  } finally {
    w.rec.dispose();
    w.na.disconnect();
    w.nb.disconnect();
    closePair(w);
  }
  const summary = {
    at: new Date().toISOString(),
    kind: "watch",
    engine: w.otherLabel,
    settings: w.cfg,
    dropped: null,
    autoStopped: w.autoStopped,
    ...callSummary(w.follow),
    webrtc: null,
    warmupMs: null,
  };
  if (!summary.ok && summary.speechAtSec.length) summary.reason = `you spoke, but “${w.otherLabel}” stayed silent`;
  state.runs.push(summary);
  renderRuns();
  const quiet = quietNote(summary);
  const head = summary.ok
    ? `Long check done: ${clock(summary.durationSec)}, delay median ${Math.round(summary.delayMedianMs)} ms, max ${Math.round(summary.delayMaxMs)} ms.`
    : `Long check: ${summary.reason}.`;
  $("watchInfo").textContent = head;
  setStatus(`${head}${quiet.text}`, !summary.ok || quiet.bad ? "warn" : "ok");
});

// ---------- 8 · save ----------

function browserName() {
  const brands = navigator.userAgentData?.brands ?? [];
  const brand = brands.find((b) => !/not.?a.?brand|chromium/i.test(b.brand)) ?? brands.find((b) => /chromium/i.test(b.brand));
  if (brand) return `${brand.brand} ${brand.version}`;
  const m = /(Edg|Chrome|Firefox)\/(\d+)/.exec(navigator.userAgent);
  return m ? `${m[1] === "Edg" ? "Edge" : m[1]} ${m[2]}` : "unknown";
}

function buildResults() {
  const minutes = state.sanasSeconds / 60;
  const script = $("script").value;
  return {
    tool: "accent-changer spike",
    schema: 3,
    createdAt: new Date().toISOString(),
    browser: browserName(),
    settings: settings(),
    sanas: {
      init: state.init,
      sipHosts: socketHosts.slice(-5),
      minutesOpen: round(minutes, 2),
      estUsd: round(minutes * PRICE_PER_MIN, 3),
    },
    recording: state.recording
      ? { seconds: round(state.recording.length / (state.ctx?.sampleRate ?? 48000), 1), peakDb: round(peakDb(state.recording), 1) }
      : null,
    script: script.trim() === DEFAULT_SCRIPT.trim() ? "default" : script,
    runs: state.runs, // script and read-aloud runs carry their own rating
    notes: $("notes").value,
    pairs: state.pairs,
    originCheck: state.originCheck,
    errors: state.errors,
    log: state.log.slice(-300),
  };
}

function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

action("btnSaveJson", null, async () => {
  await loadOriginCheck();
  download(`sanas-check-${stamp()}.json`, new Blob([JSON.stringify(buildResults(), null, 2)], { type: "application/json" }));
});

action("btnSaveWav", null, () => {
  const rate = state.last?.sampleRate ?? state.ctx?.sampleRate ?? 48000;
  const wav = state.last ? encodeWav([state.last.ref, state.last.sig], rate) : encodeWav([state.recording], rate);
  download(`sanas-check-${stamp()}${state.last ? "-original-left-converted-right" : "-recording"}.wav`, new Blob([wav], { type: "audio/wav" }));
});

/** The server's check of which page addresses Sanas accepts (it runs when the key is accepted). */
async function loadOriginCheck() {
  try {
    // A server that stopped answering must not hold up saving the results.
    const res = await fetch("/origin-check", { cache: "no-store", signal: AbortSignal.timeout(1500) });
    if (!res.ok) return;
    const check = await res.json();
    if (!check?.ran) {
      if (check?.reason) {
        state.originCheck = check;
        $("originInfo").textContent = `Sanas address check skipped: ${check.reason}.`;
      }
      return;
    }
    if (state.originCheck?.at !== check.at) log(`Sanas address check: ${check.conclusion}`);
    state.originCheck = check;
    $("originInfo").textContent = `Sanas address check for the app: ${check.conclusion}`;
  } catch {
    // an older server: nothing to show
  }
}

// ---------- start ----------

// Runs, ratings, notes and the recording live only in the open page: ask before leaving it.
window.addEventListener("beforeunload", (event) => {
  if (state.runs.length || state.recording || state.mode !== "idle") {
    event.preventDefault();
    event.returnValue = "";
  }
});

window.addEventListener("pagehide", () => {
  state.liveStart?.abort();
  for (const handle of state.sessions) handle.stop();
  disconnectSanas();
});

$("script").value = recall("script") || DEFAULT_SCRIPT;
if (recall("model")) $("model").value = recall("model");
if ([...$("rate").options].some((o) => o.value === recall("rate"))) $("rate").value = recall("rate");
if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
  setStatus(
    `Open this page as http://localhost:${location.port || "8080"}/spike/ (not by IP address or as a file): the browser only allows the microphone there.`,
    "error",
  );
} else {
  setStatus("Ready. Start with “Allow microphone”.", "info");
  listDevices().catch(() => {});
  loadOriginCheck();
}
refreshButtons();
