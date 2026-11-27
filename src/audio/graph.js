/**
 * The passthrough: the user's microphone → one AudioContext (48 kHz) →
 * a processor slot (ac-passthrough now; Step 4's safety mixer later) →
 * VB-CABLE's "CABLE Input", from the moment the app opens. The meeting app
 * hears it through "CABLE Output".
 *
 *   mic stream ─► micSource ─► micBus ─┬─► inBus ─► processor ─► outBus ─► the route (sink.js)
 *                                      │   (testSource ─► inBus instead, during the tone check)
 *                                      ├─► meter input 0          outBus ─► meter input 1
 *                                      └─► taps (checks) and engine inputs (Step 7)
 *
 * One reducer (core/recovery.js) runs the first start, the user's changes and
 * the recovery after faults. The graph feeds it events from the current
 * context, mic track and route, and carries out what it answers: resume the
 * context, rebuild the graph, reopen the microphone. Every change to the
 * graph runs one at a time under one lock. An operation that began before a
 * stop() is stale: it undoes what it built and reports nothing. Listeners
 * belong to one generation (one context) and ignore anything that is no
 * longer current, so a late event of a closed context is never taken for a
 * fault of the new one.
 *
 * The meter worklet's messages are the heartbeat: they are made on the audio
 * thread, so they prove that the context renders, hidden window or not.
 * Main-thread timers are backstops only (verify, retry, the resume cap and a
 * 1 s watchdog); the audio itself never waits for one.
 *
 * Nothing touches the page when this module is imported.
 */
import { OutputRecovery, classifyError } from "../core/recovery.js";
import { WARNINGS, chooseMic, chooseOutput, deviceWarnings, siblingOutput } from "../core/device-choice.js";
import { micHoleCount } from "../core/cable-check.js";
import { redact } from "../core/redact.js";
import { noMicError, onDeviceChange, openMic, readDevices, readOutputRate, micErrorText, stopStream } from "./devices.js";
import { SinkError, methodBase, routeOutput } from "./sink.js";

export const GRAPH_STATES = [
  "stopped",
  "starting",
  "no-mic",
  "mic-blocked",
  "mic-busy",
  "no-cable",
  "needs-gesture",
  "running",
  "switching",
  "recovering",
  "sink-refused",
];

const SAMPLE_RATE = 48000;
const START_WAIT_MS = 10000; // start() resolves after the first op, or after this
const SETTLE_WAIT_MS = 10000; // setMic / setOutput / retry resolve when the change is over, or after this
const WATCHDOG_MS = 1000;
const RESUME_CAP_MS = 500;
const RUNNING_BACKSTOP_MS = 1000; // after setSinkId on a running context: wait for "running" again
const GESTURE_WAIT_MS = 800; // Edge only: how long a new context may take to start before a click is asked for
const CLOSE_BACKSTOP_MS = 1000;
const NONE_SINK_MS = 5000;
const METERLESS_CHECK_MS = 300; // without a meter: when ctx.currentTime is checked for the heartbeat
const STEP_BACKSTOP_MS = 5000; // a worklet load, a processor factory or a tap build that takes longer is given up
// A new microphone source (first start, rebuild, microphone swap) starts with an almost empty buffer, so
// its first hiccups insert 10 ms holes that are not the two clocks drifting apart. Holes that start this
// soon after it are left out of micHolesTotal. Measured in headless Chromium: such holes came 26 ms to
// about 7 s after the source started, most of them within 0.3 s.
const MIC_SETTLE_MS = 10000;

/** Worklet files, next to this module (the same path in Edge dev mode and in the app). */
const workletUrl = (file) => new URL(`./worklets/${file}`, import.meta.url).href;

const TEXTS = Object.freeze({
  stopped: "Your voice is not being sent.",
  starting: "Starting your voice…",
  startingAgain: "Starting your voice… (trying again)",
  running:
    "Your voice goes into “CABLE Input”. In Zoom, Teams or Meet, pick “CABLE Output (VB-Audio Virtual Cable)” as the microphone.",
  testSource: "The long check is running: the meeting hears a steady test tone instead of your voice.",
  switching: "Switching…",
  noMic: "No microphone found. Plug in your headset.",
  micBusy:
    "Another app is using your microphone. The app tries again every 5 seconds: close the other app, or pick another microphone.",
  needsGesture: "Click Start to let this page play sound (Edge needs one click first).",
  waitingForCable: " waiting for “CABLE Input” to come back",
});

const CAUSE_TEXTS = Object.freeze({
  "render-error": "the audio device reported an error",
  "render-stalled": "the audio stopped moving",
  "context-suspended": "the audio was paused",
  "context-closed": "the audio engine closed",
  "sink-changed": "the playback device changed",
  "mic-ended": "the microphone stopped",
  "change-failed": "the change you made did not work",
});

const recoveringText = (cause) =>
  `Your voice stopped reaching the meeting (${CAUSE_TEXTS[cause] ?? "a problem with the sound"}). Bringing it back…`;

const sinkRefusedText = (name) =>
  `The app could not send your voice into “CABLE Input” (${name}). This is one of the Session B checks: copy the results and send them to me.`;

/** Warnings the graph adds to the device warnings (no device names in them). */
const GRAPH_TEXTS = Object.freeze({
  MIC_MUTED: "Windows muted the app's microphone stream.",
  CHANGE_FAILED: (text) =>
    `Could not switch to that microphone: ${String(text).trim().replace(/\.$/, "")}. The app keeps using the one it had.`,
  PROCESSOR_DIRECT:
    "The app's audio worklets did not load, so your voice goes straight through and the level meters stay still. Copy the results and send them to me.",
  PROCESSOR_FAILED:
    "The voice processor did not start, so the app sends your own voice unchanged. Copy the results and send them to me.",
});

/** How ROUTE_CHANGED names a route method. */
const methodWords = (base) => (base === "element" ? "an audio element (fallback)" : "the app's audio engine");

const STALE = Object.freeze({ stale: true });

function nameOf(err) {
  return err && typeof err === "object" && typeof err.name === "string" && err.name ? err.name : "Error";
}

function messageOf(err) {
  if (err && typeof err === "object" && typeof err.message === "string") return err.message;
  return err === undefined || err === null ? "" : String(err);
}

