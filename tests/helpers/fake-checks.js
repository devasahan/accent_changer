/**
 * A scripted stand-in for what src/audio/measure.js talks to, for Node tests
 * of the checks: a VoiceGraph-like object (taps, the test source, recovery
 * and device events, rebuilds), AudioContext, AudioWorkletNode,
 * navigator.mediaDevices (CABLE Output), the monitor's test tone and the
 * platform's hide and window state.
 *
 * Nothing runs by itself: a test answers the worklet nodes' ports (summaries,
 * chunks, "done", "stopped") and sets the page clock. performance.now() and
 * Date.now() read `clock.now` (importing this module replaces them, so each
 * test file that uses it runs in its own process, as node --test does).
 */
export const EPOCH = 1_800_000_000_000;
export const clock = { now: 10_000 };
performance.now = () => clock.now;
Date.now = () => EPOCH + clock.now;

export const nodes = [];
export const contexts = [];
export const cableTracks = [];

export class FakePort {
  constructor() {
    this.sent = [];
    this.onmessage = null;
  }
  postMessage(data) {
    this.sent.push(data);
  }
  emit(data) {
    this.onmessage?.({ data });
  }
}

export class FakeNode {
  constructor(ctx, kind = "node") {
    this.context = ctx;
    this.kind = kind;
    this.links = []; // [target, input]
  }
  connect(target, output = 0, input = 0) {
    this.links.push([target, input]);
    return target;
  }
  disconnect(target) {
    this.links = target === undefined ? [] : this.links.filter(([t]) => t !== target);
  }
}

globalThis.AudioWorkletNode = class extends FakeNode {
  constructor(ctx, name, options) {
    super(ctx, name);
    this.name = name;
    this.options = options;
    this.port = new FakePort();
    nodes.push(this);
  }
};

/** A microphone track: getSettings().latency in seconds; `stats` (track.stats) when given. */
export function fakeTrack({ latency = 0.01, stats = undefined } = {}) {
  const t = new EventTarget();
  t.readyState = "live";
  t.stop = () => {
    t.readyState = "ended";
  };
  t.getSettings = () => ({ sampleRate: 48000, latency, echoCancellation: false, noiseSuppression: false, autoGainControl: false });
  if (stats !== undefined) t.stats = stats;
  return t;
}
const streamOf = (t, more = {}) => ({ id: `s${Math.random()}`, getTracks: () => [t], getAudioTracks: () => [t], ...more });

/**
 * Switches for the next calls: addModule refused, setSinkId refused, CABLE
 * Output not opening, a source of CABLE Output that cannot be made, and the
 * track.stats CABLE Output tracks get.
 */
export const env = { addModuleFails: false, sinkFails: false, gumFails: false, cableSourceFails: false, cableStats: undefined };

export function resetEnv() {
  Object.assign(env, { addModuleFails: false, sinkFails: false, gumFails: false, cableSourceFails: false, cableStats: undefined });
}

export function fakeCtx({ sinkId = "" } = {}) {
  const ctx = new EventTarget();
  Object.assign(ctx, {
    state: "running",
    sampleRate: 48000,
    outputLatency: 0.02,
    baseLatency: 0.01,
    sinkId,
    closed: false,
    audioWorklet: {
      addModule: async (url) => {
        if (env.addModuleFails) throw Object.assign(new Error("no module"), { name: "AbortError" });
        ctx.modules.push(String(url));
      },
    },
    modules: [],
    sources: [],
    createMediaStreamSource(stream) {
      if (env.cableSourceFails && stream?.cable) throw Object.assign(new Error("no source"), { name: "InvalidStateError" });
      const n = new FakeNode(ctx, "source");
      n.stream = stream;
      ctx.sources.push(n);
      return n;
    },
    async setSinkId(id) {
      if (env.sinkFails) throw Object.assign(new Error("refused"), { name: "NotAllowedError" });
      ctx.sinkId = id;
    },
    async resume() {
      ctx.state = "running";
    },
    async close() {
      ctx.state = "closed";
      ctx.closed = true;
    },
  });
  contexts.push(ctx);
  return ctx;
}
globalThis.AudioContext = class {
  constructor() {
    return fakeCtx();
  }
};

Object.defineProperty(globalThis.navigator, "mediaDevices", {
  configurable: true,
  value: {
    enumerateDevices: async () => [],
    getUserMedia: async () => {
      if (env.gumFails) throw Object.assign(new Error("busy"), { name: "NotReadableError" });
      const t = fakeTrack({ stats: env.cableStats });
      cableTracks.push(t);
      return streamOf(t, { cable: true });
    },
  },
});

const ev = (type, detail) => new CustomEvent(type, { detail });

/** The graph as the checks see it: one generation at a time, taps built at once while it runs. */
export class FakeGraph extends EventTarget {
  constructor({ method = "context", routePreference = "auto", micTrack = fakeTrack() } = {}) {
    super();
    this.state = "running";
    this.micGen = 1;
    this.generation = 1;
    this.ctx = fakeCtx({ sinkId: "cable-in" });
    this.micBus = new FakeNode(this.ctx, "micBus");
    this.taps = new Set();
    this.testSource = null;
    this.testSourceCalls = [];
    this.renewCalls = [];
    this.snapshot = { cableOut: { deviceId: "cable-out" }, cableIn: { deviceId: "cable-in" }, defaultOutputLabel: "Default - Headset Earphone" };
    this.output = { method, routePreference, entry: { deviceId: "cable-in" } };
    this.micTrack = micTrack;
    this.micStream = streamOf(this.micTrack);
    this.mic = { track: this.micTrack };
  }

