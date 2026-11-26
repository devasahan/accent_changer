/**
 * Step 0 probe: is Sanas Accent Translation good and fast enough?
 *
 * Records you reading a script, sends that recording through the engine at
 * live speed, and measures what comes back against what went in: delay,
 * holes, level, bandwidth, and the WebRTC link (RTT, jitter buffer, loss).
 * Also: live listening, a long stability run, and a device-pair delay check.
 */
import { socketHosts, watchStats } from "./webrtc-stats.js"; // first: watches WebRTC before the SDK opens any
import { analyzeRun, estimateDelay } from "../src/core/delay-estimate.js";
import { encodeWav } from "../src/core/wav.js";
import { DEFAULT_SCRIPT } from "./script.js";
import { connectSanas, disconnectSanas, mockEngine, sanasEngine } from "./engines.js";

const PRICE_PER_MIN = 0.009; // AT5.2 on Sanas Cloud (developer.sanas.ai pricing, 2026-10-01)
const TAIL_SEC = 2.5; // keep recording after the script ends, to catch the delayed output
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (v, digits = 0) => (Number.isFinite(v) ? Number(v.toFixed(digits)) : v ?? null);

const state = {
  ctx: null,
  mode: "idle", // idle | recording | running | live | long | pair | busy
  recording: null,
  recordingSession: null,
  runs: [],
  last: null,
  ratings: [],
  pair: null,
  live: null,
  long: null,
  sanasSeconds: 0,
  init: null,
  errors: [],
  log: [],
  playing: null,
};
window.__spike = { state, results: () => buildResults() };

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
  btnStopLive: () => state.mode === "live",
  btnLong: () => state.mode === "idle" && Boolean(state.recording),
  btnStopLong: () => state.mode === "long" && !state.long?.stopping,
  btnPair: () => state.mode === "idle",
  btnSaveJson: () => true,
  btnSaveWav: () => Boolean(state.last || state.recording),
};

function refreshButtons() {
  for (const [id, enabled] of Object.entries(BUTTONS)) $(id).disabled = !enabled();
  const mock = $("engine").value === "mock";
  for (const el of document.querySelectorAll(".mock-only")) el.classList.toggle("hidden", !mock);
  updateCost();
}

/**
 * Run an action from a button, errors shown in the status line. With a
 * `mode`, the page is in that mode while it runs and idle afterwards
 * (unless the action itself moved to another mode, like "live").
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

function settings() {
  return {
    engine: $("engine").value,
    modelName: $("model").value.trim() || "AT5.2",
    sampleRate: Number($("rate").value),
    jitterBufferTargetMs: numberOrUndefined("jitter") ?? null,
    mockDelayMs: $("engine").value === "mock" ? numberOrUndefined("mockDelay") ?? 300 : null,
    mockFailAfterSec: $("engine").value === "mock" ? numberOrUndefined("mockFail") ?? null : null,
    micLabel: $("mic").selectedOptions[0]?.textContent ?? "",
    outputLabel: $("out").selectedOptions[0]?.textContent ?? "",
  };
}

function currentEngine() {
  const s = settings();
  if (s.engine === "mock") return mockEngine({ delayMs: s.mockDelayMs, failAfterSec: s.mockFailAfterSec });
  return sanasEngine({ modelName: s.modelName, sampleRate: s.sampleRate, jitterBufferTargetMs: s.jitterBufferTargetMs ?? undefined });
}

/** Start an engine session and account for the Sanas time it keeps open. */
async function openSession(engine, input, onState) {
  const t0 = performance.now();
  const session = await engine.start({
    input,
    onState: (s, reason) => {
      log(`${engine.name}: ${s}${reason ? ` (${reason})` : ""}`);
      onState?.(s, reason);
    },
  });
  log(`${engine.name}: audio flowing after ${session.warmupMs} ms`);
  const stop = session.stop.bind(session);
  session.stop = async () => {
    await stop();
    if (engine.name === "sanas") state.sanasSeconds += (performance.now() - t0) / 1000;
    updateCost();
  };
  return session;
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
}

