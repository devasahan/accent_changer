/**
 * The Session B checks of what the meeting hears through VB-CABLE.
 *
 *  - measureDelay(): "Measure the delay", the Gate 1 "passthrough ≤ 120 ms"
 *    method. Three inputs are recorded together for 12 s: a fresh source of
 *    the microphone (its buffer starts empty), CABLE Output, and micBus (the
 *    passthrough's own source, after its buffer). The delay is fresh source →
 *    CABLE Output; fresh source → micBus, sample for sample, is how much delay
 *    the passthrough's own buffer has gathered since the app started.
 *  - startLong(): "Record CABLE Output", the long check. A worklet
 *    (ac-cablewatch) listens to CABLE Output for an hour or more and sends a
 *    summary every second: the test tone's clicks, gaps and volume (tone
 *    mode), or loudness envelopes for a speech analysis at the end (mic
 *    mode). Every 2 minutes a 1 s reading measures the microphone's buffer,
 *    whose slope is the microphone's clock against VB-CABLE's. The phases of
 *    the window (open, minimized, hidden), the app's own recoveries and any
 *    pause in rendering are kept with it.
 *  - hideFor(): hide the window for 30 minutes. A long check that runs then
 *    goes on until 2 minutes after the window is back.
 *
 * Where it records. On the context route the graph's own context runs on
 * VB-CABLE's clock, so the checks record there (through graph.addTap, under
 * the graph's lock), and CABLE Output is heard without another clock
 * crossing. On the audio element route they record in a context of their own
 * whose sink is CABLE Input. micBus is not reachable there, so the
 * microphone's buffer is not measured on that route. If that context cannot
 * use CABLE Input, they record in the graph's context and say that the
 * recording adds its own clock crossing.
 *
 * Time. What the checks count comes from the worklets' frames, never from a
 * main-thread timer, so a hidden or busy window cannot change it. Each
 * summary carries the worklet's own clock stamp (Date.now() on the audio
 * thread): a pause in rendering shows (frames stop while time goes on), a
 * late message does not. Main-thread timers are backstops and diagnostics
 * only.
 *
 * Nothing touches the page when this module is imported. Logs carry codes
 * and numbers only: no device names, no ids, no texts.
 */
import { analyzeRun } from "../core/delay-estimate.js";
import {
  LIMITS,
  analyzeSpeech,
  classifyZeroRuns,
  delayVerdict,
  formatClock,
  frameClock,
  longVerdict,
  micClock,
  micHoleCount,
  phaseTimeline,
  renderPauses,
  sampleLag,
  stopAfterHide,
} from "../core/cable-check.js";
import { openCableOutput, stopStream } from "./devices.js";

const SAMPLE_RATE = 48000;
const FRAMES_PER_MS = 48;
const CHUNK_FRAMES = 4800; // the recorder's chunks: 100 ms
const SUMMARY_FRAMES = 48000; // the cable watcher's summaries: 1 s
const ENV_HOP_FRAMES = 240; // one 5 ms envelope frame
const ENV_FRAMES_PER_SEC = 200;
const READING_FRAMES = 48000; // a 1 s reading of the microphone's buffer
const READING_FIRST = 2; // the first reading starts at the 2nd summary …
const READING_EVERY = 120; // … then every 120 summaries (about 2 minutes)
const POLL_EVERY = 5; // the window's state is asked for every 5th summary (about 5 s)
const TICK_MS = 1000; // the diagnostic timer
const LATE_TICK_MS = 1000; // a tick this late is counted
const BUILD_LIMIT_MS = 4000; // a worklet load under the graph's lock (the graph gives up after 5 s)
const FIRST_BUILD_MS = 10000; // how long startLong waits for its first recorder
const READING_LIMIT_MS = 15000; // a 1 s reading that takes longer is given up
const DONE_WAIT_MS = 3000; // how long a stop waits for the watcher's last summary
const GRAPH_WAIT_MS = 3000; // how long a test-source change or a tap removal is waited for
const END_GRACE_MS = 30000; // a long check not over this long after its end is ended by the backstop
const DELAY_SLACK_MS = 15000; // a delay recording not over this long after its length is given up
const SINK_LIMIT_MS = 5000;
const MAX_CAPTURE_MS = 1000; // a microphone's capture latency above this is a broken reading
const AFTER_HIDE_MS = 250; // the window's state is asked for again this long after a Hide's planned end
// Zero runs that start within the first 100 ms of a watcher and last less than 100 ms come from its
// source nodes starting up (their buffers start empty), not from the sound.
const PRIME_FRAMES = 4800;
// The microphone's 10 ms holes do not count in the first 10 s of a watcher or of a new microphone
// source: a new source starts with an almost empty buffer (as graph.js's micHolesTotal).
const SETTLE_FRAMES = 10 * SAMPLE_RATE;
const MAX_RUNS = 1000;
const MAX_EVENTS = 1000;
const NEAR_MS = 2000; // a gap this close to a change of Windows' default playback device is listed with it
// Around an outage (from 1 s before it to 2 s after it) the sound's buffers settle: clicks and holes there
// belong to the outage, which is counted once, by itself.
const SHADOW_BEFORE_MS = 1000;
const SHADOW_AFTER_MS = 2000;
const MIN_MINUTES = 0.25;
const MAX_MINUTES = 120;
const EXTRA_MINUTES = LIMITS.EXTEND_MAX_SEC / 60; // room in the envelope arrays for a Hide's extension

/** Texts the page shows (plain English, no device names). */
export const CHECK_TEXTS = Object.freeze({
  notRunning: "The checks need your voice going into “CABLE Input” first: wait until step 2 is green, then try again.",
  noCableOutput: "“CABLE Output” is not among the microphones: is VB-CABLE installed?",
  noMic: "The microphone is not running, so it can't be recorded. Press “Check the microphone”, then try again.",
  busy: "Another check is running. Wait until it has finished.",
  restarted: "The audio was restarted during the measurement: press the button again.",
  noStart: "The recorder did not start. Press the button again.",
  stalled: "The recording stopped before the end. Press the button again.",
  cableEnded: "“CABLE Output” stopped recording. Press the button again.",
  minutes: "The long check runs for 0.25 to 120 minutes.",
  longNoStart: "The long check could not start its recorder. Try again; if it keeps failing, restart the app.",
  ownCrossing: "The recording adds its own clock crossing: it could not run on VB-CABLE's clock.",
  routeChanged: "The output route changed during the check, so part of the recording adds its own clock crossing.",
  toneLost: "The test tone stopped (Windows' default playback device went away or failed), so the check ended early.",
  cableLost: "“CABLE Output” stopped recording (did Windows Audio restart?), so the check ended early.",
  rebuildFailed: "The check's recorder could not be added again after the audio was restarted, so the check ended early.",
  ownFailed: "The check's own audio engine stopped, so the check ended early.",
  voiceStopped: "The voice was stopped, so the check ended early.",
  notBack: "The recording stopped before the end of the check, so the check ended early.",
  defaultOutput: "Windows switched its default playback device",
  analysing: (sec) => `Analysing (about ${sec} s)…`,
  runsFull: (sec) => `Too many runs of digital silence to keep them all: drop-outs were checked for the first ${formatClock(sec)} only.`,
  defaultOutputGap: (atSec) => `The sound stopped at ${formatClock(atSec)} when Windows switched its default playback device.`,
  notAnalysed: (name) => `The check could not be analysed (${name}).`,
});

const NOOP_HANDLE = Object.freeze({ dispose() {} });

/** Where ToneCheck's counts count each kind of event. */
const COUNT_KEYS = Object.freeze({
  hole: "holes",
  skip: "skips",
  click: "clicks",
  dropout: "dropouts",
  gap: "gaps",
  step: "steps",
  noise: "noises",
});

/** Worklet files, next to this module (the same path in Edge dev mode and in the app). */
const workletUrl = (file) => new URL(`./worklets/${file}`, import.meta.url).href;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const round = (x, digits = 1) => {
  if (!isNum(x)) return null;
  const k = 10 ** digits;
  return Math.round(x * k) / k;
};

function nameOf(err) {
  return err && typeof err === "object" && typeof err.name === "string" && err.name ? err.name : "Error";
}

/** An Error with a name (the page shows its message). */
function named(name, message) {
  const e = new Error(message);
  e.name = name;
  return e;
}

