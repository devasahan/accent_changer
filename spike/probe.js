/**
 * Step 0 probe: is Sanas Accent Translation good and fast enough?
 *
 * Records you reading a script, sends that recording through the engine at
 * live speed, and measures what comes back against what went in: delay,
 * holes, level, bandwidth, and the WebRTC link (RTT, jitter buffer, loss).
 * Also: live listening, a long stability run, and a device-pair delay check.
 */
import { socketHosts, watchStats } from "./webrtc-stats.js"; // first: watches WebRTC before the SDK opens any
import { analyzeRun, estimateDelay, median, percentile } from "../src/core/delay-estimate.js";
import { encodeWav } from "../src/core/wav.js";
import { DEFAULT_SCRIPT } from "./script.js";
import { connectSanas, disconnectSanas, mockEngine, sanasEngine } from "./engines.js";

const PRICE_PER_MIN = 0.009; // AT5.2 on Sanas Cloud (developer.sanas.ai pricing, 2026-10-01)
const TAIL_SEC = 2.5; // keep recording after the script ends, to catch the delayed output
const DELAY_LIMIT_MS = 380; // GO needs a median at or under this (spike/FINDINGS.md)
const NO_AUDIO = /no converted audio/;
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (v, digits = 0) => (Number.isFinite(v) ? Number(v.toFixed(digits)) : v ?? null);

const state = {
  ctx: null,
  mode: "idle", // idle | busy | recording | running | starting | live | long | pair
  recording: null,
  recordingSession: null,
  runs: [],
  last: null, // newest script run: { ref, sig, analysis, sampleRate, run, number }
  pair: null,
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
window.__spike = { state, results: () => buildResults(), openSessions: () => state.sessions.size };

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
  btnSaveJson: () => true,
  btnSaveWav: () => Boolean(state.last || state.recording),
};
// Settings stay fixed while something runs (each run also keeps a copy of the ones it used).
const SETUP_IDS = ["engine", "model", "rate", "jitter", "mockDelay", "mockFail", "mockConnect", "mic", "out", "longMinutes", "pairDevice"];

function refreshButtons() {
  for (const [id, enabled] of Object.entries(BUTTONS)) $(id).disabled = !enabled();
  for (const id of SETUP_IDS) $(id).disabled = state.mode !== "idle";
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
  const fill = (select, list, defaultLabel) => {
    const previous = select.value;
    const options = list.map((d, i) => new Option(d.label || `${d.kind} ${i + 1}`, d.deviceId));
    if (defaultLabel) options.unshift(new Option(defaultLabel, ""));
    select.replaceChildren(...options);
    if ([...select.options].some((o) => o.value === previous)) select.value = previous;
  };
  const inputs = devices.filter((d) => d.kind === "audioinput");
  fill($("mic"), inputs);
  fill($("pairDevice"), inputs);
  fill($("out"), devices.filter((d) => d.kind === "audiooutput"), "Default output");
  // Never pick the virtual cable as the "real" microphone by default.
  const mic = $("mic");
  if (/cable output|krisp/i.test(mic.selectedOptions[0]?.textContent ?? "")) {
    const real = [...mic.options].find((o) => !/cable output|krisp/i.test(o.textContent));
    if (real) mic.value = real.value;
  }
  state.defaultOutputRate = readDefaultOutputRate();
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
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const t0 = performance.now();
    rec.start();
    const meter = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      $("recLevel").value = Math.max(-60, 10 * Math.log10(sum / buf.length + 1e-12));
      $("recInfo").textContent = `Recording… ${((performance.now() - t0) / 1000).toFixed(0)} s`;
    }, 100);
    session = { stream, source, rec, analyser, meter };
  } catch (err) {
    stopTracks(stream);
    throw err;
  }
  state.recordingSession = session;
  state.mode = "recording";
  setStatus("Recording: read the script, then press Stop.");
});