const round1 = (x) => (typeof x === "number" && Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const secondsToMs = (s) => (typeof s === "number" && Number.isFinite(s) ? round1(s * 1000) : null);

/** The context's frame count now (the latest rendered quantum). */
const frameOf = (ctx) => Math.floor(ctx.currentTime * ctx.sampleRate);

/**
 * The micBus holes of one meter message that start at context frame `from`
 * or later. The meter counts its own frames; its message's contextFrame −
 * frame puts them on the context's clock. A message without both numbers
 * gives none.
 */
function settledHoles(holes, m, from) {
  if (!Number.isFinite(m.contextFrame) || !Number.isFinite(m.frame)) return [];
  const offset = m.contextFrame - m.frame;
  return holes.filter((h) => Number.isFinite(h?.startFrame) && h.startFrame + offset >= from);
}

/**
 * Why `node` cannot sit in the processor slot of `ctx`, or null when it can:
 * the slot needs a node of that context with an input (from inBus) and an
 * output (to outBus).
 */
function slotProblem(node, ctx) {
  const problem = (name, message) => Object.assign(new Error(message), { name });
  if (!node || typeof node !== "object") return problem("TypeError", "The processor factory returned no node.");
  if (node.context !== ctx) return problem("InvalidAccessError", "The processor's node belongs to another audio context.");
  if (!(node.numberOfInputs >= 1 && node.numberOfOutputs >= 1)) {
    return problem("IndexSizeError", "The processor's node needs an input and an output.");
  }
  return null;
}

/** A GainNode at unity gain that keeps the signal mono. */
function monoGain(ctx) {
  const g = ctx.createGain();
  g.gain.value = 1;
  g.channelCount = 1;
  g.channelCountMode = "explicit";
  g.channelInterpretation = "speakers";
  return g;
}

/** `promise` or `ms` later, whichever comes first; the timer never outlives it. */
function within(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => {}),
    new Promise((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const TIMED_OUT = Symbol("timed out");

/** `promise`'s value, or TIMED_OUT after `ms`: everything runs under one lock, so nothing may wait forever. */
function orTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Resolves true once ctx is "running", false at "closed" or after `ms` (the backstop). */
function waitRunning(ctx, ms) {
  if (ctx.state === "running") return Promise.resolve(true);
  return new Promise((resolve) => {
    const ac = new AbortController();
    let timer;
    const done = (value) => {
      ac.abort();
      clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => done(ctx.state === "running"), ms);
    ctx.addEventListener(
      "statechange",
      () => {
        if (ctx.state === "running") done(true);
        else if (ctx.state === "closed") done(false);
      },
      { signal: ac.signal },
    );
  });
}

/** Close a context; never waits more than CLOSE_BACKSTOP_MS and never throws. */
function closeContext(ctx) {
  if (!ctx || ctx.state === "closed") return Promise.resolve();
  let closing;
  try {
    closing = ctx.close();
  } catch {
    return Promise.resolve();
  }
  return within(closing, CLOSE_BACKSTOP_MS);
}

function safeDisconnect(node, target) {
  if (!node) return;
  try {
    if (target === undefined) node.disconnect();
    else node.disconnect(target);
  } catch {
    // Not connected (or the context is closed).
  }
}

/** A FIFO async mutex: every graph mutation runs inside run(fn), one at a time. */
class GraphLock {
  constructor() {
    this._tail = Promise.resolve();
  }

  /** @template T @param {() => Promise<T>|T} fn @returns {Promise<T>} */
  run(fn) {
    const result = this._tail.then(() => fn());
    this._tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}

export class VoiceGraph extends EventTarget {
  /**
   * @param {object} options
   * @param {() => {mic: {deviceId: string, label: string}, output: {deviceId: string, label: string}}} options.getSaved
   *   the validated settings' choices, read afresh by every op
   * @param {() => Promise<{ok: boolean, note: string}>} [options.allowPermission] platform.allowMicPermission
   * @param {(level: string, text: string) => void} [options.log] platform.log: codes and numbers only
   * @param {"app"|"browser"} [options.where] wording of microphone errors
   * @param {"app"|"browser"} [options.shell] only "browser" can end in "needs-gesture"
   * @param {null|((ctx: AudioContext, info: object) => Promise<{node: AudioNode, snapshot?: () => any}>)} [options.processor]
   *   Step 4's processor factory; null uses ac-passthrough. Its node must be made in ctx, with an input (0: inBus;
   *   1: the converted voice) and an output (to outBus); a factory that fails gives ac-passthrough (PROCESSOR_FAILED)
   */
  constructor({ getSaved, allowPermission = null, log = () => {}, where = "app", shell = "app", processor = null } = {}) {
    super();
    this._getSaved = typeof getSaved === "function" ? getSaved : () => null;
    this._allowPermission = typeof allowPermission === "function" ? allowPermission : null;
    this._logFn = typeof log === "function" ? log : () => {};
    this._where = where === "browser" ? "browser" : "app";
    this._shell = shell === "browser" ? "browser" : "app";
    this._processorFactory = typeof processor === "function" ? processor : null;

    this._recovery = new OutputRecovery();
    this._lock = new GraphLock();
    this._epoch = 0;
    this._epochAbort = null; // aborted by stop(): a browser call of an op that is under way is given up at once
    this._running = false;
    this._startPromise = null;
    this._firstOpFed = null;

    this._gen = null; // the current generation
    this._generationCount = 0;
    this._contexts = new Set(); // contexts the graph created and has not seen closed
    this._mic = null;
    this._wantedMic = null;
    this._micGen = 0;
    this._mutedCount = 0;
    this._unlockMs = null;

    this._snapshot = null;
    this._output = null;
    this._lastMethod = null;
    this._routeChanges = [];
    this._routeChanged = null; // { from, to } of the latest route change
    this._routePreference = "auto";
    this._rates = { defaultOutputHz: null, cableInputHz: null };
    this._ratesBusy = false;
    this._ratesAgain = null;
    this._ratesRun = Promise.resolve();

    this._testSource = null;
    this._convertedSource = null;
    this._processorState = null;
    this._processorFailed = false;

    this._taps = new Set();
    this._levels = {
      micRmsDb: -120,
      micPeakDb: -120,
      outRmsDb: -120,
      outPeakDb: -120,
      micHoles: [],
      frame: 0,
      micOpenZeroFrames: 0,
      micHolesTotal: 0,
    };
    this._micHolesTotal = 0;

    this._warnings = [];
    this._warningsKey = "";
    this._changeFailedText = null;

    this._state = { state: "stopped", text: TEXTS.stopped, kind: "info" };
    this._blockedError = null;
    this._stillTrying = null;
    this._lastFailureKey = "";

    this._queue = [];
    this._feeding = false;
    this._timers = { verify: null, retry: null };
    this._meterlessTimer = null;
    this._watchdogTimer = null;
    this._unsubscribeDevices = null;
    this._waiters = new Set();
    this._selfOps = 0;
  }

  // ---------------------------------------------------------------- public

  /**
   * Start the passthrough. Idempotent (a second call returns the same
   * promise); never rejects. Resolves once the first operation has been fed
   * back to the reducer, or after 10 s; the outcome is in `state` and the
   * events, and failures are retried by themselves.
   */
  start() {
    if (this._startPromise) return this._startPromise;
    this._epoch++;
    this._epochAbort = new AbortController();
    this._running = true;
    this._micHolesTotal = 0;
    this._unlockMs = null;
    this._blockedError = null;
    this._stillTrying = null;
    this._unsubscribeDevices = onDeviceChange((snap) => this._onDevices(snap), { where: this._where });
    this._startWatchdog();
    this._startPromise = new Promise((resolve) => {
      let timer = null;
      const finish = () => {
        clearTimeout(timer);
        if (this._firstOpFed === finish) this._firstOpFed = null;
        resolve();
      };
      timer = setTimeout(finish, START_WAIT_MS);
      this._firstOpFed = finish;
    });
    this._setState({ state: "starting", text: TEXTS.starting, kind: "info" });
    this._apply(this._recovery.start(performance.now()));
    this._syncState();
    return this._startPromise;
  }

  /**
   * Stop: the context is closed, the microphone released, routes and taps
   * disposed. An op that waits for the browser (a device list, a microphone)
   * gives up at once, so the teardown never waits behind a call that does
   * not answer.
   */
  async stop() {
    this._epoch++;
    this._epochAbort?.abort();
    this._epochAbort = null;
    this._running = false;
    this._startPromise = null;
    if (this._firstOpFed) this._firstOpFed();
    this._apply(this._recovery.stop());
    this._clearTimer("verify");
    this._clearTimer("retry");
    clearTimeout(this._meterlessTimer);
    this._meterlessTimer = null;
    clearTimeout(this._watchdogTimer);
    this._watchdogTimer = null;
    this._queue.length = 0;
    if (this._unsubscribeDevices) {
      this._unsubscribeDevices();
      this._unsubscribeDevices = null;
    }
    this._settleWaiters(true);
    this._syncState();
    await this._lock.run(async () => {
      if (this._gen) await this._disposeGeneration(this._gen);
      const mic = this._mic;
      if (mic) {
        mic.abort.abort();
        stopStream(mic.stream);
        this._mic = null;
        this._emit("mic", { mic: null });
      }
    });
  }

  /** Edge dev mode, from the Start click: resume the context while the click counts, then try again. */
  resumeFromGesture() {
    const ctx = this.context;
    if (ctx && ctx.state !== "closed") {
      try {
        ctx.resume().catch(() => {});
      } catch {
        // A context that cannot resume is rebuilt by the retry.
      }
    }
    if (!this._running) {
      this.start();
      return;
    }
    this._feed({ type: "user-retry" });
  }

  /**
   * "Check the microphone". Running: the device list and the native rates
   * (Windows' default output, CABLE Input, the routed device) are read again
   * (no new getUserMedia), so a setting the user just fixed in Windows shows
   * at once. Waiting or blocked: try again now. Stopped: start().
   * Resolves when that is over: { ok, state }.
   */
  async retry() {
    if (!this._running) {
      await this.start();
      return { ok: this._recovery.phase === "running", state: this.state };
    }
    const phase = this._recovery.phase;
    if (phase === "running") {
      const epoch = this._epoch;
      let rates = null;
      try {
        rates = this._onDevices(await readDevices({ where: this._where, signal: this._epochAbort?.signal ?? null }));
      } catch (err) {
        if (epoch === this._epoch) this._log("warn", `devices read failed ${nameOf(err)}`);
      }
      if (epoch === this._epoch) await (rates ?? this._readRates({ cable: true }));
      return { ok: epoch === this._epoch && this._recovery.phase === "running", state: this.state };
    }
    if (phase === "waiting" || phase === "blocked") this._feed({ type: "user-retry" });
    return this._waitSettled();
  }

  /** The user picked a microphone (main.js saved it first). → Promise<{ok, state}> */
  setMic(deviceId = null) {
    if (deviceId === null || deviceId === "") this._wantedMic = null;
    return this._request({ type: "mic-request", reason: "user" });
  }

  /**
   * The user picked the playback device for the voice (null = automatic).
   * main.js saved it first: every op reads getSaved() afresh, so the id
   * itself is not needed here. → Promise<{ok, state}>
   */
  setOutput(deviceId = null) { // eslint-disable-line no-unused-vars
    return this._request({ type: "rebuild-request", reason: "output" });
  }

  /** Diagnostics only (not saved): "auto" or "element" (the audio element route). → Promise<{ok, state}> */
  setRoutePreference(preference) {
    const next = preference === "element" ? "element" : "auto";
    if (next === this._routePreference) return Promise.resolve({ ok: true, state: this.state });
    this._routePreference = next;
    if (this._output) this._output = { ...this._output, routePreference: next };
    return this._request({ type: "rebuild-request", reason: "route" });
  }

  /**
   * Step 4's processor factory. Before start(): stored. After: swapped in
   * place under the lock (one possible click); null goes back to ac-passthrough.
   * A factory that fails gives ac-passthrough and PROCESSOR_FAILED, as in a
   * rebuild; the voice never stops for it. Never rejects.
   */
  setProcessor(factory) {
    this._processorFactory = typeof factory === "function" ? factory : null;
    if (!this._running) return Promise.resolve();
    return this._lock.run(async () => {
      const gen = this._gen;
      if (!gen || gen.disposed || !gen.processor) return;
      const epoch = this._epoch;
      let previousState = null;
      try {
        previousState = gen.processorHandle?.snapshot?.() ?? null;
      } catch {
        previousState = null;
      }
      const built = await this._makeProcessor(gen, "processor", previousState);
      if (epoch !== this._epoch || this._gen !== gen || gen.disposed) {
        safeDisconnect(built.node);
        return;
      }
      // The old processor comes out only once a new one is connected.
      this._installProcessor(gen, built);
      if (this._output) this._output = { ...this._output, processor: gen.processorKind };
      this._recomputeWarnings();
    });
  }

  /** The tone check: inBus is fed by `stream` instead of micBus (null: the microphone again). Kept across rebuilds. */
  setTestSource(stream) {
    this._testSource = stream ?? null;
    this._syncState();
    return this._lock.run(async () => {
      const gen = this._gen;
      if (gen && !gen.disposed && gen.inBus) this._applyTestSource(gen, true);
    });
  }

  /** Step 4/7: the converted voice into the processor's input 1. Kept across rebuilds. */
  setConvertedSource(stream) {
    this._convertedSource = stream ?? null;
    return this._lock.run(async () => {
      const gen = this._gen;
      if (gen && !gen.disposed && gen.processor) this._applyConvertedSource(gen, true);
    });
  }

  /**
   * A tap on the graph (the checks' recorders). build({ctx, micBus, inBus,
   * outBus, micStream, generation, route}) → Promise<{dispose(info)}>. Built
   * under the lock now when the voice runs, and (unless once) again after
   * every verified rebuild. dispose({generationEnded: true}) is called when
   * its generation ends (a once-tap is then gone), dispose({generationEnded:
   * false}) by removeTap(). A once-tap is built at most once: one whose build
   * fails or takes too long is gone too (tap-error). → removeTap() (a promise).
   */
  addTap(build, { once = false } = {}) {
    const tap = { build, once: Boolean(once), handle: null, handleGen: null, built: false, removed: false };
    this._taps.add(tap);
    if (this._recovery.phase === "running" && this._gen?.routed) this._buildTap(tap);
    return () => {
      tap.removed = true;
      return this._lock.run(async () => {
        const handle = tap.handle;
        const gen = tap.handleGen;
        tap.handle = null;
        tap.handleGen = null;
        gen?.taps.delete(tap);
        this._taps.delete(tap);
        if (handle) this._disposeTapHandle(handle, { generationEnded: false, generation: gen?.n ?? null });
      });
    };
  }

  /**
   * Step 7: a fresh MediaStreamAudioDestination (mono) fed by micBus. Every
   * rebuild ends it (its context closes; see the "rebuilt" event); a change
   * of microphone does not. → { stream, dispose() }
   */
  newEngineInput() {
    const gen = this._gen;
    if (!gen || gen.disposed || !gen.micBus) throw new Error("The voice is not running yet.");
    const node = gen.ctx.createMediaStreamDestination();
    node.channelCount = 1;
    node.channelCountMode = "explicit";
    gen.micBus.connect(node);
    const input = { node, gen, ended: false };
    gen.engineInputs.add(input);
    return { stream: node.stream, dispose: () => this._endEngineInput(input) };
  }

  /** Counts for the results (no ids): open contexts, sources on micBus, built taps, routed. */
  debugCounts() {
    let contexts = 0;
    for (const ctx of this._contexts) {
      if (ctx.state === "closed") this._contexts.delete(ctx);
      else contexts++;
    }
    let taps = 0;
    for (const tap of this._taps) if (tap.handle) taps++;
    return {
      contexts,
      micSources: this._gen && !this._gen.disposed ? this._gen.micSources.size : 0,
      taps,
      routed: Boolean(this._gen?.routed),
    };
  }

  get state() {
    return this._state.state;
  }

  /** The current state with its text and kind: { state, text, kind, code? }. */
  get stateInfo() {
    return { ...this._state };
  }

  get context() {
    return this._gen && !this._gen.disposed ? this._gen.ctx : null;
  }

  get generation() {
    return this._generationCount;
  }

  get epoch() {
    return this._epoch;
  }

  get snapshot() {
    return this._snapshot;
  }

  /** The live microphone stream (measure.js makes its fresh reference source from it), or null. */
  get micStream() {
    const m = this._mic;
    return m && m.track.readyState === "live" ? m.stream : null;
  }

  /** Counts the microphone sources fed into micBus (a new one per rebuild and per microphone swap). */
  get micGen() {
    return this._micGen;
  }

  /** { entry, how, standIn, settings, openedInMs, unlockMs, mutedCount, track } | null */
  get mic() {
    const m = this._mic;
    if (!m) return null;
    return {
      entry: m.entry,
      how: m.how,
      standIn: m.standIn,
      settings: m.settings,
      openedInMs: m.openedInMs,
      unlockMs: this._unlockMs,
      mutedCount: this._mutedCount,
      track: m.track,
    };
  }

  /**
   * { entry, how, method, tried, routePreference, routeChanges, contextSink,
   *   sinkRateHz, contextRateHz, baseLatencyMs, outputLatencyMs, processor } | null
   */
  get output() {
    const o = this._output;
    if (!o) return null;
    return {
      ...o,
      tried: o.tried.map((t) => ({ ...t })),
      routeChanges: this._routeChanges.map((c) => ({ ...c })),
    };
  }

  /** { defaultOutputHz, cableInputHz } */
  get rates() {
    return { ...this._rates };
  }

  /** [{code, text}] with the real device names (for results: warningsWith(reportLabel)). */
  get warnings() {
    return this._warnings.map((w) => ({ ...w }));
  }

  get recoveries() {
    return this._recovery.log;
  }

  get startRecord() {
    return this._recovery.startRecord;
  }

  /**
   * The last meter message, plus micHolesTotal: micBus 8–11 ms zero holes
   * since start, except those in the first 10 s of each new microphone
   * source (start, rebuild, microphone swap), which come from the source's
   * own start rather than from the clocks. micHoles is the meter's own list.
   */
  get levels() {
    return { ...this._levels, micHoles: this._levels.micHoles.slice(), micHolesTotal: this._micHolesTotal };
  }

  /**
   * The warnings with every device name passed through nameOf (reportLabel
   * for the results). Same codes and order as `warnings`.
   * @param {(label: string) => string} [nameOf]
   */
  warningsWith(nameOf = (s) => s) {
    const list = deviceWarnings(this._warningInput(), nameOf);
    if (this._mic?.muted) list.push({ code: "MIC_MUTED", text: GRAPH_TEXTS.MIC_MUTED });
    if (this._changeFailedText) list.push({ code: "CHANGE_FAILED", text: this._changeFailedText });
    if (this._routeChanged) {
      const { from, to } = this._routeChanged;
      list.push({ code: "ROUTE_CHANGED", text: WARNINGS.ROUTE_CHANGED(methodWords(from), methodWords(to)) });
    }
    if (this._gen && !this._gen.disposed && this._gen.processorKind === "direct") {
      list.push({ code: "PROCESSOR_DIRECT", text: GRAPH_TEXTS.PROCESSOR_DIRECT });
    }
    if (this._processorFailed) list.push({ code: "PROCESSOR_FAILED", text: GRAPH_TEXTS.PROCESSOR_FAILED });
    return list;
  }

  // ---------------------------------------------------------------- reducer wiring

  /** Feed one event to the reducer and carry out its actions. Re-entrant calls are queued. */
  _feed(ev) {
    if (!this._running) return;
    this._queue.push(ev);
    if (this._feeding) return;
    this._feeding = true;
    try {
      while (this._queue.length > 0 && this._running) {
        const next = this._queue.shift();
        this._apply(this._recovery.event(next, performance.now()));
      }
    } finally {
      this._feeding = false;
    }
    this._syncState();
  }

  _apply(actions) {
    for (const a of actions ?? []) {
      switch (a.do) {
        case "resume":
        case "rebuild":
        case "reopen-mic":
          this._startOp(a);
          break;
        case "set-timer":
          this._setTimer(a.id, a.ms);
          break;
        case "clear-timer":
          this._clearTimer(a.id);
          break;
        case "report":
          this._report(a);
          break;
        default:
          break;
      }
    }
  }

  _setTimer(id, ms) {
    this._clearTimer(id);
    const epoch = this._epoch;
    this._timers[id] = setTimeout(() => {
      this._timers[id] = null;
      if (epoch === this._epoch) this._feed({ type: "timer", id });
    }, ms);
    if (id === "verify") this._meterlessHeartbeat(ms);
  }

  _clearTimer(id) {
    if (this._timers[id] !== null && this._timers[id] !== undefined) clearTimeout(this._timers[id]);
    this._timers[id] = null;
  }

  /** Without a meter worklet, a context whose clock moves on after the op counts as the heartbeat. */
  _meterlessHeartbeat(verifyMs) {
    const gen = this._gen;
    if (!gen || gen.meter) return;
    clearTimeout(this._meterlessTimer);
    const epoch = this._epoch;
    this._meterlessTimer = setTimeout(() => {
      this._meterlessTimer = null;
      if (epoch !== this._epoch || this._gen !== gen || !gen.routed) return;
      if (this._recovery.phase === "verifying" && gen.ctx.currentTime > gen.verifyTime) {
        this._feed({ type: "heartbeat", routed: true });
      }
    }, Math.max(50, Math.min(METERLESS_CHECK_MS, verifyMs / 2)));
  }

  /** Run a reducer op under the lock; its result is fed back as op-done unless it went stale. */
  _startOp(action) {
    const epoch = this._epoch;
    const name = action.do;
    this._lock
      .run(async () => {
        if (epoch !== this._epoch) return STALE;
        try {
          if (name === "resume") return await this._opResume(epoch);
          if (name === "rebuild") return await this._opRebuild(action, epoch);
          return await this._opReopenMic(epoch);
        } catch (err) {
          return epoch === this._epoch ? { ok: false, error: err } : STALE;
        }
      })
      .then(
        (res) => this._opDone(name, res, epoch),
        (err) => this._opDone(name, { ok: false, error: err }, epoch),
      );
  }

  _opDone(name, res, epoch) {
    if (epoch !== this._epoch || !res || res.stale) return;
    const gen = this._gen;
    if (res.ok && gen && !gen.disposed) {
      gen.heartbeatAfter = frameOf(gen.ctx);
      gen.verifyTime = gen.ctx.currentTime;
    }
    if (!res.ok) this._logFailure(name, res.error);
    this._feed({ type: "op-done", op: name, ok: Boolean(res.ok), error: res.ok ? undefined : res.error, kept: res.kept === true });
    if (this._firstOpFed) this._firstOpFed();
  }

  _report(a) {
    switch (a.kind) {
      case "lost": {
        this._stillTrying = null;
        this._blockedError = null;
        this._lastFailureKey = "";
        this._log("warn", `recovery lost ${a.outage?.cause ?? "?"}`);
        this._emit("recovery", { kind: "lost", outage: a.outage });
        break;
      }
      case "still-trying": {
        this._stillTrying = { lostAtMs: a.outage?.lostAtMs ?? null, sinceMs: a.sinceMs };
        this._log(
          "warn",
          `recovery still-trying ${a.outage?.cause ?? "?"} ${Math.round(a.sinceMs)} ms ${a.outage?.attempts ?? 0} attempts`,
        );
        this._emit("recovery", { kind: "still-trying", outage: a.outage, sinceMs: a.sinceMs });
        break;
      }
      case "blocked": {
        this._blockedError = a.error ?? null;
        const e = a.error ?? {};
        const detail = [nameOf(e), e.code, e.kind, e.errorName].filter((x) => typeof x === "string" && x).join(" ");
        this._log("warn", `recovery blocked ${a.reason} ${detail}`);
        this._emit("recovery", { kind: "blocked", outage: a.outage, reason: a.reason, error: a.error });
        break;
      }
      case "started":
      case "back":
      case "applied": {
        this._stillTrying = null;
        this._blockedError = null;
        this._lastFailureKey = "";
        const r = a.record ?? {};
        const head = a.kind === "started" ? "first start" : `recovery ${a.kind} ${r.cause ?? ""}`.trim();
        const ms = Math.round(a.kind === "back" ? r.outageMs : r.ms);
        let line = `${head} ${ms} ms ${r.attempts} attempts steps ${(r.steps ?? []).join(",")}`;
        if (a.kind === "started") {
          line += ` unlock ${this._unlockMs ?? "-"} ms mic opened in ${this._mic?.openedInMs ?? "-"} ms`;
        }
        if (a.kind === "back") line += ` app ${r.appMs ?? "-"} ms wait ${r.waitMs ?? "-"} ms micToo ${Boolean(r.micToo)}`;
        this._log("info", line);
        if (a.kind === "applied" && this._changeFailedText) {
          this._changeFailedText = null;
        }
        this._emit("recovery", { kind: a.kind, record: a.record });
        this._afterUp();
        break;
      }
      case "change-failed": {
        const text = micErrorText(a.error, this._where);
        this._changeFailedText = GRAPH_TEXTS.CHANGE_FAILED(text);
        for (const w of this._waiters) w.changeFailed = true;
        this._log("warn", `recovery change-failed ${nameOf(a.error)} ${a.error?.code ?? ""}`.trim());
        this._recomputeWarnings();
        this._emit("recovery", { kind: "change-failed", error: a.error });
        break;
      }
      default:
        break;
    }
  }

  /** After "started", "back" and "applied": taps, rates, warnings, and what moved meanwhile. */
  _afterUp() {
    const gen = this._gen;
    if (gen && gen.routed) {
      for (const tap of this._taps) {
        if (!tap.removed && tap.handleGen !== gen && !(tap.once && tap.built)) this._buildTap(tap);
      }
    }
    this._readRates({ cable: true });
    this._recomputeWarnings();
    if (this._snapshot) this._checkMoves(this._snapshot);
  }

  /** A request from the user: fed to the reducer; resolves when the change is over. */
  _request(ev) {
    if (!this._running) return Promise.resolve({ ok: false, state: this.state });
    if (ev.type === "mic-request" && this._changeFailedText) {
      this._changeFailedText = null;
      this._recomputeWarnings();
    }
    const waiter = this._newWaiter();
    this._feed(ev);
    this._checkWaiters();
    return waiter.promise;
  }

  _newWaiter() {
    const waiter = { changeFailed: false, done: false, resolve: null, timer: null, promise: null };
    waiter.promise = new Promise((resolve) => {
      waiter.resolve = resolve;
    });
    waiter.timer = setTimeout(() => this._finishWaiter(waiter), SETTLE_WAIT_MS);
    this._waiters.add(waiter);
    return waiter;
  }

  _waitSettled() {
    const waiter = this._newWaiter();
    this._checkWaiters();
    return waiter.promise;
  }

  _finishWaiter(waiter) {
    if (waiter.done) return;
    waiter.done = true;
    clearTimeout(waiter.timer);
    this._waiters.delete(waiter);
    const ok = this._recovery.phase === "running" && !waiter.changeFailed;
    waiter.resolve({ ok, state: this.state });
  }

  /** Waiters resolve once the reducer is not in the middle of an op or its verification. */
  _checkWaiters() {
    const phase = this._recovery.phase;
    if (phase === "recovering" || phase === "verifying") return;
    for (const w of [...this._waiters]) this._finishWaiter(w);
  }

  _settleWaiters() {
    for (const w of [...this._waiters]) this._finishWaiter(w);
  }

  // ---------------------------------------------------------------- state

  _setState(next) {
    const cur = this._state;
    if (cur.state === next.state && cur.text === next.text && cur.kind === next.kind && cur.code === next.code) return;
    this._state = next;
    if (cur.state !== next.state) this._log(next.kind === "error" || next.kind === "warn" ? "warn" : "info", `state ${next.state}`);
    const detail = { state: next.state, text: next.text, kind: next.kind };
    if (next.code !== undefined) detail.code = next.code;
    this._emit("state", detail);
  }

  _syncState() {
    this._setState(this._computeState());
    this._checkWaiters();
  }

  _computeState() {
    if (!this._running) return { state: "stopped", text: TEXTS.stopped, kind: "info" };
    const phase = this._recovery.phase;
    const o = this._recovery.outage;
    if (phase === "idle") return { state: "stopped", text: TEXTS.stopped, kind: "info" };
    if (phase === "running") {
      if (this._testSource) return { state: "running", text: TEXTS.testSource, kind: "warn", code: "TEST_SOURCE" };
      if (this._mic?.standIn) {
        const stand = this._warnings.find((w) => w.code === "STAND_IN");
        const text = stand ? stand.text : deviceWarnings({ ...this._warningInput(), standIn: true }).find((w) => w.code === "STAND_IN")?.text;
        return { state: "running", text: text ?? TEXTS.running, kind: "warn", code: "STAND_IN" };
      }
      return { state: "running", text: TEXTS.running, kind: "ok" };
    }
    if (phase === "blocked") return this._blockedState(o);
    if (o && o.kind === "change") return { state: "switching", text: TEXTS.switching, kind: "info" };
    const err = o?.lastError ?? null;
    const still = this._stillTrying && o && this._stillTrying.lostAtMs === o.lostAtMs ? this._stillTrying : null;
    const stillText = still ? ` still trying (${Math.round(still.sinceMs / 1000)} s)` : "";
    if (o && o.kind === "start") {
      if (!err) return { state: "starting", text: TEXTS.starting + stillText, kind: "info" };
      const kind = classifyError(err);
      if (kind === "busy") return { state: "mic-busy", text: TEXTS.micBusy, kind: "warn", code: err.code ?? nameOf(err) };
      if (kind === "missing" && nameOf(err) === "MicError") return { state: "no-mic", text: TEXTS.noMic, kind: "warn", code: "NO_MIC" };
      if (kind === "missing") return { state: "no-cable", text: WARNINGS.NO_CABLE, kind: "warn", code: "NO_CABLE" };
      return { state: "starting", text: still ? TEXTS.starting + stillText : TEXTS.startingAgain, kind: "info" };
    }
    const cause = o?.cause ?? "render-error";
    if (err) {
      const kind = classifyError(err);
      if (kind === "missing" && nameOf(err) === "MicError") return { state: "no-mic", text: TEXTS.noMic, kind: "warn", code: "NO_MIC" };
      if (kind === "missing") {
        return { state: "recovering", text: recoveringText(cause) + TEXTS.waitingForCable, kind: "warn", code: cause };
      }
    }
    return { state: "recovering", text: recoveringText(cause) + stillText, kind: "warn", code: cause };
  }

  _blockedState(o) {
    const err = this._blockedError ?? o?.lastError ?? null;
    const kind = classifyError(err);
    if (kind === "needs-gesture") return { state: "needs-gesture", text: TEXTS.needsGesture, kind: "info", code: "NEEDS_GESTURE" };
    if (nameOf(err) === "MicError") {
      const text = messageOf(err) || micErrorText(err?.cause ?? err, this._where);
      return { state: "mic-blocked", text, kind: "error", code: err?.code ?? "blocked" };
    }
    const name = (err && typeof err.errorName === "string" && err.errorName) || nameOf(err);
    return { state: "sink-refused", text: sinkRefusedText(name), kind: "error", code: name };
  }

  // ---------------------------------------------------------------- ops

  /** The op's cause for factories and "rebuilt": the outage's cause, "start", or the change's reason. */
  _cause(initial) {
    const o = this._recovery.outage;
    if (o && typeof o.cause === "string") return o.cause;
    return initial ? "start" : "change";
  }

  /**
   * rebuild {reopenMic, mode, initial}: close the current generation, read
   * the devices, reopen the microphone when needed (the live one is reused
   * otherwise), choose the output, build a new context and route it.
   */
  async _opRebuild({ reopenMic = false, mode = "full", initial = false }, epoch) {
    const alive = () => epoch === this._epoch;
    // Browser calls (a device list, a microphone) are given up after 15 s (devices.js), or at once by stop().
    const signal = this._epochAbort?.signal ?? null;
    const cause = this._cause(initial);
    const old = this._gen;

    // Edge: a generation that only waited for a click. Start resumed it; use it.
    if (old && old.awaitingGesture && !old.disposed && !reopenMic && this._micLive() && old.ctx.state !== "closed") {
      const res = await this._retryWaitingGeneration(old, epoch, { initial, cause, mode });
      if (res) return res;
    }

    // No cable on the first start: the meters-only generation stays while the cable is still missing.
    const keepMeters = Boolean(old && old.metersOnly && !old.disposed && initial && !reopenMic && this._micLive());
    if (old && !keepMeters) await this._disposeGeneration(old);
    if (!alive()) return STALE;

    const snap = await readDevices({ unlockLabels: initial, where: this._where, signal });
    if (!alive()) return STALE;
    if (initial && snap.unlockMs !== null) this._unlockMs = snap.unlockMs;
    this._takeSnapshot(snap);

    const saved = this._saved();
    let micChanged = false;
    if (reopenMic || !this._micLive()) {
      const choice = chooseMic(snap.inputs, { saved: saved.mic, wanted: this._wantedMic });
      if (!choice.entry) return { ok: false, error: snap.unlockError ?? noMicError(this._where) };
      const opened = await openMic(choice.entry, { where: this._where, signal });
      if (!alive()) {
        stopStream(opened.stream);
        return STALE;
      }
      this._installMic(opened, choice);
      micChanged = true;
    }

    const outChoice = chooseOutput(snap.outputs, { saved: saved.output });
    if (!outChoice.entry) {
      this._setOutput(outChoice, { method: null, tried: [], gen: null, route: null });
      if (keepMeters || !initial) return { ok: false, error: new SinkError("missing") };
      // The first start without a cable: meters move, nothing plays ({type: "none"} sink, never routed).
      const gen = await this._buildGeneration(cause, epoch);
      if (!gen) return STALE;
      await this._selfOp(async () => {
        try {
          await within(gen.ctx.setSinkId({ type: "none" }), NONE_SINK_MS);
        } catch {
          // The default device then: nothing is connected to the destination anyway.
        }
      });
      if (!alive()) {
        await this._disposeGeneration(gen);
        return STALE;
      }
      gen.metersOnly = true;
      gen.ctx.resume().catch(() => {});
      return { ok: false, error: new SinkError("missing") };
    }
    if (keepMeters) {
      await this._disposeGeneration(old);
      if (!alive()) return STALE;
    }

    const gen = await this._buildGeneration(cause, epoch);
    if (!gen) return STALE;
    return this._routeGeneration(gen, { epoch, outChoice, snap, mode, initial, cause, micChanged });
  }

  /** Edge: Start resumed the kept context; route it if the output is still the same. null → rebuild instead. */
  async _retryWaitingGeneration(gen, epoch, { initial, cause }) {
    const alive = () => epoch === this._epoch;
    const snap = await readDevices({ where: this._where, signal: this._epochAbort?.signal ?? null });
    if (!alive()) return STALE;
    this._takeSnapshot(snap);
    const outChoice = chooseOutput(snap.outputs, { saved: this._saved().output });
    if (!outChoice.entry || !gen.route || outChoice.entry.deviceId !== gen.route.deviceId) return null;
    if (this._gen !== gen || gen.disposed || gen.ctx.state === "closed") return null;
    const verdict = await this._startRendering(gen, epoch);
    if (verdict) return verdict;
    return this._commitRoute(gen, gen.route, { outChoice, initial, cause, micChanged: false });
  }

  /**
   * Steps 6 to 8: route outBus to the device (inside the self-op guard,
   * waiting for "running" again when setSinkId interrupted a running
   * context), get the context rendering, and commit the route.
   */
  async _routeGeneration(gen, { epoch, outChoice, snap, mode, initial, cause, micChanged }) {
    const alive = () => epoch === this._epoch;
    const { ctx } = gen;
    const deviceId = outChoice.entry.deviceId;
    const sibling = siblingOutput(snap.outputs, this._mic?.entry ?? null);
    let route;
    try {
      route = await this._selfOp(async () => {
        const wasRunning = ctx.state === "running";
        const r = await routeOutput(ctx, deviceId, {
          source: gen.outBus,
          mode,
          lastMethod: this._lastMethod,
          prefer: this._routePreference === "element" ? "element" : null,
          deviceListed: snap.outputs.some((d) => d.deviceId === deviceId),
          contextSinkId: sibling?.deviceId ?? null,
          allowPermission: mode === "full" ? this._allowPermission : null,
        });
        // Chromium suspends a running context during setSinkId and sets it running again only
        // after the sink has changed. A new context may also have started during the call; in the
        // app it always starts by itself.
        if (alive() && ctx.state !== "running" && (wasRunning || gen.sawRunning || this._shell === "app")) {
          await waitRunning(ctx, RUNNING_BACKSTOP_MS);
        }
        return r;
      });
    } catch (err) {
      if (!alive()) {
        await this._disposeGeneration(gen);
        return STALE;
      }
      const tried = Array.isArray(err?.tried) ? err.tried : [];
      this._setOutput(outChoice, { method: null, tried, gen, route: null });
      this._log("warn", `route failed ${err?.kind ?? nameOf(err)} (${triedSummary(tried)})`);
      if (nameOf(err) === "SinkError" && err.kind === "needs-gesture" && this._shell !== "browser") {
        // The app never waits for a click (WebView2 may autoplay): retried like any passing failure.
        return { ok: false, error: new SinkError("transient", "", { tried, errorName: err.errorName }) };
      }
      return { ok: false, error: err };
    }
    if (!alive() || gen.disposed) {
      try {
        route.dispose();
      } catch {
        // Gone with its context.
      }
      await this._disposeGeneration(gen);
      return STALE;
    }
    gen.route = route;
    route.onLost(() => {
      if (this._gen === gen && gen.routed) {
        gen.routed = false;
        this._feed({ type: "sink-changed", matches: false });
      }
    });
    const verdict = await this._startRendering(gen, epoch);
    if (verdict) {
      if (verdict.error?.name === "NeedsGesture") this._setOutput(outChoice, { method: route.method, tried: route.tried, gen, route });
      return verdict;
    }
    return this._commitRoute(gen, route, { outChoice, initial, cause, micChanged });
  }

  /**
   * Step 7: a context that is not running is resumed (not awaited). In Edge
   * only, a new context may need a click: wait up to 800 ms, then ask for one
   * (the context is kept; Start resumes it). The app never waits here.
   * → null to go on, or the op's result.
   */
  async _startRendering(gen, epoch) {
    const { ctx } = gen;
    if (ctx.state === "running") return null;
    ctx.resume().catch(() => {});
    if (this._shell !== "browser") return null;
    await waitRunning(ctx, GESTURE_WAIT_MS);
    if (epoch !== this._epoch) {
      await this._disposeGeneration(gen);
      return STALE;
    }
    if (ctx.state !== "running" && globalThis.navigator?.userActivation?.hasBeenActive !== true) {
      gen.awaitingGesture = true;
      return { ok: false, error: { name: "NeedsGesture", message: "The page may not play sound before a click." } };
    }
    return null;
  }

  /** Step 8: the generation is routed; the route method is recorded (a change of method is a warning). */
  _commitRoute(gen, route, { outChoice, initial, cause, micChanged }) {
    gen.awaitingGesture = false;
    gen.routed = true;
    const base = methodBase(route.method);
    if (this._lastMethod && this._lastMethod !== base) {
      this._routeChanges.push({ at: new Date().toISOString(), from: this._lastMethod, to: base, cause });
      this._routeChanged = { from: this._lastMethod, to: base };
      this._log("warn", `route change ${this._lastMethod} to ${base} (${cause})`);
    }
    this._lastMethod = base;
    this._setOutput(outChoice, { method: route.method, tried: route.tried, gen, route });
    this._log(base === "context" && route.method === "context" ? "info" : "warn", `route ${route.method} (${triedSummary(route.tried)})`);
    this._recomputeWarnings();
    if (!initial) this._emit("rebuilt", { generation: gen.n, cause, micChanged, engineInputsEnded: true });
    return { ok: true };
  }

  /** reopen-mic: open the microphone again and swap it into micBus; taps and engine inputs stay. */
  async _opReopenMic(epoch) {
    const alive = () => epoch === this._epoch;
    const signal = this._epochAbort?.signal ?? null;
    let snap;
    try {
      snap = await readDevices({ where: this._where, signal });
    } catch (err) {
      // No device list (it did not come in time): a user's change fails, and the live microphone stays.
      if (!alive()) return STALE;
      return { ok: false, error: err, kept: this._micLive() };
    }
    if (!alive()) return STALE;
    this._takeSnapshot(snap);
    const saved = this._saved();
    const choice = chooseMic(snap.inputs, { saved: saved.mic, wanted: this._wantedMic });
    if (!choice.entry) return { ok: false, error: noMicError(this._where), kept: this._micLive() };
    let opened;
    try {
      opened = await openMic(choice.entry, { where: this._where, signal });
    } catch (err) {
      if (!alive()) return STALE;
      return { ok: false, error: err, kept: this._micLive() };
    }
    if (!alive()) {
      stopStream(opened.stream);
      return STALE;
    }
    this._installMic(opened, choice);
    return { ok: true };
  }

  /**
   * resume: the context's resume(), raced against a second "error" on it
   * (Chromium fails a resume that way when the device fails again) and a
   * 500 ms cap (a pending resume settles only once rendering runs).
   */
  async _opResume(epoch) {
    const gen = this._gen;
    const ctx = gen && !gen.disposed ? gen.ctx : null;
    if (!ctx || ctx.state === "closed") {
      return { ok: false, error: { name: "InvalidStateError", message: "There is no audio engine to resume." } };
    }
    const ac = new AbortController();
    let timer = null;
    const failedAgain = new Promise((resolve) => {
      ctx.addEventListener("error", () => resolve({ name: "ResumeFailed", message: "The audio device failed again." }), {
        signal: ac.signal,
        once: true,
      });
    });
    const capped = new Promise((resolve) => {
      timer = setTimeout(
        () => resolve({ name: "TimeoutError", message: `resume() did not finish within ${RESUME_CAP_MS} ms.` }),
        RESUME_CAP_MS,
      );
    });
    let resumed;
    try {
      resumed = ctx.resume().then(
        () => null,
        (err) => ({ name: nameOf(err), message: redact(messageOf(err)) }),
      );
    } catch (err) {
      resumed = Promise.resolve({ name: nameOf(err), message: redact(messageOf(err)) });
    }
    let error;
    try {
      error = await this._selfOp(() => Promise.race([resumed, failedAgain, capped]));
    } finally {
      clearTimeout(timer);
      ac.abort();
    }
    if (epoch !== this._epoch) return STALE;
    return error ? { ok: false, error } : { ok: true };
  }

  // ---------------------------------------------------------------- generations

  /**
   * Step 5: a new context with its nodes. The generation is current from
   * here (its events count), but not routed until _commitRoute.
   * → the generation, or null when the op went stale meanwhile (then disposed).
   */
  async _buildGeneration(cause, epoch) {
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
    this._contexts.add(ctx);
    const gen = {
      n: ++this._generationCount,
      ctx,
      abort: new AbortController(),
      micBus: null,
      inBus: null,
      outBus: null,
      micSource: null,
      micSources: new Set(),
      micHolesFrom: 0, // context frame from which micBus holes count (see MIC_SETTLE_MS)
      testNode: null,
      convertedNode: null,
      processor: null,
      processorHandle: null,
      processorKind: null,
      meter: null,
      keeper: null,
      route: null,
      routed: false,
      metersOnly: false,
      awaitingGesture: false,
      sawRunning: false,
      disposed: false,
      engineInputs: new Set(),
      taps: new Set(),
      heartbeatAfter: 0,
      verifyTime: 0,
      wdTime: null,
      wdStill: 0,
      wdElement: null,
      wdElementStill: 0,
      workletsLoaded: false,
    };
    this._gen = gen;
    this._listenContext(gen);

    const load = (file) => {
      try {
        return ctx.audioWorklet.addModule(workletUrl(file));
      } catch (err) {
        return Promise.reject(err);
      }
    };
    const loads = await orTimeout(Promise.allSettled([load("passthrough.worklet.js"), load("meter.worklet.js")]), STEP_BACKSTOP_MS);
    const late = { status: "rejected", reason: { name: "TimeoutError" } };
    const [passthrough, meter] = loads === TIMED_OUT ? [late, late] : loads;
    if (epoch !== this._epoch || gen.disposed) {
      await this._disposeGeneration(gen);
      return null;
    }
    gen.workletsLoaded = passthrough.status === "fulfilled";
    if (passthrough.status !== "fulfilled") this._log("warn", `worklet passthrough failed ${nameOf(passthrough.reason)}`);
    if (meter.status !== "fulfilled") this._log("warn", `worklet meter failed ${nameOf(meter.reason)}`);

    gen.micBus = monoGain(ctx);
    gen.inBus = monoGain(ctx);
    gen.outBus = monoGain(ctx);
    if (this._mic) this._connectMicSource(gen, this._mic.stream);
    this._applyTestSource(gen, false);

    const built = await this._makeProcessor(gen, cause, this._processorState);
    if (epoch !== this._epoch || gen.disposed) {
      safeDisconnect(built.node);
      await this._disposeGeneration(gen);
      return null;
    }
    if (!this._installProcessor(gen, built)) {
      // Not even a plain gain could be connected: this context cannot carry the voice. The op fails and is tried again.
      throw Object.assign(new Error("The voice processor could not be connected."), { name: "InvalidStateError" });
    }

    if (meter.status === "fulfilled") {
      try {
        gen.meter = new AudioWorkletNode(ctx, "ac-meter", {
          numberOfInputs: 2,
          numberOfOutputs: 0,
          channelCount: 1,
          channelCountMode: "explicit",
          channelInterpretation: "speakers",
          processorOptions: { windowFrames: 4800 },
        });
        gen.micBus.connect(gen.meter, 0, 0);
        gen.outBus.connect(gen.meter, 0, 1);
        gen.meter.port.addEventListener("message", (ev) => this._onMeter(gen, ev), { signal: gen.abort.signal });
        gen.meter.port.start();
      } catch (err) {
        gen.meter = null;
        this._log("warn", `meter failed ${nameOf(err)}`);
      }
    }
    if (!gen.meter) {
      // Something must keep pulling the graph, or Chromium may park a silent sink after 30 s.
      gen.keeper = ctx.createMediaStreamDestination();
      gen.outBus.connect(gen.keeper);
    }
    return gen;
  }

  /**
   * The processor for the slot: Step 4's factory, else ac-passthrough, else
   * a plain gain (direct). A factory that throws, takes too long, or gives a
   * node that cannot sit in the slot has failed: ac-passthrough takes its
   * place. → { node, handle, kind, fromFactory, failed }
   */
  async _makeProcessor(gen, cause, previousState) {
    const { ctx } = gen;
    if (!this._processorFactory) return { ...this._fallbackProcessor(gen), failed: false };
    try {
      const making = Promise.resolve(this._processorFactory(ctx, { generation: gen.n, cause, previousState }));
      const handle = await orTimeout(making, STEP_BACKSTOP_MS);
      if (handle === TIMED_OUT) {
        making.then((h) => safeDisconnect(h?.node), () => {});
        throw Object.assign(new Error("The processor factory took too long."), { name: "TimeoutError" });
      }
      const problem = slotProblem(handle?.node, ctx);
      if (problem) {
        if (handle?.node?.context === ctx) safeDisconnect(handle.node);
        throw problem;
      }
      return { node: handle.node, handle, kind: "worklet", fromFactory: true, failed: false };
    } catch (err) {
      this._log("warn", `processor factory failed ${nameOf(err)}`);
      return { ...this._fallbackProcessor(gen), failed: true };
    }
  }

  /** ac-passthrough when the worklets loaded, else a plain gain (direct). */
  _fallbackProcessor(gen) {
    if (gen.workletsLoaded) {
      try {
        const node = new AudioWorkletNode(gen.ctx, "ac-passthrough", {
          numberOfInputs: 2,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 1,
          channelCountMode: "explicit",
          channelInterpretation: "speakers",
        });
        return { node, handle: null, kind: "worklet", fromFactory: false };
      } catch (err) {
        this._log("warn", `passthrough node failed ${nameOf(err)}`);
      }
    }
    return { node: monoGain(gen.ctx), handle: null, kind: "direct", fromFactory: false };
  }

  /**
   * Put `built` in gen's processor slot: inBus → its input 0, its output →
   * outBus, the converted source → its input 1. The processor that was there
   * comes out only once the new one is connected. A node the browser refuses
   * to connect is a failed processor: what was connected of it is undone, and
   * ac-passthrough (then a plain gain) takes its place, so the voice always
   * has a way through. → false when nothing could be connected (the slot is
   * left as it was).
   */
  _installProcessor(gen, built) {
    let next = built;
    let failed = Boolean(built.failed);
    for (;;) {
      try {
        this._connectProcessor(gen, next.node);
        break;
      } catch (err) {
        this._log("warn", `processor wiring failed ${nameOf(err)}`);
        if (next.fromFactory) failed = true;
        if (next.kind === "direct") {
          if (failed) this._processorFailed = true;
          return false;
        }
        next = next.fromFactory
          ? this._fallbackProcessor(gen)
          : { node: monoGain(gen.ctx), handle: null, kind: "direct", fromFactory: false };
      }
    }
    if (gen.processor && gen.processor !== next.node) this._disconnectProcessor(gen);
    gen.processor = next.node;
    gen.processorHandle = next.handle;
    gen.processorKind = next.kind;
    this._applyConvertedSource(gen, true);
    this._processorFailed = failed;
    return true;
  }

  /** inBus → node's input 0 and node → outBus. When the browser refuses, what was connected is undone and the error thrown. */
  _connectProcessor(gen, node) {
    try {
      gen.inBus.connect(node, 0, 0);
      node.connect(gen.outBus);
    } catch (err) {
      safeDisconnect(gen.inBus, node);
      safeDisconnect(node, gen.outBus);
      throw err;
    }
  }

  /** Take the processor out of the slot: inBus, the converted source and its output are disconnected from it. */
  _disconnectProcessor(gen) {
    safeDisconnect(gen.inBus, gen.processor);
    if (gen.convertedNode) {
      safeDisconnect(gen.convertedNode);
      gen.convertedNode = null;
    }
    safeDisconnect(gen.processor);
  }

  _connectMicSource(gen, stream) {
    const source = gen.ctx.createMediaStreamSource(stream);
    source.connect(gen.micBus);
    gen.micHolesFrom = frameOf(gen.ctx) + Math.round((MIC_SETTLE_MS * gen.ctx.sampleRate) / 1000);
    const old = gen.micSource;
    gen.micSource = source;
    gen.micSources.add(source);
    this._micGen++;
    if (old) {
      safeDisconnect(old);
      gen.micSources.delete(old);
    }
  }

  /** inBus is fed by the test source when one is set, else by micBus. */
  _applyTestSource(gen, rewire) {
    if (rewire) {
      if (gen.testNode) {
        safeDisconnect(gen.testNode);
        gen.testNode = null;
      }
      safeDisconnect(gen.micBus, gen.inBus);
    }
    const stream = this._testSource;
    if (stream) {
      try {
        gen.testNode = gen.ctx.createMediaStreamSource(stream);
        gen.testNode.connect(gen.inBus);
        return;
      } catch (err) {
        gen.testNode = null;
        this._log("warn", `test source failed ${nameOf(err)}`);
        this._emit("tap-error", { message: `The test tone could not be connected (${nameOf(err)}).` });
      }
    }
    gen.micBus.connect(gen.inBus);
  }

  _applyConvertedSource(gen, rewire) {
    if (rewire && gen.convertedNode) {
      safeDisconnect(gen.convertedNode);
      gen.convertedNode = null;
    }
    const stream = this._convertedSource;
    if (!stream || !gen.processor || gen.processor.numberOfInputs < 2) return;
    try {
      gen.convertedNode = gen.ctx.createMediaStreamSource(stream);
      gen.convertedNode.connect(gen.processor, 0, 1);
    } catch (err) {
      gen.convertedNode = null;
      this._log("warn", `converted source failed ${nameOf(err)}`);
    }
  }

  /**
   * Step 1 of a rebuild, and stop(): the processor's state is kept for the
   * next factory, taps are told their generation ended, engine inputs end,
   * the route is disposed, the listeners are dropped, the context closes
   * (inside the self-op guard). Nothing counts as a heartbeat afterwards.
   */
  async _disposeGeneration(gen) {
    if (!gen || gen.disposed) return;
    gen.disposed = true;
    if (gen.processorHandle && typeof gen.processorHandle.snapshot === "function") {
      try {
        this._processorState = gen.processorHandle.snapshot() ?? null;
      } catch {
        // Keep the last state the processor gave.
      }
    }
    for (const tap of [...this._taps]) {
      if (tap.handleGen !== gen) continue;
      const handle = tap.handle;
      tap.handle = null;
      tap.handleGen = null;
      if (tap.once) {
        tap.removed = true;
        this._taps.delete(tap);
      }
      if (handle) this._disposeTapHandle(handle, { generationEnded: true, generation: gen.n });
    }
    gen.taps.clear();
    for (const input of [...gen.engineInputs]) this._endEngineInput(input);
    try {
      gen.route?.dispose();
    } catch {
      // Gone with its context.
    }
    gen.routed = false;
    gen.abort.abort();
    if (this._gen === gen) this._gen = null;
    await this._selfOp(() => closeContext(gen.ctx));
    if (gen.ctx.state === "closed") this._contexts.delete(gen.ctx);
  }

  _endEngineInput(input) {
    if (input.ended) return;
    input.ended = true;
    safeDisconnect(input.gen.micBus, input.node);
    for (const track of input.node.stream.getTracks()) track.stop();
    input.gen.engineInputs.delete(input);
  }

  _disposeTapHandle(handle, info) {
    try {
      const r = handle.dispose?.(info);
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch (err) {
      this._emit("tap-error", { message: redact(messageOf(err)) || "A check's recorder could not be removed." });
    }
  }

  /** Build one tap for the current, routed generation (under the lock). A failing tap never blocks the voice. */
  _buildTap(tap) {
    const epoch = this._epoch;
    this._lock.run(async () => {
      const gen = this._gen;
      if (epoch !== this._epoch || tap.removed || !gen || gen.disposed || !gen.routed || tap.handleGen === gen) return;
      if (tap.once && tap.built) return;
      let handle;
      try {
        const building = Promise.resolve(
          tap.build({
            ctx: gen.ctx,
            micBus: gen.micBus,
            inBus: gen.inBus,
            outBus: gen.outBus,
            micStream: this.micStream,
            generation: gen.n,
            route: gen.route,
          }),
        );
        handle = await orTimeout(building, STEP_BACKSTOP_MS);
        if (handle === TIMED_OUT) {
          // Given up: the voice must not wait for a check. A late recorder is removed when it comes.
          building.then((h) => h && this._disposeTapHandle(h, { generationEnded: true, generation: gen.n }), () => {});
          throw Object.assign(new Error("A check's recorder took too long to start."), { name: "TimeoutError" });
        }
      } catch (err) {
        // A once-tap is built at most once: one that failed is gone, and tap-error says so.
        if (tap.once) {
          tap.removed = true;
          this._taps.delete(tap);
        }
        this._log("warn", `tap failed ${nameOf(err)}`);
        this._emit("tap-error", { message: redact(messageOf(err)) || "A check's recorder could not be added." });
        return;
      }
      tap.built = true;
      if (tap.removed || this._gen !== gen || gen.disposed || epoch !== this._epoch) {
        if (handle) {
          this._disposeTapHandle(handle, { generationEnded: !tap.removed, generation: gen.n });
        }
        if (tap.once) this._taps.delete(tap);
        return;
      }
      tap.handle = handle ?? { dispose() {} };
      tap.handleGen = gen;
      gen.taps.add(tap);
    });
  }

  // ---------------------------------------------------------------- microphone

  _micLive() {
    return Boolean(this._mic && this._mic.track && this._mic.track.readyState === "live");
  }

  /** The opened microphone becomes the current one: its source replaces the old one in micBus. */
  _installMic(opened, choice) {
    const old = this._mic;
    const mic = {
      entry: choice.entry,
      how: choice.how,
      standIn: Boolean(choice.standIn),
      settings: opened.settings,
      openedInMs: opened.openedInMs,
      stream: opened.stream,
      track: opened.track,
      muted: Boolean(opened.track.muted),
      abort: new AbortController(),
    };
    this._mic = mic;
    const signal = mic.abort.signal;
    const track = opened.track;
    track.addEventListener(
      "ended",
      (ev) => {
        if (this._mic !== mic || ev.target !== mic.track) return;
        this._feed({ type: "mic-ended" });
      },
      { signal },
    );
    track.addEventListener(
      "mute",
      (ev) => {
        if (this._mic !== mic || ev.target !== mic.track) return;
        mic.muted = true;
        this._mutedCount++;
        this._recomputeWarnings();
        this._emit("mic", { mic: this.mic });
      },
      { signal },
    );
    track.addEventListener(
      "unmute",
      (ev) => {
        if (this._mic !== mic || ev.target !== mic.track) return;
        mic.muted = false;
        this._recomputeWarnings();
        this._emit("mic", { mic: this.mic });
      },
      { signal },
    );
    if (mic.muted) this._mutedCount++;
    if (track.readyState !== "live") {
      // It ended before its "ended" listener existed: report it like any other end.
      queueMicrotask(() => {
        if (this._mic === mic) this._feed({ type: "mic-ended" });
      });
    }
    if (!mic.standIn) this._wantedMic = choice.entry;
    const gen = this._gen;
    if (gen && !gen.disposed && gen.micBus) {
      try {
        this._connectMicSource(gen, mic.stream);
      } catch (err) {
        this._log("warn", `mic source failed ${nameOf(err)}`);
      }
    }
    if (old) {
      old.abort.abort();
      if (old.stream !== mic.stream) stopStream(old.stream);
    }
    this._log("info", `mic open ${choice.how}${mic.standIn ? " stand-in" : ""} in ${opened.openedInMs} ms`);
    this._recomputeWarnings();
    this._emit("mic", { mic: this.mic });
  }

  // ---------------------------------------------------------------- events from the generation

  _listenContext(gen) {
    const { ctx } = gen;
    const signal = gen.abort.signal;
    ctx.addEventListener("statechange", (ev) => this._onContextState(gen, ev), { signal });
    if ("onerror" in ctx) ctx.addEventListener("error", (ev) => this._onContextError(gen, ev), { signal });
    ctx.addEventListener("sinkchange", (ev) => this._onSinkChange(gen, ev), { signal });
  }

  _onContextState(gen, ev) {
    if (this._gen !== gen || ev.target !== gen.ctx) return;
    if (gen.ctx.state === "running") gen.sawRunning = true;
    if (this._selfOps > 0) return;
    const state = gen.ctx.state; // read again: statechange events can bunch
    if (state === "suspended" || state === "interrupted" || state === "closed") {
      this._feed({ type: "context-state", state });
    }
  }

  _onContextError(gen, ev) {
    if (this._gen !== gen || ev.target !== gen.ctx) return;
    this._feed({ type: "context-error" });
  }

  _onSinkChange(gen, ev) {
    if (this._gen !== gen || ev.target !== gen.ctx || this._selfOps > 0) return;
    const sinkId = typeof gen.ctx.sinkId === "string" ? gen.ctx.sinkId : "none";
    let wanted;
    if (gen.metersOnly) wanted = "none";
    else if (!gen.route) return;
    else if (methodBase(gen.route.method) === "element") wanted = gen.route.contextSinkId ?? "";
    else wanted = gen.route.deviceId;
    this._feed({ type: "sink-changed", matches: sinkId === wanted });
  }

  _onMeter(gen, ev) {
    if (this._gen !== gen) return;
    const m = ev.data;
    if (!m || m.type !== "levels") return;
    const holes = Array.isArray(m.micHoles) ? m.micHoles : [];
    this._micHolesTotal += micHoleCount(settledHoles(holes, m, gen.micHolesFrom));
    this._levels = {
      micRmsDb: m.micRmsDb,
      micPeakDb: m.micPeakDb,
      outRmsDb: m.outRmsDb,
      outPeakDb: m.outPeakDb,
      micHoles: holes,
      frame: m.frame,
      micOpenZeroFrames: m.micOpenZeroFrames ?? 0,
      micHolesTotal: this._micHolesTotal,
    };
    this._emit("levels", {
      micRmsDb: m.micRmsDb,
      micPeakDb: m.micPeakDb,
      outRmsDb: m.outRmsDb,
      outPeakDb: m.outPeakDb,
      micHoles: holes,
      frame: m.frame,
      micHolesTotal: this._micHolesTotal,
    });
    if (
      gen.routed &&
      this._recovery.phase === "verifying" &&
      typeof m.contextFrame === "number" &&
      m.contextFrame > gen.heartbeatAfter
    ) {
      this._feed({ type: "heartbeat", routed: true });
    }
  }

  /**
   * selfOp(fn): changes the graph makes to its own context (setSinkId,
   * resume, close) must not be taken for faults. Handlers ignore the
   * context's statechange and sinkchange while one runs; afterwards the
   * state is checked once more.
   */
  async _selfOp(fn) {
    this._selfOps++;
    try {
      return await fn();
    } finally {
      this._selfOps--;
      queueMicrotask(() => this._reconcile());
    }
  }

  _reconcile() {
    if (this._selfOps > 0 || !this._running) return;
    const ctx = this.context;
    if (ctx && this._recovery.phase === "running" && ctx.state !== "running") {
      this._feed({ type: "context-state", state: ctx.state });
    }
  }

  // ---------------------------------------------------------------- devices

  _saved() {
    let s = null;
    try {
      s = this._getSaved();
    } catch {
      s = null;
    }
    const pick = (o) => ({
      deviceId: typeof o?.deviceId === "string" ? o.deviceId : "",
      label: typeof o?.label === "string" ? o.label : "",
    });
    return { mic: pick(s?.mic), output: pick(s?.output) };
  }

  /** What the reducer's "devices" event says: the output device, and the wanted microphone (any, when none is wanted). */
  _presence(snap) {
    const saved = this._saved();
    const out = chooseOutput(snap.outputs, { saved: saved.output });
    const mic = chooseMic(snap.inputs, { saved: saved.mic, wanted: this._wantedMic });
    return { cablePresent: Boolean(out.entry), micPresent: Boolean(mic.entry) && !mic.standIn };
  }

  /** A newer device snapshot: published (event "devices"), warnings updated, presence fed. → false when older. */
  _takeSnapshot(snap) {
    if (this._snapshot && typeof snap.atMs === "number" && snap.atMs < this._snapshot.atMs) return false;
    this._snapshot = snap;
    this._emit("devices", { snapshot: snap });
    this._recomputeWarnings();
    this._feed({ type: "devices", ...this._presence(snap) });
    return true;
  }

  /**
   * devicechange (no lock: it only reads and feeds the reducer). The native
   * rates are read again too, CABLE Input's included: the user may just have
   * changed its format in Windows. → the rates read (a promise), or null
   * when the snapshot was not taken.
   */
  _onDevices(snap) {
    if (!this._running || !snap) return null;
    if (!this._takeSnapshot(snap)) return null;
    const rates = this._readRates({ cable: true });
    this._checkMoves(snap);
    return rates;
  }

  /**
   * What a new device list means for the running voice: an element route
   * whose device is gone is silenced at once (it might fall back to Windows'
   * default device, the user's headphones); the wanted microphone is back
   * while a stand-in is in use; the output moved to another id.
   */
  _checkMoves(snap) {
    const gen = this._gen;
    if (gen && !gen.disposed && gen.routed && gen.route && methodBase(gen.route.method) === "element") {
      if (!snap.outputs.some((d) => d.deviceId === gen.route.deviceId)) {
        gen.routed = false;
        try {
          gen.route.silence();
        } catch {
          // Already silent.
        }
        this._feed({ type: "sink-changed", matches: false });
        return;
      }
    }
    if (this._recovery.phase !== "running") return;
    const saved = this._saved();
    if (this._mic?.standIn) {
      const choice = chooseMic(snap.inputs, { saved: saved.mic, wanted: this._wantedMic });
      if (choice.entry && !choice.standIn) this._feed({ type: "mic-request", reason: "wanted-back" });
    }
    const now = this._gen;
    if (now && now.routed && now.route) {
      const out = chooseOutput(snap.outputs, { saved: saved.output });
      if (out.entry && out.entry.deviceId !== now.route.deviceId) this._feed({ type: "rebuild-request", reason: "output-moved" });
    }
  }

  /**
   * Native rates (each a short-lived context): Windows' default playback
   * device, and with cable: CABLE Input and the routed device. Coalesced: a
   * request while a read runs makes exactly one more read after it. The
   * promise resolves once the rates (and warnings) are up to date, never
   * rejects, and never waits for good (readOutputRate gives up by itself).
   */
  _readRates({ cable = true } = {}) {
    if (this._ratesBusy) {
      this._ratesAgain = { cable: Boolean(this._ratesAgain?.cable) || cable };
      return this._ratesRun;
    }
    this._ratesBusy = true;
    this._ratesRun = this._ratesLoop({ cable }).catch(() => {});
    return this._ratesRun;
  }

  async _ratesLoop({ cable }) {
    let want = { cable };
    try {
      while (want) {
        this._ratesAgain = null;
        const epoch = this._epoch;
        const gen = this._gen;
        const defaultOutputHz = await readOutputRate();
        let { cableInputHz } = this._rates;
        let sinkRateHz = this._output?.sinkRateHz ?? null;
        if (want.cable) {
          const cableId = this._snapshot?.cableIn?.deviceId ?? "";
          const routeId = gen?.route?.deviceId ?? "";
          cableInputHz = cableId ? await readOutputRate(cableId) : null;
          sinkRateHz = routeId ? (routeId === cableId ? cableInputHz : await readOutputRate(routeId)) : null;
        }
        if (epoch !== this._epoch) return;
        this._rates = { defaultOutputHz, cableInputHz };
        const g = this._gen;
        if (this._output && g === gen) {
          this._output = {
            ...this._output,
            sinkRateHz,
            contextRateHz: g ? g.ctx.sampleRate : null,
            baseLatencyMs: g ? secondsToMs(g.ctx.baseLatency) : null,
            outputLatencyMs: g ? secondsToMs(g.ctx.outputLatency) : null,
          };
          this._emit("output", { output: this.output });
        }
        this._recomputeWarnings();
        want = this._ratesAgain;
      }
    } finally {
      this._ratesBusy = false;
    }
  }

  _setOutput(outChoice, { method, tried, gen, route }) {
    const prev = this._output;
    const sameDevice = prev && prev.entry && outChoice.entry && prev.entry.deviceId === outChoice.entry.deviceId;
    let contextSink = null;
    if (route && methodBase(route.method) === "element") contextSink = route.contextSinkId ? "mic-sibling" : "default";
    this._output = {
      entry: outChoice.entry,
      how: outChoice.how,
      method,
      tried: Array.isArray(tried) ? tried.map((t) => ({ ...t })) : [],
      routePreference: this._routePreference,
      routeChanges: this._routeChanges,
      contextSink,
      sinkRateHz: sameDevice ? prev.sinkRateHz : null,
      contextRateHz: gen ? gen.ctx.sampleRate : null,
      baseLatencyMs: gen ? secondsToMs(gen.ctx.baseLatency) : null,
      outputLatencyMs: gen ? secondsToMs(gen.ctx.outputLatency) : null,
      processor: gen ? gen.processorKind : null,
    };
    this._emit("output", { output: this.output });
  }

  // ---------------------------------------------------------------- warnings

  _warningInput() {
    const snap = this._snapshot;
    const saved = this._saved();
    const out = snap ? chooseOutput(snap.outputs, { saved: saved.output }) : null;
    return {
      micLabel: this._mic?.entry?.label ?? "",
      savedMicLabel: saved.mic.label,
      wantedMicLabel: this._wantedMic?.label ?? "",
      standIn: Boolean(this._mic?.standIn),
      outputFound: snap ? Boolean(out?.entry) : true,
      savedOutputMissing: Boolean(out?.savedMissing),
      savedOutputLabel: saved.output.label,
      defaultInputLabel: snap?.defaultInputLabel ?? "",
      defaultOutputLabel: snap?.defaultOutputLabel ?? "",
      commsInputLabel: snap?.commsInputLabel ?? "",
      commsOutputLabel: snap?.commsOutputLabel ?? "",
      defaultOutputRateHz: this._rates.defaultOutputHz,
      cableRateHz: this._rates.cableInputHz,
    };
  }

  _recomputeWarnings() {
    const list = this.warningsWith();
    const key = list.map((w) => `${w.code}\u0000${w.text}`).join("\u0001");
    if (key === this._warningsKey) return;
    const before = new Set(this._warnings.map((w) => w.code));
    this._warnings = list;
    this._warningsKey = key;
    for (const w of list) if (!before.has(w.code)) this._log("warn", `warn ${w.code}`);
    this._emit("warnings", { warnings: this.warnings });
    if (this._recovery.phase === "running") this._setState(this._computeState());
  }

  // ---------------------------------------------------------------- watchdog

  _startWatchdog() {
    clearTimeout(this._watchdogTimer);
    const epoch = this._epoch;
    this._watchdogTimer = setTimeout(() => {
      this._watchdogTimer = null;
      if (epoch !== this._epoch || !this._running) return;
      this._watchdogTick();
      this._startWatchdog();
    }, WATCHDOG_MS);
  }

  /**
   * While the voice runs: a context whose clock stands still for two checks
   * is stalled; an element route that is paused, or whose time stands still
   * for two checks, is lost.
   */
  _watchdogTick() {
    const gen = this._gen;
    if (!gen || gen.disposed) return;
    if (!gen.routed || this._recovery.phase !== "running") {
      gen.wdTime = null;
      gen.wdStill = 0;
      gen.wdElement = null;
      gen.wdElementStill = 0;
      return;
    }
    const t = gen.ctx.currentTime;
    gen.wdStill = gen.wdTime !== null && t === gen.wdTime ? gen.wdStill + 1 : 0;
    gen.wdTime = t;
    if (gen.wdStill >= 2) {
      gen.wdStill = 0;
      this._log("warn", "watchdog render-stalled");
      this._feed({ type: "context-error", stalled: true });
      return;
    }
    const p = gen.route?.progress?.();
    if (!p) return;
    gen.wdElementStill = gen.wdElement !== null && p.currentTime === gen.wdElement ? gen.wdElementStill + 1 : 0;
    gen.wdElement = p.currentTime;
    if (p.paused || gen.wdElementStill >= 2) {
      gen.wdElementStill = 0;
      gen.routed = false;
      this._log("warn", `watchdog element ${p.paused ? "paused" : "stalled"}`);
      this._feed({ type: "sink-changed", matches: false });
    }
  }

  // ---------------------------------------------------------------- helpers

  /** One log line per distinct failure in an outage (a long outage would otherwise log every 250 ms). */
  _logFailure(op, err) {
    // A MicError's cause is the browser's error name ("TimeoutError" for a getUserMedia that never answered).
    const parts = [nameOf(err), err?.code, err?.kind, err?.errorName, err?.cause?.name].filter(
      (x) => typeof x === "string" && x,
    );
    const key = `${op} ${parts.join(" ")}`;
    if (key === this._lastFailureKey) return;
    this._lastFailureKey = key;
    this._log("warn", `op ${key} failed`);
  }

  _log(level, text) {
    try {
      this._logFn(level, text);
    } catch {
      // A log line is never worth an error.
    }
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

/** "context:NotAllowedError element:ok" (method names and error names only). */
function triedSummary(tried) {
  return (tried ?? []).map((t) => `${t.method}:${t.ok ? "ok" : t.errorName ?? "no"}`).join(" ");
}