action("btnMic", "busy", async () => {
  const stream = await navigator.mediaDevices.getUserMedia(micConstraints(""));
  stream.getTracks().forEach((t) => t.stop());
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

action("btnRecord", null, async () => {
  const ctx = await ensureCtx();
  const stream = await navigator.mediaDevices.getUserMedia(micConstraints($("mic").value));
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
  state.recordingSession = { stream, source, rec, analyser, meter };
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
  r.stream.getTracks().forEach((t) => t.stop());
  state.recordingSession = null;
  state.recording = samples;
  const seconds = samples.length / state.ctx.sampleRate;
  const peak = peakDb(samples);
  $("recLevel").value = -60;
  $("recInfo").textContent = `${seconds.toFixed(1)} s recorded, peak ${peak.toFixed(1)} dBFS.`;
  if (peak > -0.5) setStatus("Recorded, but it clipped (too loud). Move the mic away a little and record again.", "warn");
  else if (peak < -30) setStatus("Recorded, but it is very quiet. Check the microphone choice and level, then record again.", "warn");
  else setStatus("Recorded. Now run it through the engine (step 3).", "ok");
});

// ---------- 3 · run through the engine ----------

/**
 * Play the recording into an open session at live speed and record what
 * went in and what came back, side by side. Returns audio + analysis.
 */
async function runOnce({ session, ctx, toEngine, fromEngine, onProgress, shouldStop = () => false }) {
  const rec = makeRecorder(ctx, 2);
  fromEngine.connect(rec.node, 0, 1);
  const buffer = ctx.createBuffer(1, state.recording.length, ctx.sampleRate);
  buffer.copyToChannel(state.recording, 0);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(toEngine);
  src.connect(rec.node, 0, 0);
  const stats = watchStats();
  rec.start();
  await sleep(150);
  src.start();
  const totalMs = buffer.duration * 1000 + TAIL_SEC * 1000;
  const t0 = performance.now();
  while (performance.now() - t0 < totalMs) {
    onProgress?.((performance.now() - t0) / totalMs);
    await sleep(100);
    if (shouldStop()) break; // stop asked, or the session dropped: analyse what we have
  }
  const [ref, sig] = await rec.stop();
  src.disconnect();
  fromEngine.disconnect(rec.node);
  rec.dispose();
  const webrtc = await stats.stop();
  const analysis = analyzeRun({ ref, sig, sampleRate: ctx.sampleRate });
  return { ref, sig, analysis, webrtc, engineState: session.getState() };
}

function summarize({ analysis: a, webrtc, engineState }, extra = {}) {
  return {
    at: new Date().toISOString(),
    ...extra,
    settings: settings(),
    ok: a.ok,
    reason: a.reason ?? null,
    engineStateAfter: engineState,
    delayMs: round(a.delayMs, 1),
    delayScore: round(a.delayScore, 3),
    delayMedianMs: round(a.delayMedianMs, 1),
    delayP95Ms: round(a.delayP95Ms, 1),
    delayMinMs: round(a.delayMinMs, 1),
    delayMaxMs: round(a.delayMaxMs, 1),
    gapCount: a.gapCount ?? null,
    gapMissingMs: round(a.gapMissingMs),
    longestGapMs: round(a.longestGapMs),
    gaps: (a.gaps ?? []).map((g) => ({ atSec: round(g.atSec, 2), silentMs: round(g.silentMs), missingSpeechMs: round(g.missingSpeechMs) })),
    levelDiffDb: round(a.levelDiffDb, 1),
    bandwidthRefHz: a.bandwidthRefHz,
    bandwidthSigHz: a.bandwidthSigHz,
    speechSec: round(a.speechSec, 1),
    durationSec: round(a.durationSec, 1),
    utterances: (a.utterances ?? []).map((u) => ({ startSec: round(u.startSec, 2), endSec: round(u.endSec, 2), lagMs: round(u.lagMs, 1), score: round(u.score, 2) })),
    webrtc: webrtc
      ? {
          rttMs: round(webrtc.rttMs, 1),
          jitterMs: round(webrtc.jitterMs, 1),
          jitterBufferMs: round(webrtc.jitterBufferMs, 1),
          packetLossPct: round(webrtc.packetLossPct, 2),
          concealedPct: round(webrtc.concealedPct, 2),
          codec: webrtc.codec,
          remote: webrtc.remote,
        }
      : null,
  };
}

function fmtKHz(hz) {
  return Number.isFinite(hz) ? `${(hz / 1000).toFixed(1)} kHz` : "–";
}

function renderRuns() {
  const body = $("runs").tBodies[0];
  body.replaceChildren(
    ...state.runs.map((r, i) => {
      const tr = document.createElement("tr");
      const cells = [
        String(i + 1),
        r.kind === "long" ? `${r.engine} (long)` : r.engine,
        r.settings.engine === "sanas" ? `${r.settings.sampleRate / 1000} kHz` : "–",
        r.ok ? String(Math.round(r.delayMs)) : r.reason ?? "failed",
        r.ok ? `${Math.round(r.delayMedianMs ?? NaN)} / ${Math.round(r.delayP95Ms ?? NaN)}` : "–",
        r.ok && r.gapCount != null ? `${r.gapCount} (${r.longestGapMs})` : "–",
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
        if ((c === 3 && r.ok && r.delayMs > 380) || (c === 5 && r.gapCount > 1) || (c === 3 && !r.ok)) td.className = "bad";
        tr.append(td);
      });
      return tr;
    }),
  );
}

action("btnRun", "running", async () => {
  const ctx = await ensureCtx();
  const engine = currentEngine();
  const toEngine = ctx.createMediaStreamDestination();
  toEngine.channelCount = 1;
  setStatus(`Starting ${engine.name}…`);
  const session = await openSession(engine, toEngine.stream);
  const fromEngine = ctx.createMediaStreamSource(session.outputStream);
  try {
    await sleep(500); // let audio settle before measuring
    setStatus(`Sending the recording through ${engine.name} at live speed…`);
    const result = await runOnce({
      session,
      ctx,
      toEngine,
      fromEngine,
      onProgress: (p) => ($("runProgress").value = p),
    });
    const summary = summarize(result, { kind: "script", engine: engine.name, warmupMs: session.warmupMs });
    state.runs.push(summary);
    state.last = { ref: result.ref, sig: result.sig, analysis: result.analysis, sampleRate: ctx.sampleRate };
    state.ratings = result.analysis.ok ? result.analysis.utterances.map(() => ({ natural: false, voice: false, words: false })) : [];
    renderRuns();
    renderUtterances();
    $("runProgress").value = 1;
    if (!summary.ok) setStatus(`Run finished, but: ${summary.reason}.`, "error");
    else {
      $("runInfo").textContent = `Delay ${Math.round(summary.delayMs)} ms, ${summary.gapCount} gap(s).`;
      setStatus(`Run ${state.runs.length} done: delay ${Math.round(summary.delayMs)} ms. Listen and rate below.`, "ok");
    }
  } finally {
    fromEngine.disconnect();
    toEngine.disconnect();
    await session.stop();
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
  const n = state.ratings.length;
  const good = state.ratings.filter((r) => r.natural && r.voice && r.words).length;
  $("score").textContent = n ? ((good / n) * 10).toFixed(1) : "–";
}

function renderUtterances() {
  const list = $("utts");
  const last = state.last;
  if (!last?.analysis?.ok) {
    list.replaceChildren();
    updateScore();
    return;
  }
  const { analysis, sampleRate } = last;
  const lagSec = analysis.delayMs / 1000;
  list.replaceChildren(
    ...analysis.utterances.map((u, i) => {
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
        box.checked = state.ratings[i]?.[key] ?? false;
        box.addEventListener("change", () => {
          state.ratings[i][key] = box.checked;
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

action("btnLive", null, async () => {
  const ctx = await ensureCtx();
  const mic = await navigator.mediaDevices.getUserMedia(micConstraints($("mic").value));
  const engine = currentEngine();
  state.mode = "live";
  refreshButtons();
  let session;
  try {
    setStatus(`Starting live ${engine.name}…`);
    session = await openSession(engine, mic, (s, reason) => {
      if (s === "failed") setStatus(`Live stopped working: ${reason || "connection lost"}. Press Stop.`, "error");
    });
  } catch (err) {
    mic.getTracks().forEach((t) => t.stop());
    state.mode = "idle";
    throw err;
  }
  const fromEngine = ctx.createMediaStreamSource(session.outputStream);
  fromEngine.connect(ctx.destination);
  const micNode = ctx.createMediaStreamSource(mic);
  const rec = makeRecorder(ctx, 2);
  micNode.connect(rec.node, 0, 0);
  fromEngine.connect(rec.node, 0, 1);
  rec.start();
  const stats = watchStats();
  const t0 = performance.now();
  const delays = [];
  const timer = setInterval(() => {
    const [ref, sig] = rec.recent(12);
    const est = ref.length > ctx.sampleRate * 4 ? estimateDelay(ref, sig, ctx.sampleRate) : null;
    if (est && est.score >= 0.3) delays.push(est.lagMs);
    const secs = ((performance.now() - t0) / 1000).toFixed(0);
    $("liveInfo").textContent = `${secs} s · ${engine.name} ${session.getState()} · delay ${est && est.score >= 0.3 ? `${Math.round(est.lagMs)} ms` : "– (speak)"}`;
  }, 3000);
  state.live = { mic, session, fromEngine, micNode, rec, stats, timer, t0, delays, engine: engine.name };
  setStatus("Live: speak. Press Stop when done.", "ok");
});

action("btnStopLive", "busy", async () => {
  const l = state.live;
  if (!l) return;
  clearInterval(l.timer);
  await l.rec.stop();
  l.rec.dispose();
  l.micNode.disconnect();
  l.fromEngine.disconnect();
  l.mic.getTracks().forEach((t) => t.stop());
  const webrtc = await l.stats.stop();
  await l.session.stop();
  state.live = null;
  const sorted = [...l.delays].sort((a, b) => a - b);
  state.runs.push({
    at: new Date().toISOString(),
    kind: "live",
    engine: l.engine,
    settings: settings(),
    ok: sorted.length > 0,
    reason: sorted.length ? null : "no speech detected",
    durationSec: round((performance.now() - l.t0) / 1000, 1),
    delayMs: sorted.length ? round(sorted[Math.floor(sorted.length / 2)], 1) : null,
    delayMedianMs: sorted.length ? round(sorted[Math.floor(sorted.length / 2)], 1) : null,
    delayP95Ms: sorted.length ? round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))], 1) : null,
    gapCount: null,
    longestGapMs: null,
    webrtc,
  });
  renderRuns();
  setStatus("Live stopped.", "ok");
});

// ---------- 6 · long stability run ----------

action("btnLong", "long", async () => {
  const minutes = Math.min(60, Math.max(1, numberOrUndefined("longMinutes") ?? 10));
  const ctx = await ensureCtx();
  const engine = currentEngine();
  const toEngine = ctx.createMediaStreamDestination();
  toEngine.channelCount = 1;
  const failures = [];
  let failedAt = null;
  let failReason = "";
  const onState = (s, reason) => {
    if (s === "failed" && failedAt == null) {
      failedAt = performance.now();
      failReason = reason || "failed";
    }
  };
  state.long = { stopNow: false, stopping: false };
  setStatus(`Long run: ${minutes} min through ${engine.name}…`);
  let session = await openSession(engine, toEngine.stream, onState);
  let fromEngine = ctx.createMediaStreamSource(session.outputStream);
  const loops = [];
  const t0 = performance.now();
  const endAt = t0 + minutes * 60000;
  try {
    await sleep(500);
    while (!state.long.stopNow && performance.now() < endAt) {
      if (failedAt != null) {
        const lostAt = failedAt;
        fromEngine.disconnect();
        await session.stop();
        try {
          session = await openSession(engine, toEngine.stream, onState);
          fromEngine = ctx.createMediaStreamSource(session.outputStream);
          failures.push({ atMin: round((lostAt - t0) / 60000, 2), reason: failReason, reconnectMs: Math.round(performance.now() - lostAt) });
        } catch (err) {
          failures.push({ atMin: round((lostAt - t0) / 60000, 2), reason: failReason, reconnectError: err.message });
          throw err;
        } finally {
          failedAt = null;
        }
        await sleep(500);
      }
      const result = await runOnce({
        session,
        ctx,
        toEngine,
        fromEngine,
        onProgress: () => ($("longProgress").value = Math.min(1, (performance.now() - t0) / (endAt - t0))),
        shouldStop: () => state.long.stopNow || failedAt != null,
      });
      const s = summarize(result, { kind: "loop", engine: engine.name, cutShortByDrop: failedAt != null });
      delete s.utterances;
      loops.push(s);
      $("longInfo").textContent = `${loops.length} loop(s), last delay ${s.ok ? Math.round(s.delayMs) : "–"} ms, ${failures.length} drop(s)`;
    }
  } finally {
    state.long.stopping = true;
    refreshButtons();
    fromEngine.disconnect();
    toEngine.disconnect();
    await session.stop();
  }
  if (failedAt != null) {
    // Dropped in the last loop: count it, though the run ended before a retry.
    failures.push({ atMin: round((failedAt - t0) / 60000, 2), reason: failReason, notRetried: true });
  }
  const good = loops.filter((l) => l.ok);
  const delays = good.map((l) => l.delayMs).sort((a, b) => a - b);
  const pick = (q) => (delays.length ? delays[Math.min(delays.length - 1, Math.floor(q * (delays.length - 1)))] : null);
  const summary = {
    at: new Date().toISOString(),
    kind: "long",
    engine: engine.name,
    settings: settings(),
    ok: good.length > 0,
    reason: good.length ? null : "no loop produced converted audio",
    minutes: round((performance.now() - t0) / 60000, 2),
    loops: loops.length,
    delayMs: pick(0.5),
    delayMedianMs: pick(0.5),
    delayP95Ms: pick(0.95),
    driftMs: good.length > 1 ? round(good.at(-1).delayMs - good[0].delayMs, 1) : null,
    gapCount: good.reduce((n, l) => n + (l.gapCount ?? 0), 0),
    longestGapMs: good.reduce((m, l) => Math.max(m, l.longestGapMs ?? 0), 0),
    gapsPerLoop: loops.map((l) => l.gapCount),
    loopsCutShortByDrop: loops.filter((l) => l.cutShortByDrop).length,
    failures,
    webrtc: loops.at(-1)?.webrtc ?? null,
    warmupMs: null,
  };
  state.runs.push(summary);
  state.long = null;
  $("longProgress").value = 1;
  renderRuns();
  setStatus(
    `Long run done: ${summary.loops} loops, ${summary.gapCount} gap(s), ${failures.length} drop(s), delay median ${Math.round(summary.delayMs ?? NaN)} ms.`,
    failures.length || summary.gapCount > summary.loops ? "warn" : "ok",
  );
});

action("btnStopLong", null, () => {
  if (state.long) {
    state.long.stopNow = true;
    state.long.stopping = true;
    setStatus("Stopping after the current loop…");
  }
});

// ---------- 7 · device pair ----------

action("btnPair", "pair", async () => {
  const ctx = await ensureCtx();
  const otherId = $("pairDevice").value;
  const otherLabel = $("pairDevice").selectedOptions[0]?.textContent ?? "";
  const a = await navigator.mediaDevices.getUserMedia(micConstraints($("mic").value));
  let b;
  try {
    b = await navigator.mediaDevices.getUserMedia(micConstraints(otherId));
  } catch (err) {
    a.getTracks().forEach((t) => t.stop());
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
    a.getTracks().forEach((t) => t.stop());
    b.getTracks().forEach((t) => t.stop());
  }
  const [ref, sig] = recorded;
  const r = analyzeRun({ ref, sig, sampleRate: ctx.sampleRate });
  state.pair = {
    at: new Date().toISOString(),
    device: otherLabel,
    ok: r.ok,
    reason: r.reason ?? null,
    delayMs: round(r.delayMs, 1),
    score: round(r.delayScore, 3),
    levelDiffDb: round(r.levelDiffDb, 1),
    gapCount: r.gapCount ?? null,
  };
  $("pairInfo").textContent = r.ok
    ? `${otherLabel}: ${Math.round(r.delayMs)} ms later than your microphone (match ${r.delayScore.toFixed(2)}).`
    : `Could not measure: ${r.reason}.`;
  setStatus(r.ok ? "Measured." : `Could not measure: ${r.reason}.`, r.ok ? "ok" : "warn");
});

// ---------- 8 · save ----------

function buildResults() {
  const minutes = state.sanasSeconds / 60;
  return {
    tool: "accent-switch spike",
    schema: 1,
    createdAt: new Date().toISOString(),
    browser: navigator.userAgent,
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
    script: $("script").value,
    runs: state.runs,
    rating: {
      score10: state.ratings.length ? round((state.ratings.filter((r) => r.natural && r.voice && r.words).length / state.ratings.length) * 10, 1) : null,
      perUtterance: state.ratings,
      notes: $("notes").value,
    },
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
  state.live?.session.stop();
  disconnectSanas();
});

$("script").value = DEFAULT_SCRIPT;
if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
  setStatus("Open this page as http://localhost:8080/spike/ (not by IP or file): the browser only allows the microphone there.", "error");
} else {
  setStatus("Ready. Start with “Allow microphone”.", "info");
  listDevices().catch(() => {});
}
refreshButtons();