action("btnStopRecord", "busy", async () => {
  const r = state.recordingSession;
  if (!r) return;
  clearInterval(r.meter);
  const [samples] = await r.rec.stop();
  r.rec.dispose();
  r.source.disconnect();
  r.analyser.disconnect();
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
        r.kind === "script" ? r.engine : `${r.engine} (${r.kind})`,
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
        if ((c === 3 && (!r.ok || r.delayMs > DELAY_LIMIT_MS)) || (c === 5 && gapsBad(r))) td.className = "bad";
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
    summary.rating = {
      score10: null,
      perUtterance: summary.utterances.map(() => ({ natural: false, voice: false, words: false })),
    };
    state.runs.push(summary);
    state.last = { ref: result.ref, sig: result.sig, analysis: result.analysis, sampleRate: ctx.sampleRate, run: summary, number: state.runs.length };
    renderRuns();
    renderUtterances();
    $("runProgress").value = 1;
    const n = state.runs.length;
    if (result.droppedReason) {
      setStatus(`Run ${n}: ${engine.name} dropped the call partway (${result.droppedReason}). Its numbers cover only the part before the drop.`, "error");
    } else if (!summary.ok) setStatus(`Run ${n} finished, but: ${summary.reason}.`, "error");
    else {
      $("runInfo").textContent = `Delay ${Math.round(summary.delayMs)} ms, ${summary.gapCount} gap(s).`;
      setStatus(`Run ${n} done: delay ${Math.round(summary.delayMs)} ms. Listen and rate below.${note}`, note ? "warn" : "ok");
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

function slice(samples, startSec, endSec, sampleRate) {
  const a = Math.max(0, Math.round(startSec * sampleRate));
  const b = Math.min(samples.length, Math.round(endSec * sampleRate));
  return samples.slice(a, Math.max(a, b));
}

function updateScore() {
  const rating = state.last?.run.rating;
  const list = rating?.perUtterance ?? [];
  const good = list.filter((r) => r.natural && r.voice && r.words).length;
  if (rating) rating.score10 = list.length ? round((good / list.length) * 10, 1) : null;
  $("score").textContent = rating?.score10 == null ? "–" : rating.score10.toFixed(1);
}

function renderUtterances() {
  const list = $("utts");
  const last = state.last;
  if (!last?.analysis?.ok) {
    list.replaceChildren();
    $("rateFor").textContent = "";
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
      for (const [key, text] of [["natural", "sounds natural"], ["voice", "still my voice"], ["words", "every word right"]]) {
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = run.rating.perUtterance[i]?.[key] ?? false;
        box.addEventListener("change", () => {
          run.rating.perUtterance[i][key] = box.checked;
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
  const t0 = performance.now();
  const delays = [];
  const timer = setInterval(() => {
    const [ref, sig] = rec.recent(12);
    const est = ref.length > ctx.sampleRate * 4 ? estimateDelay(ref, sig, ctx.sampleRate) : null;
    if (est && est.score >= 0.3) delays.push(est.lagMs);
    const secs = ((performance.now() - t0) / 1000).toFixed(0);
    const link = handle.droppedReason ? `dropped (${handle.droppedReason})` : handle.getState();
    $("liveInfo").textContent = `${secs} s · ${handle.engine} ${link} · delay ${est && est.score >= 0.3 ? `${Math.round(est.lagMs)} ms` : "– (speak)"}`;
  }, 3000);
  state.live = { cfg, mic, micNode, handle, rec, stats, timer, t0, delays };
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
    await l.rec.stop();
    l.rec.dispose();
    l.micNode.disconnect();
    stopTracks(l.mic);
    const webrtc = await l.stats.stop();
    const dropped = l.handle.droppedReason;
    await l.handle.stop();
    state.live = null;
    state.runs.push({
      at: new Date().toISOString(),
      kind: "live",
      engine: l.handle.engine,
      settings: l.cfg,
      ok: l.delays.length > 0,
      reason: l.delays.length ? null : "no speech detected",
      dropped: dropped ?? null,
      durationSec: round((performance.now() - l.t0) / 1000, 1),
      delayMs: round(median(l.delays), 1),
      delayMedianMs: round(median(l.delays), 1),
      delayP95Ms: round(percentile(l.delays, 95), 1),
      delayMaxMs: l.delays.length ? round(Math.max(...l.delays), 1) : null,
      gapCount: null,
      longestGapMs: null,
      webrtc: roundStats(webrtc),
      warmupMs: l.handle.warmupMs,
    });
    renderRuns();
    if (dropped) setStatus(`Live stopped. ${l.handle.engine} had dropped the call (${dropped}).`, "warn");
    else setStatus("Live stopped.", "ok");
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
  const minutes = Math.min(60, Math.max(1, numberOrUndefined("longMinutes") ?? 10));
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

action("btnPair", "pair", async () => {
  const ctx = await ensureCtx();
  const otherId = $("pairDevice").value;
  const otherLabel = $("pairDevice").selectedOptions[0]?.textContent ?? "";
  const viaCable = /cable output/i.test(otherLabel);
  const a = await getMic($("mic").value);
  let b = null;
  let feed = null;
  try {
    b = await getMic(otherId);
    if (viaCable) feed = await feedCable(a); // your microphone → CABLE Input → CABLE Output
  } catch (err) {
    stopTracks(a);
    stopTracks(b);
    throw err;
  }
  const na = ctx.createMediaStreamSource(a);
  const nb = ctx.createMediaStreamSource(b);
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
    feed?.close();
    stopTracks(a);
    stopTracks(b);
  }
  const [ref, sig] = recorded;
  const r = analyzeRun({ ref, sig, sampleRate: ctx.sampleRate });
  const reason = !r.reason
    ? null
    : NO_AUDIO.test(r.reason)
      ? `“${otherLabel}” stayed silent`
      : "your microphone stayed silent: say “pa-ta-ka” during the 12 s";
  state.pair = {
    at: new Date().toISOString(),
    device: otherLabel,
    viaCable,
    ok: r.ok,
    reason,
    delayMs: round(r.delayMs, 1),
    score: round(r.delayScore, 3),
    levelDiffDb: round(r.levelDiffDb, 1),
  };
  const what = viaCable ? "Your microphone through CABLE Input → CABLE Output" : otherLabel;
  $("pairInfo").textContent = r.ok
    ? `${what}: ${Math.round(r.delayMs)} ms later than your microphone (match ${r.delayScore.toFixed(2)}).`
    : `Could not measure: ${reason}.`;
  setStatus(r.ok ? "Measured." : `Could not measure: ${reason}.`, r.ok ? "ok" : "warn");
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
    schema: 2,
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
    runs: state.runs, // script runs carry their own rating
    notes: $("notes").value,
    pair: state.pair,
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

action("btnSaveJson", null, () => {
  download(`sanas-check-${stamp()}.json`, new Blob([JSON.stringify(buildResults(), null, 2)], { type: "application/json" }));
});

action("btnSaveWav", null, () => {
  const rate = state.last?.sampleRate ?? state.ctx?.sampleRate ?? 48000;
  const wav = state.last ? encodeWav([state.last.ref, state.last.sig], rate) : encodeWav([state.recording], rate);
  download(`sanas-check-${stamp()}${state.last ? "-original-left-converted-right" : "-recording"}.wav`, new Blob([wav], { type: "audio/wav" }));
});

// ---------- start ----------

window.addEventListener("pagehide", () => {
  state.liveStart?.abort();
  for (const handle of state.sessions) handle.stop();
  disconnectSanas();
});

$("script").value = DEFAULT_SCRIPT;
if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
  setStatus(
    `Open this page as http://localhost:${location.port || "8080"}/spike/ (not by IP address or as a file): the browser only allows the microphone there.`,
    "error",
  );
} else {
  setStatus("Ready. Start with “Allow microphone”.", "info");
  listDevices().catch(() => {});
}
refreshButtons();