  get context() {
    return this.ctx;
  }

  addTap(build, { once = false } = {}) {
    const tap = { build, once, handle: null, built: false, removed: false };
    this.taps.add(tap);
    if (this.state === "running") this.building = this.buildTap(tap);
    return async () => {
      tap.removed = true;
      this.taps.delete(tap);
      const h = tap.handle;
      tap.handle = null;
      h?.dispose?.({ generationEnded: false });
    };
  }

  async buildTap(tap) {
    try {
      const h = await tap.build({
        ctx: this.ctx,
        micBus: this.micBus,
        inBus: null,
        outBus: null,
        micStream: this.micStream,
        generation: this.generation,
        route: { method: this.output.method },
      });
      tap.built = true;
      tap.handle = h ?? { dispose() {} };
    } catch (err) {
      if (tap.once) {
        tap.removed = true;
        this.taps.delete(tap);
      }
      this.dispatchEvent(ev("tap-error", { message: err.message }));
    }
  }

  setTestSource(stream) {
    this.testSource = stream ?? null;
    this.testSourceCalls.push(stream ? "on" : "off");
    return Promise.resolve();
  }

  /** graph.js renewMicSource(): a new microphone source (micGen + 1), only while a test source feeds inBus. */
  renewMicSource() {
    const renewed = this.testSource !== null && this.state === "running";
    this.renewCalls.push(renewed);
    if (renewed) this.micGen++;
    return Promise.resolve(renewed);
  }

  lost(cause = "render-error", atMs = clock.now) {
    this.dispatchEvent(ev("recovery", { kind: "lost", outage: { cause, lostAtMs: atMs } }));
  }

  back(cause, lostAtMs, outageMs) {
    this.dispatchEvent(ev("recovery", { kind: "back", record: { cause, lostAtMs, outageMs, backAtMs: lostAtMs + outageMs } }));
  }

  /**
   * The generation ends: taps disposed, a new context (on `method`, the route
   * the rebuild found), "rebuilt"; then, at `backAtMs`, "back" and the taps
   * built again.
   */
  async rebuild({ cause = "render-error", backAtMs, method = this.output.method } = {}) {
    const lostAt = clock.now;
    this.lost(cause, lostAt);
    for (const tap of [...this.taps]) {
      const h = tap.handle;
      tap.handle = null;
      if (tap.once) {
        tap.removed = true;
        this.taps.delete(tap);
      }
      h?.dispose?.({ generationEnded: true });
    }
    this.ctx.state = "closed";
    this.ctx.closed = true;
    this.generation++;
    this.output = { ...this.output, method };
    this.ctx = fakeCtx({ sinkId: method.startsWith("context") ? "cable-in" : "" });
    this.micBus = new FakeNode(this.ctx, "micBus");
    this.dispatchEvent(ev("rebuilt", { generation: this.generation, cause }));
    clock.now = backAtMs;
    this.back(cause, lostAt, backAtMs - lostAt);
    for (const tap of [...this.taps]) if (!tap.removed && !(tap.once && tap.built)) await this.buildTap(tap);
  }

  devices(snapshot) {
    this.snapshot = { ...this.snapshot, ...snapshot };
    this.dispatchEvent(ev("devices", { snapshot: this.snapshot }));
  }
}

/** The monitor's test tone: refused when `refuse` is set; loseTone() runs the onLost callbacks. */
export function fakeMonitor() {
  const m = { lost: [], tones: [], refuse: null };
  m.toneStream = async () => {
    if (m.refuse) throw m.refuse;
    const tone = {
      stream: { id: "tone" },
      stopped: false,
      stop() {
        tone.stopped = true;
      },
      onLost(cb) {
        m.lost.push(cb);
      },
    };
    m.tones.push(tone);
    return tone;
  };
  m.loseTone = () => m.lost.forEach((cb) => cb());
  return m;
}

/** The platform: hideWindowFor (for hideMs), and windowState from the page clock. */
export function fakePlatform() {
  const p = { hideMs: 30 * 60000, hiddenUntil: 0, polls: 0, hides: [] };
  p.hideWindowFor = async (minutes) => {
    const at = Date.now();
    p.hides.push(minutes);
    p.hiddenUntil = clock.now + p.hideMs;
    return { hiddenAtMs: at, showAtMs: at + p.hideMs, minutes };
  };
  p.windowState = async () => {
    p.polls++;
    return { visible: clock.now >= p.hiddenUntil, minimized: false, focused: true };
  };
  return p;
}

/** The newest node of a name. */
export const newest = (name) => [...nodes].reverse().find((n) => n.name === name) ?? null;

/** Let promises and the checks' awaits run. */
export const flush = async (n = 3) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/** Wait (in real time, up to `ms`) until `node` was sent `message`. */
export async function whenSent(node, message, ms = 5000) {
  const until = process.hrtime.bigint() + BigInt(ms) * 1_000_000n;
  while (!node.port.sent.includes(message)) {
    if (process.hrtime.bigint() > until) throw new Error(`${node.name} was never sent ${JSON.stringify(message)}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