/** A promise that can be settled from outside; a rejection nobody waits for is not a page error. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** `promise`, or a TimeoutError after `ms`; the timer never outlives it. */
function limit(promise, ms, what = "It") {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(named("TimeoutError", `${what} did not answer within ${Math.round(ms / 1000)} s.`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** One render task later: the page gets a chance to paint before a long piece of work. */
async function yieldToPage() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function disconnectAll(wires) {
  for (const [from, to] of wires ?? []) {
    try {
      if (to === undefined) from.disconnect();
      else from.disconnect(to);
    } catch {
      // Not connected any more (or its context is closed).
    }
  }
}

function closeQuietly(ctx) {
  if (!ctx || ctx.state === "closed") return;
  try {
    ctx.close().catch(() => {});
  } catch {
    // Already closing.
  }
}

/** The chunks of one input as one array of exactly `frames` samples (zeros where nothing came). */
function concat(list, frames) {
  const out = new Float32Array(frames);
  let at = 0;
  for (const a of list) {
    if (at >= frames) break;
    const n = Math.min(a.length, frames - at);
    out.set(n === a.length ? a : a.subarray(0, n), at);
    at += n;
  }
  return out;
}

/**
 * The capture latency of a microphone track in ms (1 decimal), or null.
 * track.stats (Chromium 125 and later) gives it in ms, like every
 * DOMHighResTimeStamp: its averageLatency (steadier), else its latency. 0
 * there means no frames were delivered yet. Without a usable reading,
 * getSettings().latency, which is in seconds. A value above MAX_CAPTURE_MS is
 * not a capture latency and is not used.
 */
export function captureLatencyMs(track) {
  if (!track) return null;
  const usable = (ms) => isNum(ms) && ms >= 0 && ms <= MAX_CAPTURE_MS;
  try {
    const stats = track.stats;
    for (const ms of [stats?.averageLatency, stats?.latency]) {
      if (usable(ms) && ms > 0) return round(ms, 1);
    }
  } catch {
    // No stats on this track.
  }
  try {
    const sec = track.getSettings?.()?.latency;
    if (isNum(sec) && usable(sec * 1000)) return round(sec * 1000, 1);
  } catch {
    // No settings either.
  }
  return null;
}

/** "context" and "context-after-permission" play from the graph's own context into the cable. */
const isContextRoute = (method) => typeof method === "string" && method.startsWith("context");

/** ISO time of an epoch ms (now when it is not a number). */
const isoOf = (epochMs) => new Date(isNum(epochMs) ? epochMs : Date.now()).toISOString();

/** The epoch ms of a performance.now() time. */
const epochOf = (perfMs) => Date.now() + (perfMs - performance.now());

/** At most `n` items, spread evenly over the list, the first and the last kept. */
function thin(items, n) {
  if (items.length <= n) return items.slice();
  const out = [];
  for (let i = 0; i < n; i++) out.push(items[Math.round((i * (items.length - 1)) / (n - 1))]);
  return out;
}

/**
 * One ac-recorder run: `inputs` inputs for `frames` frames, in a context the
 * caller gives (a graph tap's, or a context of the check's own). Its promise
 * resolves with one Float32Array per input, each exactly `frames` long, or
 * rejects with the error fail() was given. onFrames(framesSoFar) is called
 * on every chunk.
 */
class Recording {
  constructor({ inputs, frames, onFrames = null }) {
    this.inputs = inputs;
    this.frames = frames;
    this.onFrames = onFrames;
    this.parts = Array.from({ length: inputs }, () => []);
    this.got = 0;
    this.node = null;
    this.ctx = null;
    this.wires = [];
    this.started = false;
    this.stopping = false;
    this.settled = false;
    this.latencies = { outputLatencyMs: null, baseLatencyMs: null };
    const d = deferred();
    this.promise = d.promise;
    this._resolve = d.resolve;
    this._reject = d.reject;
  }

  /** Load the worklet into ctx, make the node, wire its inputs (wire(node) → [[from, to], …]) and start. */
  async build(ctx, wire) {
    if (this.settled) return false;
    await limit(ctx.audioWorklet.addModule(workletUrl("recorder.worklet.js")), BUILD_LIMIT_MS, "The recorder");
    if (this.settled) return false;
    const node = new AudioWorkletNode(ctx, "ac-recorder", {
      numberOfInputs: this.inputs,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
      processorOptions: { chunkFrames: CHUNK_FRAMES },
    });
    this.node = node;
    this.ctx = ctx;
    try {
      this.wires = wire(node) ?? [];
    } catch (err) {
      this.dispose();
      throw err;
    }
    node.port.onmessage = (e) => this._message(e.data);
    node.port.postMessage("start");
    return true;
  }

  _message(m) {
    if (this.settled || !m) return;
    if (m.type === "chunk" && Array.isArray(m.parts)) {
      this.started = true;
      m.parts.forEach((p, i) => {
        if (i < this.inputs) this.parts[i].push(p);
      });
      this.got += m.parts[0]?.length ?? 0;
      try {
        this.onFrames?.(Math.min(this.got, this.frames));
      } catch {
        // The page's own problem.
      }
      if (this.got >= this.frames && !this.stopping) {
        this.stopping = true;
        this.node.port.postMessage("stop");
      }
    } else if (m.type === "stopped" && this.stopping) {
      this._readLatencies();
      this.settled = true;
      const out = this.parts.map((list) => concat(list, this.frames));
      this.parts = [];
      this.dispose();
      this._resolve(out);
    }
  }

  _readLatencies() {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      this.latencies = {
        outputLatencyMs: isNum(ctx.outputLatency) ? round(ctx.outputLatency * 1000, 1) : null,
        baseLatencyMs: isNum(ctx.baseLatency) ? round(ctx.baseLatency * 1000, 1) : null,
      };
    } catch {
      // Not readable: they stay null.
    }
  }

  /** The run ends with this error (nothing happens when it has ended already). */
  fail(err) {
    if (this.settled) return;
    this.settled = true;
    this.parts = [];
    this.dispose();
    this._reject(err);
  }

  /**
   * Disconnect the recorder (it may be called again). One that was never told
   * to stop is told now: until then its processor goes on running in its
   * context, however long that context lives.
   */
  dispose() {
    disconnectAll(this.wires);
    this.wires = [];
    const node = this.node;
    if (!node) return;
    node.port.onmessage = null;
    if (!this.stopping) {
      this.stopping = true;
      try {
        node.port.postMessage("stop");
      } catch {
        // Its context is gone, and the processor with it.
      }
    }
    disconnectAll([[node]]);
  }
}

/** The long check's tone, recordings and analysis; Checks.startLong makes one. */
class LongCheck {
  constructor(owner, { mode, minutes, onProgress }) {
    this.owner = owner;
    this.graph = owner._graph;
    this.monitor = owner._monitor;
    this.platform = owner._platform;
    this.mode = mode;
    this.minutes = minutes;
    this.onProgress = typeof onProgress === "function" ? onProgress : null;
    this.plannedEndSec = minutes * 60;
    this.endSec = this.plannedEndSec;
    this.extendedToSec = null;
    this.at = new Date().toISOString();
    this.t0Ms = performance.now();
    this.startMs = null; // the worklet's own time of the first frame watched (page timeline)
    this.route = this.graph.output?.method ?? null;
    // "element": forced onto the audio element under Advanced (README step 7.6), a comparison Gate 1 lists, not counts.
    this.routePreference = this.graph.output?.routePreference ?? "auto";
    this.contextRoute = isContextRoute(this.route);
    this.site = null;
    this.ownCtx = null;
    this.cable = null;
    this.tone = null;
    this.testSourceSet = false;
    this.micRenewed = false; // the tone check gave micBus a new microphone source (its buffer empty) at its start
    this.removeTap = null;

    this.segments = [];
    this.current = null;
    this.sync = []; // [{frame, producedMs, wallMs}], one per summary, frames on one timeline
    this.lastSync = null;
    this.marks = [];
    this.lastPhase = null;

    this.events = [];
    this.eventsDropped = 0;
    this.locked = false;
    this.levelDb = null;
    this.refRuns = [];
    this.sigRuns = [];
    this.runsFullAt = null;
    this.runsDropped = 0;
    this.micHoleRuns = []; // the microphone's 10 ms holes, on the check's timeline
    this.micHolesOver = 0; // holes beyond MAX_RUNS (counted, not kept)
    this.micDropRuns = []; // the microphone's drop-outs (DROPOUT_MS up to GAP_MS), on the check's timeline
    this.micDropsOver = 0; // drop-outs beyond MAX_RUNS (counted, not kept)
    this.settling = []; // [fromFrame, toFrame): the microphone's holes and drop-outs do not count there
    this.lastMicGen = this.graph.micGen;
    this.envRef = null;
    this.envSig = null;
    this.envFrames = 0;

    this.summaries = 0;
    this.readings = [];
    this.readingsFailed = 0;
    this.reading = null;

    this.outages = [];
    this.openOutage = null;
    this.recoveries = 0;
    this.rebuiltSinceUp = false;
    this.routeNoted = false;
    this.defaultOutputs = [];
    this.lastDefaultOutput = typeof this.graph.snapshot?.defaultOutputLabel === "string" ? this.graph.snapshot.defaultOutputLabel : null;

    this.ticks = [];
    this.timer = null;
    this.hidePollTimer = null;
    this.nextTickMs = null;
    this.underruns = [];
    this.anyStats = false;

    this.notes = [];
    this.earlyEnd = null;
    this.finished = false;
    this.finishing = null;
    this.listeners = new AbortController();
    this.firstBuild = deferred();
    this.builtOnce = false;
    this.lastProgress = null;
    this.result = deferred(); // resolves with the LongResult once the check has ended (never rejects)
  }

  get stopFrame() {
    return Math.round(this.endSec * SAMPLE_RATE);
  }

  /** The time the check's frame 0 stands for (page timeline). */
  get originMs() {
    return this.startMs ?? this.t0Ms;
  }

  // ---------------------------------------------------------------- start

  async begin() {
    const graph = this.graph;
    const signal = this.listeners.signal;
    // The check can be ended while it starts (its tone lost, CABLE Output gone, the page going away): stop there.
    const alive = () => {
      if (this.finished) throw named("AbortError", this.earlyEnd?.note ?? CHECK_TEXTS.longNoStart);
    };
    try {
      if (this.mode === "tone") {
        this.tone = await this.monitor.toneStream();
        this.tone.onLost(() => this.end(CHECK_TEXTS.toneLost, "tone-lost"));
        alive();
      }
      this.cable = await openCableOutput(graph.snapshot);
      this.cable.track.addEventListener("ended", () => this.end(CHECK_TEXTS.cableLost, "cable-ended"), { signal });
      alive();
      if (this.mode === "mic") {
        const size = Math.ceil((this.minutes + EXTRA_MINUTES) * 60 * ENV_FRAMES_PER_SEC) + 400;
        this.envRef = new Float32Array(size).fill(-120);
        this.envSig = new Float32Array(size).fill(-120);
      }
      if (!this.contextRoute) {
        this.ownCtx = await this.owner._ownContext();
        alive();
        if (!this.ownCtx) this.note(CHECK_TEXTS.ownCrossing);
      }
      this.site = this.ownCtx ? "own-context" : "graph";

      graph.addEventListener("recovery", (ev) => this.onRecovery(ev.detail), { signal });
      graph.addEventListener("rebuilt", () => {
        this.rebuiltSinceUp = true;
      }, { signal });
      graph.addEventListener("devices", (ev) => this.onDevices(ev.detail), { signal });
      graph.addEventListener("mic", () => this.followMic(), { signal });
      globalThis.document?.addEventListener?.("visibilitychange", () => this.markVisibility(), { signal });
      this.markVisibility();
      this.poll();

      if (this.tone) {
        this.testSourceSet = true;
        await limit(graph.setTestSource(this.tone.stream), GRAPH_WAIT_MS, "The test tone").catch(() => {});
        alive();
        if (this.site === "graph" && typeof graph.renewMicSource === "function") {
          // The microphone's buffer may have filled long before the check (H1): a new source starts it empty, so
          // the readings below measure the microphone's clock from here. The meeting hears the tone now.
          this.micRenewed = await limit(graph.renewMicSource(), GRAPH_WAIT_MS, "The microphone source").catch(() => false);
          this.lastMicGen = graph.micGen;
          alive();
        }
      }
      if (this.ownCtx) {
        await this.buildOwn();
      } else {
        this.removeTap = graph.addTap((info) => this.buildTap(info));
      }
      await limit(this.firstBuild.promise, FIRST_BUILD_MS, "The long check's recorder").catch((err) => {
        throw nameOf(err) === "TimeoutError" ? named("TimeoutError", CHECK_TEXTS.longNoStart) : err;
      });
      alive();
      this.tick();
      this.log("info", `check long start ${this.mode} ${this.minutes} min ${this.route ?? "-"} ${this.site}`);
    } catch (err) {
      this.finished = true;
      this.listeners.abort();
      await this.teardown();
      throw err;
    }
  }

  /** A new segment: one watcher node, from a build until its generation ends. */
  newSegment(generation) {
    const estimate = this.framesNow();
    const seg = {
      index: this.segments.length,
      generation,
      offset: null, // its frame 0 on the check's timeline, known from its first summary
      estimate, // the same, guessed when it was built
      stopAfter: Math.max(0, this.stopFrame - estimate),
      ctx: null,
      node: null,
      wires: [],
      micStream: null,
      fresh: null,
      frames: 0,
      refZeroFrames: 0,
      counts: null,
      lockDb: null,
      minStableDb: null,
      phaseDriftPpm: null,
      lastStats: null,
      ended: false,
      done: false,
      stopSent: false,
      doneSignal: deferred(),
    };
    this.segments.push(seg);
    return seg;
  }

  /** The check's frames so far, estimated now: the last summary plus the time since it was made. */
  framesNow() {
    if (!this.lastSync) return 0;
    const since = Math.max(0, performance.now() - this.lastSync.producedMs);
    return this.lastSync.frame + Math.round(since * FRAMES_PER_MS);
  }

  watcherOptions(seg) {
    return {
      numberOfInputs: 2,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
      processorOptions: { mode: this.mode, stopAfterFrames: seg.stopAfter, summaryFrames: SUMMARY_FRAMES },
    };
  }

  /** The graph's tap: a watcher in the graph's context (micBus → input 0, CABLE Output → input 1). */
  async buildTap({ ctx, micBus, generation, route }) {
    if (this.finished) return NOOP_HANDLE;
    const seg = this.newSegment(generation);
    if (seg.stopAfter <= 0) {
      // The check's end passed while the voice was out: nothing more to record.
      this.dropSegment(seg);
      queueMicrotask(() => this.end(null, "end"));
      return NOOP_HANDLE;
    }
    try {
      await limit(ctx.audioWorklet.addModule(workletUrl("cablewatch.worklet.js")), BUILD_LIMIT_MS, "The long check's recorder");
      if (this.finished) {
        this.dropSegment(seg);
        return NOOP_HANDLE;
      }
      // Kept at once: a node that is made and then cannot be wired must still be told to stop.
      const node = new AudioWorkletNode(ctx, "ac-cablewatch", this.watcherOptions(seg));
      seg.ctx = ctx;
      seg.node = node;
      const cableSource = ctx.createMediaStreamSource(this.cable.stream);
      seg.wires = [
        [micBus, node],
        [cableSource, node],
      ];
      micBus.connect(node, 0, 0);
      cableSource.connect(node, 0, 1);
      node.port.onmessage = (e) => this.message(seg, e.data);
    } catch (err) {
      this.buildFailed(seg, err);
      throw err;
    }
    // A check that began on VB-CABLE's clock (the context route) and is rebuilt on the audio element route
    // records from then on across a clock crossing of its own. One that began on the element route and
    // records here says so from the start (CHECK_TEXTS.ownCrossing).
    if (this.contextRoute && route && !isContextRoute(route.method) && !this.routeNoted) {
      this.routeNoted = true;
      this.note(CHECK_TEXTS.routeChanged);
    }
    this.segmentReady(seg);
    return { dispose: (info) => this.segmentGone(seg, info) };
  }

  /** The audio element route: one watcher in the check's own context, for the whole check. */
  async buildOwn() {
    const ctx = this.ownCtx;
    const signal = this.listeners.signal;
    const seg = this.newSegment(null);
    try {
      await limit(ctx.audioWorklet.addModule(workletUrl("cablewatch.worklet.js")), BUILD_LIMIT_MS, "The long check's recorder");
      const node = new AudioWorkletNode(ctx, "ac-cablewatch", this.watcherOptions(seg));
      seg.ctx = ctx;
      seg.node = node;
      const cableSource = ctx.createMediaStreamSource(this.cable.stream);
      seg.wires = [[cableSource, node]];
      cableSource.connect(node, 0, 1);
      this.connectFresh(seg, this.graph.micStream);
      node.port.onmessage = (e) => this.message(seg, e.data);
    } catch (err) {
      this.buildFailed(seg, err);
      throw err;
    }
    ctx.addEventListener("statechange", () => {
      if (ctx.state === "closed") this.end(CHECK_TEXTS.ownFailed, "own-context");
      else if (ctx.state === "suspended" || ctx.state === "interrupted") ctx.resume().catch(() => this.end(CHECK_TEXTS.ownFailed, "own-context"));
    }, { signal });
    ctx.addEventListener("error", () => this.end(CHECK_TEXTS.ownFailed, "own-context"), { signal });
    if (ctx.state !== "running") ctx.resume().catch(() => {});
    this.segmentReady(seg);
  }

  /** The own context's input 0: a fresh source of the microphone stream (a new one when the graph swaps it). */
  connectFresh(seg, stream) {
    if (seg.fresh) {
      disconnectAll([[seg.fresh, seg.node]]);
      seg.fresh = null;
    }
    seg.micStream = stream ?? null;
    if (!stream || !seg.ctx || !seg.node) return;
    seg.fresh = seg.ctx.createMediaStreamSource(stream);
    seg.fresh.connect(seg.node, 0, 0);
  }

  followMic() {
    const seg = this.current;
    if (this.finished || this.site !== "own-context" || !seg || seg.ended) return;
    const stream = this.graph.micStream;
    if (stream && stream !== seg.micStream) {
      try {
        this.connectFresh(seg, stream);
      } catch (err) {
        this.log("warn", `check long mic follow failed ${nameOf(err)}`);
      }
    }
  }

  segmentReady(seg) {
    this.current = seg;
    if (!this.builtOnce) {
      this.builtOnce = true;
      this.firstBuild.resolve();
    }
  }

  /** A segment that never recorded (by identity: two builds can overlap when the graph gave up waiting for one). */
  dropSegment(seg) {
    this.segments = this.segments.filter((s) => s !== seg);
  }

  buildFailed(seg, err) {
    this.dropSegment(seg);
    this.retire(seg);
    this.log("warn", `check long recorder failed ${nameOf(err)}`);
    if (!this.builtOnce) this.firstBuild.reject(err);
    else this.end(CHECK_TEXTS.rebuildFailed, "rebuild-failed");
  }

  /** The graph ended the segment's generation (a rebuild), or the check removed its tap. */
  segmentGone(seg, info) {
    if (seg.ended) return;
    seg.ended = true;
    this.retire(seg);
    seg.doneSignal.resolve();
    if (this.current === seg) this.current = null;
    if (info?.generationEnded) this.log("info", `check long recorder cut by a rebuild at ${Math.round(this.framesNow() / SAMPLE_RATE)} s`);
  }

  /**
   * The segment's watcher off the graph, its messages no longer heard. One
   * that has not finished is told to stop: until then its processor goes on
   * running in its context, however long that context lives (the voice's
   * own, on the context route).
   */
  retire(seg) {
    disconnectAll(seg.wires);
    seg.wires = [];
    if (seg.fresh) {
      disconnectAll([[seg.fresh]]);
      seg.fresh = null;
    }
    if (!seg.node) return;
    seg.node.port.onmessage = null;
    this.stopWatcher(seg);
  }

  /** Ask the segment's watcher to stop (once): it sends its last summary and "done", then does nothing more. */
  stopWatcher(seg) {
    if (!seg.node || seg.done || seg.stopSent) return;
    seg.stopSent = true;
    try {
      seg.node.port.postMessage("stop");
    } catch {
      // Its context is gone, and the processor with it.
    }
  }

  // ---------------------------------------------------------------- what the watcher says

  message(seg, m) {
    if (seg.ended || !m) return;
    if (m.type === "summary") {
      this.summary(seg, m);
    } else if (m.type === "done") {
      seg.done = true;
      seg.doneSignal.resolve();
      if (!this.finished) this.end(null, "end");
    }
  }

  summary(seg, m) {
    const wallMs = performance.now();
    const produced = isNum(m.producedEpochMs) ? m.producedEpochMs - (Date.now() - wallMs) : wallMs;
    const local = isNum(m.frame) ? m.frame : 0;
    if (seg.offset === null) this.anchor(seg, local, produced);
    const frame = seg.offset + local;
    // Points stay in order even if the system clock stepped back (renderPauses sorts nothing).
    if (this.lastSync && frame < this.lastSync.frame) return;
    this.sync.push({ frame, producedMs: produced, wallMs });
    this.lastSync = { frame, producedMs: produced };
    seg.frames = local;
    seg.refZeroFrames = isNum(m.refZeroFrames) ? m.refZeroFrames : seg.refZeroFrames;
    this.checkMicGen(frame);
    if (m.tone) this.toneSummary(seg, m.tone);
    if (m.env) this.envSummary(seg, m.env);
    this.takeRuns(seg, m);
    this.playback(seg, wallMs);
    this.summaries++;
    if (this.finished) return;
    if (this.summaries % POLL_EVERY === 0) this.poll();
    const due = this.summaries === READING_FIRST || (this.summaries > READING_FIRST && (this.summaries - READING_FIRST) % READING_EVERY === 0);
    if (due) this.startReading(produced);
    this.progress(frame, wallMs);
  }

  /**
   * A segment's first summary puts its frame 0 on the check's timeline: as
   * many frames after the last summary of the one before as time went by
   * (the worklets' own stamps). So the time without a watcher (a rebuild's
   * outage) is never taken for a pause in rendering: the outage counts from
   * its recovery record instead.
   */
  anchor(seg, local, produced) {
    const segStart = produced - local / FRAMES_PER_MS;
    if (this.lastSync) {
      const later = Math.round((segStart - this.lastSync.producedMs) * FRAMES_PER_MS);
      seg.offset = this.lastSync.frame + Math.max(0, later);
    } else {
      seg.offset = 0;
      this.startMs = segStart;
    }
    // The check's end in this segment's own frames (its build only guessed its offset).
    const want = Math.max(this.stopFrame - seg.offset, local);
    if (seg.node && Math.abs(want - seg.stopAfter) > CHUNK_FRAMES / 10) {
      seg.stopAfter = want;
      seg.node.port.postMessage({ type: "extend", stopAfterFrames: want });
    }
  }

  checkMicGen(frame) {
    const gen = this.graph.micGen;
    if (gen === this.lastMicGen) return;
    this.lastMicGen = gen;
    // The change happened since the last summary (at most a second ago).
    this.settling.push([frame - SUMMARY_FRAMES, frame + SETTLE_FRAMES]);
  }

  toneSummary(seg, t) {
    seg.counts = t.counts && typeof t.counts === "object" ? t.counts : seg.counts;
    if (isNum(t.lockDb) && seg.lockDb === null) seg.lockDb = t.lockDb;
    if (isNum(t.minStableDb)) seg.minStableDb = t.minStableDb;
    if (isNum(t.phaseDriftPpm)) seg.phaseDriftPpm = t.phaseDriftPpm;
    this.locked = t.locked === true;
    this.levelDb = isNum(t.levelDb) ? t.levelDb : null;
    for (const e of Array.isArray(t.events) ? t.events : []) {
      if (!e || !isNum(e.atFrame)) continue;
      if (this.events.length >= MAX_EVENTS) {
        this.eventsDropped++;
        continue;
      }
      this.events.push({ ...e, atFrame: seg.offset + e.atFrame });
    }
  }

  envSummary(seg, env) {
    if (!this.envRef || !env.ref || !env.sig) return;
    const base = Math.round(seg.offset / ENV_HOP_FRAMES) + (isNum(env.frame0) ? env.frame0 : 0);
    const size = this.envRef.length;
    const n = Math.min(env.ref.length, env.sig.length);
    for (let i = 0; i < n; i++) {
      const at = base + i;
      if (at < 0 || at >= size) continue;
      this.envRef[at] = env.ref[i];
      this.envSig[at] = env.sig[i];
    }
    this.envFrames = Math.min(size, Math.max(this.envFrames, base + n));
  }

  /** The zero runs of one summary, on the check's timeline. */
  takeRuns(seg, m) {
    const startup = (r) => r.startFrame < PRIME_FRAMES && r.frames < PRIME_FRAMES;
    const usable = (r) => r && isNum(r.startFrame) && isNum(r.frames) && !startup(r);
    const gapFrames = LIMITS.GAP_MS * FRAMES_PER_MS;
    const dropFrames = LIMITS.DROPOUT_MS * FRAMES_PER_MS;
    for (const r of Array.isArray(m.refRuns) ? m.refRuns : []) {
      if (!usable(r)) continue;
      const run = { startFrame: seg.offset + r.startFrame, frames: r.frames };
      const settled = r.startFrame >= SETTLE_FRAMES && !this.isSettling(run.startFrame);
      if (this.contextRoute && this.site === "graph" && settled) {
        if (micHoleCount([run]) > 0) {
          if (this.micHoleRuns.length < MAX_RUNS) this.micHoleRuns.push(run);
          else this.micHolesOver++;
        }
      }
      // The microphone's drop-outs (several 10 ms holes in a row, a USB hiccup, a late capture), once its sources
      // have settled, on every route: the voice carries them to the meeting.
      if (settled && run.frames >= dropFrames && run.frames < gapFrames) {
        if (this.micDropRuns.length < MAX_RUNS) this.micDropRuns.push(run);
        else this.micDropsOver++;
      }
      if (this.mode === "tone") {
        // Tone mode keeps only what "capture paused" needs: the microphone's runs of 100 ms or more.
        if (run.frames < gapFrames) continue;
        if (this.refRuns.length < MAX_RUNS) this.refRuns.push(run);
        else this.runsDropped++;
      } else {
        this.keepRun(this.refRuns, run);
      }
    }
    for (const r of Array.isArray(m.sigRuns) ? m.sigRuns : []) {
      if (!usable(r)) continue;
      this.keepRun(this.sigRuns, { startFrame: seg.offset + r.startFrame, frames: r.frames });
    }
  }

  /**
   * Mic mode keeps both lists whole up to the moment either one is full;
   * from then on neither keeps more. A CABLE Output run is explained by a
   * microphone run just before it, so the two lists must cover the same time.
   */
  keepRun(list, run) {
    if (this.runsFullAt !== null && run.startFrame >= this.runsFullAt) {
      this.runsDropped++;
      return;
    }
    if (list.length < MAX_RUNS) {
      list.push(run);
      return;
    }
    this.runsDropped++;
    if (this.runsFullAt === null) this.runsFullAt = run.startFrame;
  }

  isSettling(frame) {
    return this.settling.some(([from, to]) => frame >= from && frame < to);
  }

  /** Underruns of the recording context (Chromium 146 and later): deltas, for the diagnostics. */
  playback(seg, wallMs) {
    let stats = null;
    try {
      stats = seg.ctx?.playbackStats ?? null;
    } catch {
      stats = null;
    }
    if (!stats) return;
    const events = Number(stats.underrunEvents);
    const duration = Number(stats.underrunDuration);
    if (!Number.isFinite(events) || !Number.isFinite(duration)) return;
    this.anyStats = true;
    const last = seg.lastStats;
    seg.lastStats = { events, duration };
    if (!last) return; // the first reading of this context is the baseline
    const dEvents = events >= last.events ? events - last.events : events;
    const dMs = (duration >= last.duration ? duration - last.duration : duration) * 1000;
    if (dEvents > 0 || dMs > 0) this.underruns.push({ atMs: wallMs, events: dEvents, ms: dMs });
  }

  // ---------------------------------------------------------------- the microphone's buffer

  /** A 1 s reading: a fresh source of the microphone and micBus, side by side; their lag is the buffer's fill. */
  startReading(produced) {
    if (this.reading || this.finished || !this.contextRoute || this.site !== "graph") return;
    const micGen = this.graph.micGen;
    const atSec = round((produced - this.originMs) / 1000, 1);
    const rec = new Recording({ inputs: 2, frames: READING_FRAMES });
    const reading = { rec, remove: null };
    this.reading = reading;
    reading.remove = this.graph.addTap(
      async ({ ctx, micBus, micStream }) => {
        if (rec.settled || this.finished) return NOOP_HANDLE;
        try {
          if (!micStream) throw named("NotReadableError", CHECK_TEXTS.noMic);
          const built = await rec.build(ctx, (node) => {
            const fresh = ctx.createMediaStreamSource(micStream);
            fresh.connect(node, 0, 0);
            micBus.connect(node, 0, 1);
            return [
              [fresh, node],
              [micBus, node],
            ];
          });
          if (!built) return NOOP_HANDLE;
        } catch (err) {
          rec.fail(err);
          throw err;
        }
        return {
          dispose: (info) => {
            if (info?.generationEnded) rec.fail(named("AbortError", "The reading was cut by a rebuild."));
            rec.dispose();
          },
        };
      },
      { once: true },
    );
    const backstop = setTimeout(() => rec.fail(named("TimeoutError", "The reading did not finish.")), READING_LIMIT_MS);
    rec.promise
      .then(
        ([fresh, bus]) => {
          // A reading during which the microphone source changed measured two buffers: skipped.
          if (this.graph.micGen !== micGen) return;
          const lag = sampleLag(fresh, bus);
          if (!lag) {
            this.readingsFailed++;
            return;
          }
          this.readings.push({ atSec, lagMs: round(lag.lagMs, 2), score: round(lag.score, 3), micGen });
        },
        (err) => {
          this.readingsFailed++;
          this.log("info", `check long reading skipped ${nameOf(err)}`);
        },
      )
      .finally(() => {
        clearTimeout(backstop);
        if (this.reading === reading) this.reading = null;
        Promise.resolve(reading.remove?.()).catch(() => {});
      });
  }

  // ---------------------------------------------------------------- the window, the graph, the devices

  /** A phase mark; a window-state answer that says what the last one said is left out. */
  mark(m) {
    const last = this.marks[this.marks.length - 1];
    const isPoll = (x) => x && (typeof x.visible === "boolean" || typeof x.minimized === "boolean");
    if (isPoll(m) && isPoll(last) && last.visible === m.visible && last.minimized === m.minimized) return;
    this.marks.push(m);
    if (m.note !== undefined) return;
    const phase = phaseTimeline(this.marks).phaseAt(performance.now());
    if (phase !== this.lastPhase && !this.finished) {
      if (this.lastPhase !== null) this.log("info", `check long phase ${phase}`);
      this.lastPhase = phase;
    }
  }

  markVisibility() {
    const v = globalThis.document?.visibilityState;
    if (typeof v === "string") this.mark({ atMs: performance.now(), visibility: v });
  }

  poll() {
    const ask = this.platform?.windowState;
    if (typeof ask !== "function") return;
    let answer;
    try {
      answer = ask.call(this.platform);
    } catch {
      return;
    }
    Promise.resolve(answer).then(
      (s) => {
        if (this.finished || !s || typeof s !== "object") return;
        const m = { atMs: performance.now() };
        if (typeof s.visible === "boolean") m.visible = s.visible;
        if (typeof s.minimized === "boolean") m.minimized = s.minimized;
        if (typeof s.focused === "boolean") m.focused = s.focused;
        if (m.visible !== undefined || m.minimized !== undefined) this.mark(m);
      },
      () => {},
    );
  }

  /** A Hide pressed during the check: its phase, and the end moved to 2 minutes after it. → the end as an ISO time */
  onHide(mark) {
    this.mark(mark);
    // The window comes back at the Hide's end: ask for its state then, not up to 5 s later (diagnostics only).
    clearTimeout(this.hidePollTimer);
    this.hidePollTimer = setTimeout(() => this.poll(), Math.max(0, mark.untilMs - performance.now()) + AFTER_HIDE_MS);
    const hideEndSec = (mark.untilMs - this.originMs) / 1000;
    const next = stopAfterHide({
      plannedEndSec: this.plannedEndSec,
      hideEndSec,
      maxEndSec: this.plannedEndSec + LIMITS.EXTEND_MAX_SEC,
    });
    if (isNum(next) && next > this.endSec && !this.finished) {
      this.endSec = next;
      this.extendedToSec = Math.round(next);
      const seg = this.current;
      if (seg && seg.node && !seg.ended && !seg.done) {
        const base = seg.offset ?? seg.estimate;
        seg.stopAfter = Math.max(0, this.stopFrame - base);
        seg.node.port.postMessage({ type: "extend", stopAfterFrames: seg.stopAfter });
      }
      this.log("info", `check long extended to ${Math.round(next)} s`);
    }
    return this.finished ? null : isoOf(epochOf(this.originMs + this.endSec * 1000));
  }

  onRecovery(d) {
    if (this.finished || !d) return;
    const now = performance.now();
    if (d.kind === "lost") {
      const o = d.outage ?? {};
      this.openOutage = { lostAtMs: isNum(o.lostAtMs) ? o.lostAtMs : now, cause: typeof o.cause === "string" ? o.cause : "unknown" };
    } else if (d.kind === "back") {
      const r = d.record ?? {};
      const lostAtMs = isNum(r.lostAtMs) ? r.lostAtMs : (this.openOutage?.lostAtMs ?? now);
      const ms = isNum(r.outageMs) ? r.outageMs : now - lostAtMs;
      this.outages.push({ lostAtMs, ms, cause: r.cause ?? this.openOutage?.cause ?? "unknown", kind: "fault" });
      this.recoveries++;
      this.openOutage = null;
      this.rebuiltSinceUp = false;
    } else if (d.kind === "applied") {
      // A change the graph made by rebuilding (another output, the cable under a new id): the voice stopped meanwhile.
      if (this.rebuiltSinceUp) {
        const r = d.record ?? {};
        const ms = isNum(r.ms) ? r.ms : 0;
        this.outages.push({ lostAtMs: now - ms, ms, cause: typeof r.cause === "string" ? r.cause : "change", kind: "change" });
      }
      this.rebuiltSinceUp = false;
    }
  }

  onDevices(d) {
    const label = d?.snapshot?.defaultOutputLabel;
    if (this.finished || typeof label !== "string") return;
    if (this.lastDefaultOutput !== null && label !== this.lastDefaultOutput) {
      const now = performance.now();
      this.defaultOutputs.push(now);
      this.mark({ atMs: now, note: "default-output-changed" });
      this.log("info", "check long default output changed");
    }
    this.lastDefaultOutput = label;
  }

  // ---------------------------------------------------------------- progress and the backstop timer

  counts() {
    const total = { holes: 0, skips: 0, clicks: 0, dropouts: 0, gaps: 0, levels: 0, steps: 0, noises: 0 };
    for (const seg of this.segments) {
      if (!seg.counts) continue;
      for (const k of Object.keys(total)) if (isNum(seg.counts[k])) total[k] += seg.counts[k];
    }
    return total;
  }

  progress(frame, wallMs) {
    if (!this.onProgress) return;
    const tl = phaseTimeline(this.marks);
    const spans = tl.spans(this.originMs, wallMs);
    const outages = this.outages.length + (this.openOutage ? 1 : 0);
    let ticks;
    let gaps;
    let dropouts;
    if (this.mode === "tone") {
      const c = this.counts();
      ticks = c.holes + c.skips + c.clicks;
      gaps = c.gaps + outages;
      dropouts = c.dropouts;
    } else {
      const runs = classifyZeroRuns(this.refRuns, this.sigRuns);
      const long = runs.dropouts.filter((r) => r.frames >= LIMITS.DROPOUT_MS * FRAMES_PER_MS);
      ticks = runs.dropouts.length - long.length;
      dropouts = long.length;
      gaps = long.filter((r) => r.frames >= LIMITS.GAP_MS * FRAMES_PER_MS).length + outages;
    }
    const p = {
      mode: this.mode,
      elapsedSec: round(frame / SAMPLE_RATE, 1),
      totalSec: round(this.endSec, 1),
      extendedToSec: this.extendedToSec,
      phase: tl.phaseAt(wallMs),
      phasesSoFar: { visibleSec: spans.visibleSec, minimizedSec: spans.minimizedSec, hiddenSec: spans.hiddenSec },
      ticks,
      gaps,
      dropouts,
      levelDb: this.mode === "tone" ? round(this.levelDb, 1) : null,
      locked: this.mode === "tone" ? this.locked : null,
    };
    this.lastProgress = p;
    this.report(p);
  }

  report(p) {
    try {
      this.onProgress?.(p);
    } catch {
      // The page's own problem; the check goes on.
    }
  }

  /** Once a second: timer lateness (diagnostics), and the backstop for a check that cannot end by itself. */
  tick() {
    if (this.finished) return;
    const now = performance.now();
    if (this.nextTickMs !== null) this.ticks.push([this.nextTickMs, now - this.nextTickMs]);
    if (this.graph.state === "stopped") {
      this.end(CHECK_TEXTS.voiceStopped, "voice-stopped");
      return;
    }
    if (now > this.originMs + this.endSec * 1000 + END_GRACE_MS) {
      this.end(CHECK_TEXTS.notBack, "not-back");
      return;
    }
    this.nextTickMs = now + TICK_MS;
    this.timer = setTimeout(() => this.tick(), TICK_MS);
  }

  // ---------------------------------------------------------------- the end

  note(text) {
    if (text && !this.notes.includes(text)) this.notes.push(text);
  }

  /**
   * End the check now. note: why, when it ends early for a reason nobody
   * chose (the tone or CABLE Output lost, the voice stopped, …): the result
   * then fails with that reason first. A stop ("stop") and the planned end
   * ("end") have no note. → the result
   */
  end(note = null, why = "stop") {
    if (!this.finishing) {
      if (note) {
        this.earlyEnd = { note, why };
        this.log("warn", `check long ended early ${why}`);
      }
      if (!this.builtOnce) this.firstBuild.reject(named("AbortError", note ?? CHECK_TEXTS.longNoStart));
    }
    return this.finish();
  }

  finish() {
    if (this.finishing) return this.finishing;
    this.finishing = (async () => {
      this.finished = true;
      clearTimeout(this.timer);
      let result;
      try {
        // The watcher closes what is still going on (a tone lost at the very end is a gap) and sends its last summary.
        const seg = this.current;
        if (seg && seg.node && !seg.ended && !seg.done) {
          this.stopWatcher(seg);
          await limit(seg.doneSignal.promise, DONE_WAIT_MS).catch(() => {});
        }
        const endWallMs = performance.now();
        this.listeners.abort();
        if (this.reading) this.reading.rec.fail(named("AbortError", "The check ended."));
        await this.teardown();
        result = await this.analyse(endWallMs);
      } catch (err) {
        this.log("warn", `check long analysis failed ${nameOf(err)}`);
        result = this.failedResult(err);
      }
      this.result.resolve(result);
      return result;
    })();
    return this.finishing;
  }

  /** Watcher off the graph, the tone off the cable, CABLE Output closed. Never throws. */
  async teardown() {
    clearTimeout(this.timer);
    clearTimeout(this.hidePollTimer);
    if (this.removeTap) {
      const remove = this.removeTap;
      this.removeTap = null;
      await limit(Promise.resolve().then(remove), GRAPH_WAIT_MS).catch(() => {});
    }
    for (const seg of this.segments) {
      if (!seg.ended) {
        seg.ended = true;
        this.retire(seg);
        seg.doneSignal.resolve();
      }
    }
    if (this.testSourceSet) {
      this.testSourceSet = false;
      await limit(Promise.resolve().then(() => this.graph.setTestSource(null)), GRAPH_WAIT_MS).catch(() => {});
    }
    try {
      this.tone?.stop();
    } catch {
      // Already stopped.
    }
    stopStream(this.cable?.stream);
    closeQuietly(this.ownCtx);
  }

  // ---------------------------------------------------------------- the result

  async analyse(endWallMs) {
    const startMs = this.originMs;
    const open = this.openOutage;
    const lastFrame = this.lastSync?.frame ?? 0;
    const lastMs = this.lastSync?.producedMs ?? startMs;
    // A check that ended while the voice was out ends then; otherwise with its last summary.
    const endMs = open ? Math.max(lastMs, endWallMs) : lastMs;
    const recordedSec = Math.max(0, lastFrame / SAMPLE_RATE + (open ? Math.max(0, endWallMs - lastMs) / 1000 : 0));
    const tl = phaseTimeline(this.marks);
    const spans = tl.spans(startMs, endMs);
    const phases = {
      visibleSec: round(spans.visibleSec, 1),
      minimizedSec: round(spans.minimizedSec, 1),
      hiddenSec: round(spans.hiddenSec, 1),
      unknownSec: round(spans.unknownSec, 1),
    };
    const clock = frameClock(this.sync);
    const timeOf = (frame) => {
      const w = clock.toWallMs(frame) ?? startMs + frame / FRAMES_PER_MS;
      return { wallMs: w, atSec: round((w - startMs) / 1000, 2), phase: tl.phaseAt(w) };
    };
    const nearDefaultChange = (wallMs) => this.defaultOutputs.some((t) => Math.abs(t - wallMs) <= NEAR_MS);
    const underrunsNear = (fromMs, toMs) => {
      let events = 0;
      let ms = 0;
      for (const u of this.underruns) {
        if (u.atMs >= fromMs - NEAR_MS && u.atMs <= toMs + NEAR_MS) {
          events += u.events;
          ms += u.ms;
        }
      }
      return events > 0 || ms > 0 ? { underrunEvents: events, underrunMs: round(ms, 1) } : {};
    };

    // Outages: the app's recoveries (and rebuilds for a change) during the check, one still going on at the end.
    const raw = this.outages.slice();
    if (open) raw.push({ lostAtMs: open.lostAtMs, ms: endWallMs - open.lostAtMs, cause: open.cause, kind: "fault", open: true });
    const outages = raw.map((o) => {
      const out = { atSec: round((o.lostAtMs - startMs) / 1000, 1), phase: tl.phaseAt(o.lostAtMs), ms: round(o.ms, 0), cause: o.cause };
      if (o.kind === "change") out.change = true;
      if (o.open) out.notOver = true;
      if (nearDefaultChange(o.lostAtMs)) out.note = CHECK_TEXTS.defaultOutput;
      return Object.assign(out, underrunsNear(o.lostAtMs, o.lostAtMs + o.ms));
    });

    // Rendering pauses: the worklet's own stamps moved on while its frames did not. A pause lies somewhere between
    // the summary before it and the one that shows it; it is reported from the summary before it. One that
    // overlaps a recovery is that recovery (a suspended context), counted once.
    const rp = renderPauses(this.sync);
    const span = (p) => {
      const before = this.sync[p.index - 1]?.producedMs;
      return [isNum(before) ? before : p.producedMs - p.ms - SUMMARY_FRAMES / FRAMES_PER_MS, p.producedMs];
    };
    const explained = (p) => {
      const [from, to] = span(p);
      return raw.some((o) => from - NEAR_MS <= o.lostAtMs + o.ms && o.lostAtMs - NEAR_MS <= to);
    };
    const unexplained = rp.pauses.filter((p) => !explained(p));
    const pauses = unexplained.map((p) => {
      const [from, to] = span(p);
      const out = { atSec: round((from - startMs) / 1000, 1), phase: tl.phaseAt(from), ms: round(p.ms, 0) };
      if (nearDefaultChange(from) || nearDefaultChange(to)) out.note = CHECK_TEXTS.defaultOutput;
      return Object.assign(out, underrunsNear(from, to));
    });
    const late = { count: rp.late.count, maxMs: round(rp.late.maxMs, 0) };

    // What happened around an outage belongs to it: the sound's buffers refill or drain once it is over, which
    // gives clicks and short holes that are not the clocks drifting apart. They are left out of the counts.
    const shadows = [
      ...raw.map((o) => [o.lostAtMs - SHADOW_BEFORE_MS, o.lostAtMs + o.ms + SHADOW_AFTER_MS]),
      ...unexplained.map((p) => {
        const [from, to] = span(p);
        return [from - SHADOW_BEFORE_MS, to + SHADOW_AFTER_MS];
      }),
    ];
    const shadowed = (wallMs) => shadows.some(([a, b]) => wallMs >= a && wallMs <= b);
    const runShadowed = (r) => shadowed(timeOf(r.startFrame).wallMs);
    // Mic mode: once a list was full, both lists stop there (a CABLE Output run needs its microphone run).
    const covered = (r) => this.runsFullAt === null || r.startFrame < this.runsFullAt;
    // The microphone's silences of GAP_MS or more carry their time and phase (for the reason and the result).
    const gapFrames = LIMITS.GAP_MS * FRAMES_PER_MS;
    const refRuns = this.refRuns
      .filter((r) => covered(r) && !runShadowed(r))
      .map((r) => {
        if (r.frames < gapFrames) return r;
        const t = timeOf(r.startFrame);
        return { ...r, atSec: t.atSec, phase: t.phase };
      });
    // The microphone's own drop-outs (DROPOUT_MS up to GAP_MS) once its sources settled, with when and where.
    const micDropRuns = this.micDropRuns
      .filter((r) => !runShadowed(r))
      .map((r) => {
        const t = timeOf(r.startFrame);
        return { startFrame: r.startFrame, frames: r.frames, atSec: t.atSec, phase: t.phase };
      });
    const isDrop = (r) => r.frames >= LIMITS.DROPOUT_MS * FRAMES_PER_MS && r.frames < gapFrames;

    // The microphone: its share of digital silence (a noise gate: longVerdict decides, from the pattern of its
    // silences), its 10 ms holes and its buffer's slope.
    let frames = 0;
    let zeroFrames = 0;
    for (const seg of this.segments) {
      frames += seg.frames;
      zeroFrames += seg.refZeroFrames;
    }
    const micZeroFraction = frames > 0 ? zeroFrames / frames : 0;
    let micPath = null;
    if (this.contextRoute && this.site === "graph") {
      const holes = this.micHoleRuns.filter((r) => !runShadowed(r)).length + this.micHolesOver;
      const mc = micClock(this.readings, { holes, durationSec: recordedSec });
      micPath = {
        readings: thin(mc.readings, 40),
        holes: mc.holes,
        holesPer30Min: round(mc.holesPer30Min, 2),
        ppm: round(mc.ppm, 1),
        ppmIsLowerBound: mc.ppmIsLowerBound,
        direction: mc.direction,
        saturatedAtSec: mc.saturatedAtSec,
        fullAtStart: mc.fullAtStart,
        renewed: this.micRenewed,
        dropsPer30Min: round(mc.dropsPer30Min, 2),
        ticksPer30Min: round(mc.ticksPer30Min, 2),
        slopePpm: round(mc.slopePpm, 1),
        slopeIsLowerBound: mc.slopeIsLowerBound,
        noiseGate: false, // longVerdict's decision, set below
        readingsTaken: this.readings.length,
        readingsFailed: this.readingsFailed,
      };
    }

    const notes = this.notes.slice();
    if (this.runsFullAt !== null) notes.push(CHECK_TEXTS.runsFull(this.runsFullAt / SAMPLE_RATE));
    const result = {
      mode: this.mode,
      at: this.at,
      minutesAsked: this.minutes,
      extendedToSec: this.extendedToSec,
      recordedSec: round(recordedSec, 1),
      phases,
      verdict: null,
      reasons: [],
      endedEarly: null, // { why, note } when it ended early for a reason nobody chose (see end())
      lines: [],
      tonePath: null,
      micPath,
      // Diagnostics as well: they are listed even when a noise gate keeps the verdict from judging them.
      micDropouts: {
        count: micDropRuns.length + this.micDropsOver,
        longestMs: round(micDropRuns.reduce((m, r) => Math.max(m, r.frames / FRAMES_PER_MS), 0), 1),
        runs: micDropRuns.slice(0, 20).map((r) => ({ atSec: r.atSec, phase: r.phase, ms: round(r.frames / FRAMES_PER_MS, 1) })),
      },
    };

    const verdictInput = {
      mode: this.mode,
      durationSec: recordedSec,
      phases: spans,
      outages: [
        ...outages.map((o) => ({ atSec: o.atSec, phase: o.phase, ms: o.ms, cause: o.cause })),
        ...pauses.map((p) => ({ atSec: p.atSec, phase: p.phase, ms: p.ms, cause: "render-paused" })),
      ],
      recoveries: this.recoveries,
      micPath,
      micZeroFraction,
      late,
      // Its stops (GAP_MS or more) and its settled drop-outs; the speech analysis below gets every run.
      refRuns: [...refRuns.filter((r) => !isDrop(r)), ...micDropRuns],
    };

    if (this.mode === "tone") {
      const counts = this.counts();
      const all = this.events.map((e) => {
        const t = timeOf(e.atFrame);
        return { ...e, atSec: t.atSec, phase: t.phase, wallMs: t.wallMs };
      });
      // Disturbances around an outage are the outage's own (counted once, as the outage); a slow change of
      // level is not a disturbance and always counts.
      const events = all.filter((e) => e.kind === "level" || !shadowed(e.wallMs));
      const aroundOutages = all.length - events.length;
      for (const e of all) {
        if (e.kind === "level" || !shadowed(e.wallMs)) continue;
        const key = COUNT_KEYS[e.kind];
        if (key && counts[key] > 0) counts[key]--;
      }
      const lockDb = this.segments.map((s) => s.lockDb).find(isNum) ?? null;
      const stable = this.segments.map((s) => s.minStableDb).filter(isNum);
      const minStableDb = stable.length ? Math.min(...stable) : null;
      const lastSeg = [...this.segments].reverse().find((s) => isNum(s.phaseDriftPpm));
      Object.assign(verdictInput, { counts, events, tone: { lockDb, minStableDb } });
      result.tone = {
        levelDb: round(this.levelDb, 1),
        lockDb: round(lockDb, 1),
        minStableDb: round(minStableDb, 1),
        counts,
        phaseDriftPpm: round(lastSeg?.phaseDriftPpm ?? null, 2),
        events: events.slice(0, 100).map((e) => {
          const out = { atSec: e.atSec, phase: e.phase, kind: e.kind };
          if (isNum(e.holeMs)) out.ms = e.holeMs;
          else if (e.kind === "skip" && isNum(e.phaseStepDeg)) out.deg = e.phaseStepDeg;
          else if (e.kind === "step" && isNum(e.stepDb)) out.db = e.stepDb;
          else if (e.kind === "level" && isNum(e.fromDb) && isNum(e.toDb)) {
            out.db = round(e.toDb - e.fromDb, 2);
            out.fromDb = e.fromDb;
            out.toDb = e.toDb;
          } else if (isNum(e.frames)) out.ms = round(e.frames / FRAMES_PER_MS, 2);
          if (["gap", "dropout", "hole", "noise"].includes(e.kind)) {
            if (nearDefaultChange(e.wallMs)) out.note = CHECK_TEXTS.defaultOutput;
            Object.assign(out, underrunsNear(e.wallMs, e.wallMs + (isNum(e.holeMs) ? e.holeMs : 0)));
          }
          return out;
        }),
        eventCount: events.length + this.eventsDropped,
        aroundOutages,
      };
      for (const e of events) {
        if (e.kind === "gap" && nearDefaultChange(e.wallMs)) notes.push(CHECK_TEXTS.defaultOutputGap(e.atSec));
      }
    } else {
      const seconds = Math.max(1, Math.round(recordedSec / 60 / 13));
      this.report({ ...(this.lastProgress ?? { mode: this.mode }), analysing: true, analysingSec: seconds, text: CHECK_TEXTS.analysing(seconds) });
      await yieldToPage();
      const n = this.envFrames;
      const sigRuns = this.sigRuns.filter((r) => covered(r) && !runShadowed(r));
      const speech = analyzeSpeech({
        refDb: this.envRef.subarray(0, n),
        sigDb: this.envSig.subarray(0, n),
        hopMs: 5,
        refRuns,
        sigRuns,
        sampleRate: SAMPLE_RATE,
      });
      this.envRef = null;
      this.envSig = null;
      verdictInput.speech = speech;
      const runTime = (r) => timeOf(r.startFrame);
      result.speech = {
        lagMs: round(speech.lagMs, 1),
        lagScore: round(speech.lagScore, 3),
        gaps: speech.gaps.slice(0, 50).map((g) => {
          const t = timeOf(g.atSec * SAMPLE_RATE);
          return { ...g, phase: t.phase };
        }),
        speechSec: round(speech.speechSec, 1),
        dropouts: speech.dropouts.slice(0, 50).map((r) => {
          const t = runTime(r);
          const out = { atSec: t.atSec, phase: t.phase, ms: r.ms };
          if (nearDefaultChange(t.wallMs)) out.note = CHECK_TEXTS.defaultOutput;
          return Object.assign(out, underrunsNear(t.wallMs, t.wallMs + r.ms));
        }),
        dropoutCount: speech.dropouts.length,
        // Every one of DROPOUT_MS or more (the list above keeps only the first 50, short and long mixed): the
        // Gate 1 gaps row counts these.
        longDropoutCount: speech.dropouts.filter((r) => r.ms >= LIMITS.DROPOUT_MS).length,
        micHoles: speech.micHoles,
        micSilentSec: round(speech.micSilentSec, 2),
        micPauses: speech.micPauses.length,
        cableSilent: speech.cableSilent,
        aroundOutages: this.sigRuns.length - sigRuns.length,
      };
      for (const r of speech.dropouts) {
        const t = runTime(r);
        if (r.ms >= LIMITS.GAP_MS && nearDefaultChange(t.wallMs)) notes.push(CHECK_TEXTS.defaultOutputGap(t.atSec));
      }
    }

    const v = longVerdict(verdictInput);
    // The microphone's own silences, for whoever reads the results: a noise gate's many short ones, or a few long
    // ones (muted, or paused by Windows). Runs of GAP_MS or more, the longest first; in tone mode only those are
    // kept, so the ones over the list's limit are counted too.
    const silences = refRuns.filter((r) => r.frames >= gapFrames);
    if (micPath) micPath.noiseGate = v.micSilence.gate;
    result.micSilence = {
      checked: v.micSilence.checked,
      gate: v.micSilence.gate,
      zeroFraction: round(micZeroFraction, 4),
      count: silences.length + (this.mode === "tone" ? this.runsDropped : 0),
      longest: [...silences]
        .sort((a, b) => b.frames - a.frames)
        .slice(0, 20)
        .map((r) => ({ atSec: r.atSec, phase: r.phase, ms: round(r.frames / FRAMES_PER_MS, 0) })),
    };
    // A check that ended early for a reason nobody chose did not cover what it was asked to: it fails, with
    // that reason first, whatever the part it recorded says. One that measured nothing stays "no-signal".
    // endedEarly says so in the result itself, for gateSummary (a stop or the planned end leaves it null).
    const early = this.earlyEnd;
    result.verdict = early && v.verdict !== "no-signal" ? "fail" : v.verdict;
    result.reasons = early ? [early.note, ...v.reasons] : v.reasons;
    result.endedEarly = early ? { why: early.why, note: early.note } : null;
    result.lines = v.lines;
    result.tonePath = v.tonePath
      ? { ticksPer30Min: round(v.tonePath.ticksPer30Min, 2), ppm: round(v.tonePath.ppm, 1), direction: v.tonePath.direction }
      : null;
    result.outages = outages;
    result.renderPauses = pauses;
    result.mainThreadLate = late;
    result.recoveries = this.recoveries;
    result.timerLateMs = this.timerLateness(tl);
    result.playback = this.anyStats ? this.playbackByPhase(tl) : null;
    result.defaultOutputChanges = this.defaultOutputs.map((t) => ({ atSec: round((t - startMs) / 1000, 1) }));
    result.route = this.route;
    result.routePreference = this.routePreference;
    result.site = this.site;
    result.notes = [...new Set(notes)];
    return result;
  }

  /** Timer lateness per phase: the most, and how many ticks came a second or more late. */
  timerLateness(tl) {
    const out = {};
    for (const phase of ["visible", "minimized", "hidden"]) out[phase] = { maxMs: 0, count: 0 };
    for (const [atMs, lateMs] of this.ticks) {
      const slot = out[tl.phaseAt(atMs)];
      if (!slot) continue;
      if (lateMs > slot.maxMs) slot.maxMs = Math.round(lateMs);
      if (lateMs >= LATE_TICK_MS) slot.count++;
    }
    return out;
  }

  playbackByPhase(tl) {
    const out = {};
    for (const phase of ["visible", "minimized", "hidden", "unknown"]) out[phase] = { underrunEvents: 0, underrunMs: 0 };
    for (const u of this.underruns) {
      const slot = out[tl.phaseAt(u.atMs)];
      slot.underrunEvents += u.events;
      slot.underrunMs = round(slot.underrunMs + u.ms, 1);
    }
    return out;
  }

  /** The result when the analysis itself failed: what is known, and why there is no verdict. */
  failedResult(err) {
    return {
      mode: this.mode,
      at: this.at,
      minutesAsked: this.minutes,
      extendedToSec: this.extendedToSec,
      recordedSec: round((this.lastSync?.frame ?? 0) / SAMPLE_RATE, 1),
      phases: { visibleSec: 0, minimizedSec: 0, hiddenSec: 0, unknownSec: 0 },
      verdict: "no-signal",
      reasons: [...(this.earlyEnd ? [this.earlyEnd.note] : []), CHECK_TEXTS.notAnalysed(nameOf(err))],
      endedEarly: this.earlyEnd ? { why: this.earlyEnd.why, note: this.earlyEnd.note } : null,
      lines: [],
      tonePath: null,
      micPath: null,
      micDropouts: null,
      outages: [],
      renderPauses: [],
      mainThreadLate: { count: 0, maxMs: 0 },
      recoveries: this.recoveries,
      timerLateMs: null,
      playback: null,
      defaultOutputChanges: [],
      route: this.route,
      routePreference: this.routePreference,
      site: this.site,
      notes: this.notes.slice(),
    };
  }

  log(level, text) {
    this.owner._log(level, text);
  }
}

export class Checks extends EventTarget {
  /**
   * @param {object} options
   * @param {object} options.graph the VoiceGraph
   * @param {object} options.monitor the Monitor (the long check's test tone)
   * @param {{hideWindowFor?: Function, windowState?: Function}} [options.platform]
   * @param {(level: string, text: string) => void} [options.log] platform.log: codes and numbers only
   */
  constructor({ graph, monitor, platform = {}, log = () => {} } = {}) {
    super();
    this._graph = graph;
    this._monitor = monitor;
    this._platform = platform ?? {};
    this._logFn = typeof log === "function" ? log : () => {};
    this._busy = null;
    this._long = null;
    this._cancelDelay = null;
  }

  /** null | "delay" | "long": the check that runs now (one at a time). The "busy" event says when it changes. */
  get busy() {
    return this._busy;
  }

  /**
   * "Measure the delay": 12 s of a fresh source of the microphone, CABLE
   * Output and micBus, recorded together (the frames count, not a timer).
   * onProgress(secondsLeft) on every 100 ms chunk. → DelayResult { at,
   * seconds, ok, passthroughMs, estimateMs, micFifoMs, micFifoScore,
   * captureLatencyMs, score, method, levelDiffDb, verdict, text, notes,
   * cableCaptureLatencyMs, outputLatencyMs, baseLatencyMs,
   * cableOutputRateHz, route, routePreference, site }. Throws an Error the
   * page shows when it cannot run or was cut short (the voice not running,
   * no CABLE Output, the audio restarted meanwhile, another check running).
   */
  async measureDelay({ seconds = 12, onProgress = () => {} } = {}) {
    const sec = isNum(seconds) && seconds >= 1 && seconds <= 60 ? seconds : 12;
    this._claim("delay");
    const at = new Date().toISOString();
    let cable = null;
    try {
      this._requireRunning();
      this._log("info", `check delay start ${sec} s`);
      const graph = this._graph;
      const route = graph.output?.method ?? null;
      const routePreference = graph.output?.routePreference ?? "auto";
      const contextRoute = isContextRoute(route);
      cable = await openCableOutput(graph.snapshot);
      const frames = Math.round(sec * SAMPLE_RATE);
      const rec = await this._recordDelay({ cable, frames, contextRoute, onProgress, sec });
      const r = analyzeRun({ ref: rec.ref0, sig: rec.sig, sampleRate: SAMPLE_RATE, maxLagMs: 500 });
      const fifo = rec.ref1 ? sampleLag(rec.ref0, rec.ref1) : null;
      const micFifoMs = fifo ? round(fifo.lagMs, 2) : null;
      const capture = captureLatencyMs(graph.mic?.track);
      const v = delayVerdict(r, { captureLatencyMs: capture, micFifoMs });
      const result = {
        at,
        seconds: sec,
        ok: v.estimateMs !== null,
        passthroughMs: r.ok ? round(r.delayMs, 1) : null,
        estimateMs: v.estimateMs,
        micFifoMs,
        micFifoScore: fifo ? round(fifo.score, 3) : null,
        captureLatencyMs: capture,
        score: r.ok ? round(r.delayScore, 3) : null,
        method: r.ok ? (r.delayMethod ?? null) : null,
        levelDiffDb: r.ok ? round(r.levelDiffDb, 1) : null,
        verdict: v.verdict,
        text: v.text,
        notes: [...v.notes, ...rec.notes],
        cableCaptureLatencyMs: captureLatencyMs(cable.track),
        outputLatencyMs: rec.latencies.outputLatencyMs,
        baseLatencyMs: rec.latencies.baseLatencyMs,
        cableOutputRateHz: cable.settings?.sampleRateHz ?? null,
        route,
        routePreference,
        site: rec.site,
      };
      this._log(
        "info",
        `check delay done ${v.verdict} ${result.estimateMs ?? "-"} ms fifo ${micFifoMs ?? "-"} ms score ${result.score ?? "-"} ${rec.site}`,
      );
      return result;
    } catch (err) {
      this._log("warn", `check delay failed ${nameOf(err)}`);
      throw err;
    } finally {
      stopStream(cable?.stream);
      this._release("delay");
    }
  }

  /**
   * The long check ("Record CABLE Output"). mode "tone": the meeting hears a
   * steady test tone (from Windows' default playback device's clock) instead
   * of the microphone until it ends; mode "mic": your voice as it is.
   * minutes: 0.25 to 120. onProgress({mode, elapsedSec, totalSec,
   * extendedToSec, phase, phasesSoFar, ticks, gaps, dropouts, levelDb,
   * locked}) once a second; in mic mode, once more at the end with
   * {analysing: true, analysingSec, text} before the analysis.
   * Resolves once it records: LongHandle { stop() → Promise<LongResult>,
   * done: Promise<LongResult> (never rejects), endsAt (ISO), extendedToSec }.
   * It ends by itself at its (possibly extended) end. Throws an Error the
   * page shows when it cannot start (a MonitorError when the test tone is
   * refused).
   */
  async startLong({ mode = "tone", minutes = 65, onProgress = () => {} } = {}) {
    const m = mode === "mic" ? "mic" : "tone";
    const min = Number(minutes);
    if (!(Number.isFinite(min) && min >= MIN_MINUTES && min <= MAX_MINUTES)) throw new Error(CHECK_TEXTS.minutes);
    this._claim("long");
    let check;
    try {
      this._requireRunning();
      check = new LongCheck(this, { mode: m, minutes: min, onProgress });
      this._long = check;
      await check.begin();
    } catch (err) {
      this._long = null;
      this._release("long");
      this._log("warn", `check long failed to start ${nameOf(err)}`);
      throw err;
    }
    // The check ends by itself (its worklet's "done", or a reason to end early) or by stop(); either way the
    // busy flag is released before `done` resolves.
    const done = check.result.promise.then((result) => {
      if (this._long === check) this._long = null;
      this._release("long");
      this._log(
        "info",
        `check long done ${result.verdict} ${Math.round(result.recordedSec ?? 0)} s outages ${result.outages?.length ?? 0} pauses ${result.renderPauses?.length ?? 0}`,
      );
      return result;
    });
    return {
      stop: () => {
        check.end(null, "stop");
        return done;
      },
      done,
      get endsAt() {
        return isoOf(epochOf(check.originMs + check.endSec * 1000));
      },
      get extendedToSec() {
        return check.extendedToSec;
      },
    };
  }

  /**
   * Hide the window for `minutes` (platform.hideWindowFor: the installed app
   * only; Edge dev mode throws a text the page shows). A long check that
   * runs then gets the hidden phase and goes on until 2 minutes after the
   * window is back. → HideResult { at, minutes, showAt, longEndsAt (ISO when
   * a long check runs, else null) }
   */
  async hideFor(minutes = 30) {
    let r;
    try {
      r = await this._platform.hideWindowFor(minutes);
    } catch (err) {
      this._log("warn", `check hide failed ${nameOf(err)}`);
      throw err;
    }
    const now = performance.now();
    const asked = isNum(r?.minutes) ? r.minutes : minutes;
    const hiddenMs = isNum(r?.showAtMs) && isNum(r?.hiddenAtMs) ? r.showAtMs - r.hiddenAtMs : asked * 60000;
    const mark = { atMs: now, hiddenByApp: true, untilMs: now + hiddenMs };
    const longEndsAt = this._long ? this._long.onHide(mark) : null;
    this._log("info", `check hide ${asked} min${longEndsAt ? " long check extended" : ""}`);
    return {
      at: isoOf(isNum(r?.hiddenAtMs) ? r.hiddenAtMs : Date.now()),
      minutes: asked,
      showAt: isoOf(isNum(r?.showAtMs) ? r.showAtMs : Date.now() + hiddenMs),
      longEndsAt,
    };
  }

  /** The page is going away: a long check ends now (its result is still made), a delay measurement is cut. */
  stop() {
    this._cancelDelay?.(named("AbortError", "The check was stopped."));
    return this._long ? this._long.end(null, "stop").then(() => {}) : Promise.resolve();
  }

  // ---------------------------------------------------------------- inner workings

  _claim(what) {
    if (this._busy) throw new Error(CHECK_TEXTS.busy);
    this._setBusy(what);
  }

  _release(what) {
    if (this._busy === what) this._setBusy(null);
  }

  _setBusy(value) {
    if (this._busy === value) return;
    this._busy = value;
    this.dispatchEvent(new CustomEvent("busy", { detail: { busy: value } }));
  }

  _requireRunning() {
    const g = this._graph;
    if (!g || g.state !== "running") throw new Error(CHECK_TEXTS.notRunning);
    if (!g.snapshot?.cableOut) throw new Error(CHECK_TEXTS.noCableOutput);
  }

  /**
   * A context of the checks' own on VB-CABLE's clock (sink = CABLE Input,
   * nothing connected to its destination), for the audio element route. null
   * when it cannot use CABLE Input: the caller records in the graph's
   * context instead.
   */
  async _ownContext() {
    const id = this._graph.snapshot?.cableIn?.deviceId || this._graph.output?.entry?.deviceId || "";
    if (!id) return null;
    let ctx = null;
    try {
      ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
      await limit(ctx.setSinkId(id), SINK_LIMIT_MS, "setSinkId");
      if (ctx.sinkId !== id) throw named("InvalidStateError", "The recording context did not switch to CABLE Input.");
      return ctx;
    } catch (err) {
      this._log("warn", `check own context failed ${nameOf(err)}`);
      closeQuietly(ctx);
      return null;
    }
  }

  /**
   * The three inputs of "Measure the delay" for `frames` frames: ref0 (a
   * fresh source of the microphone), sig (CABLE Output), ref1 (micBus; on
   * the audio element route nothing, so null). An outage or a rebuild of the
   * voice, CABLE Output ending, or a recorder that does not finish in time
   * ends it with an Error the page shows.
   */
  async _recordDelay({ cable, frames, contextRoute, onProgress, sec }) {
    const graph = this._graph;
    const notes = [];
    const report = (got) => {
      try {
        onProgress?.(Math.ceil((frames - got) / SAMPLE_RATE));
      } catch {
        // The page's own problem.
      }
    };
    const rec = new Recording({ inputs: 3, frames, onFrames: report });
    const listeners = new AbortController();
    const signal = listeners.signal;
    const restarted = () => rec.fail(named("AbortError", CHECK_TEXTS.restarted));
    graph.addEventListener("recovery", (ev) => {
      if (ev.detail?.kind === "lost") restarted();
    }, { signal });
    graph.addEventListener("rebuilt", restarted, { signal });
    cable.track.addEventListener("ended", () => rec.fail(named("NotReadableError", CHECK_TEXTS.cableEnded)), { signal });
    this._cancelDelay = (err) => rec.fail(err);
    const watchdog = setTimeout(
      () => rec.fail(named("TimeoutError", rec.started ? CHECK_TEXTS.stalled : CHECK_TEXTS.noStart)),
      sec * 1000 + DELAY_SLACK_MS,
    );
    let own = null;
    let removeTap = null;
    let site = "graph";
    try {
      if (!contextRoute) {
        own = await this._ownContext();
        if (!own) notes.push(CHECK_TEXTS.ownCrossing);
      }
      if (own) {
        site = "own-context";
        const micStream = graph.micStream;
        if (!micStream) throw new Error(CHECK_TEXTS.noMic);
        own.addEventListener("statechange", () => {
          if (own.state === "closed") rec.fail(named("AbortError", CHECK_TEXTS.stalled));
        }, { signal });
        own.addEventListener("error", () => rec.fail(named("AbortError", CHECK_TEXTS.stalled)), { signal });
        await rec.build(own, (node) => {
          const fresh = own.createMediaStreamSource(micStream);
          const sig = own.createMediaStreamSource(cable.stream);
          fresh.connect(node, 0, 0);
          sig.connect(node, 0, 1);
          return [
            [fresh, node],
            [sig, node],
          ];
        });
        if (own.state !== "running") own.resume().catch(() => {});
      } else {
        removeTap = graph.addTap(
          async ({ ctx, micBus, micStream }) => {
            if (rec.settled) return NOOP_HANDLE;
            try {
              if (!micStream) throw named("NotReadableError", CHECK_TEXTS.noMic);
              const built = await rec.build(ctx, (node) => {
                const fresh = ctx.createMediaStreamSource(micStream);
                const sig = ctx.createMediaStreamSource(cable.stream);
                fresh.connect(node, 0, 0);
                sig.connect(node, 0, 1);
                const wires = [
                  [fresh, node],
                  [sig, node],
                ];
                // On the audio element route input 2 stays unconnected (zeros): micBus's buffer is not measured there.
                if (contextRoute) {
                  micBus.connect(node, 0, 2);
                  wires.push([micBus, node]);
                }
                return wires;
              });
              if (!built) return NOOP_HANDLE;
            } catch (err) {
              rec.fail(err);
              throw err;
            }
            return {
              dispose: (info) => {
                if (info?.generationEnded) restarted();
                rec.dispose();
              },
            };
          },
          { once: true },
        );
      }
      const [ref0, sig, ref1] = await rec.promise;
      return { ref0, sig, ref1: contextRoute && site === "graph" ? ref1 : null, site, latencies: rec.latencies, notes };
    } finally {
      clearTimeout(watchdog);
      listeners.abort();
      this._cancelDelay = null;
      rec.fail(named("AbortError", "The measurement ended."));
      if (removeTap) await limit(Promise.resolve().then(removeTap), GRAPH_WAIT_MS).catch(() => {});
      closeQuietly(own);
    }
  }

  _log(level, text) {
    try {
      this._logFn(level, text);
    } catch {
      // A log line is never worth an error.
    }
  }
}
