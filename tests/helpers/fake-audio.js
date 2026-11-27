/**
 * A small stand-in for the browser's audio APIs, for Node tests of
 * src/audio: navigator.mediaDevices (a device list, getUserMedia,
 * "devicechange"), AudioContext, AudioWorkletNode and microphone streams.
 *
 * Time comes from setTimeout and Date.now(), so a test drives it with
 * node:test's mock timers (see useFakeAudio). A context counts its frames
 * from that clock while it runs. The "ac-meter" node posts a levels message
 * every 100 ms of it while its context runs (the graph's heartbeat); a test
 * can queue micBus holes for it.
 *
 * Browser calls can be made to hang: they then never answer, unless the test
 * answers them late (answerLate).
 */
import { mock } from "node:test";

function named(name, message = name) {
  const e = new Error(message);
  e.name = name;
  return e;
}

const dev = (deviceId, groupId, kind, label) => ({ deviceId, groupId, kind, label });

class FakeTrack extends EventTarget {
  constructor(deviceId) {
    super();
    this.kind = "audio";
    this.deviceId = deviceId;
    this.readyState = "live";
    this.muted = false;
  }

  stop() {
    this.readyState = "ended";
  }

  getSettings() {
    return {
      deviceId: this.deviceId,
      channelCount: 1,
      sampleRate: 48000,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      latency: 0.01,
    };
  }
}

const streamOf = (track) => ({ getTracks: () => [track], getAudioTracks: () => [track] });

class FakePort extends EventTarget {
  start() {}
  postMessage() {}
  close() {}
}

/**
 * Install the fakes as globals. → the controls:
 *  rates: native rate per output id ("" = Windows' default) for contexts made
 *    without a sampleRate option; hideLabels: the list has no names or ids
 *    until a getUserMedia has worked; defaultOutputIsCable: Windows' default
 *    playback device is CABLE Input;
 *  hang: { enumerate, gum, close }: how many of the next calls never answer;
 *  hangIf.close: (context) → true when that context's close() never answers;
 *  answerLate(kind): answer the hung "enumerate" or "gum" calls now (→ the
 *    streams handed out late);
 *  calls, contexts (graphContexts(): the ones with an explicit sampleRate),
 *    meters, sources (every MediaStream source node, with the context frame
 *    it was made at), tracks, liveTracks(), endMic(), devicechange(),
 *    uninstall().
 * Each context lists its nodes (context.nodes); each node lists the nodes it
 * is connected to (node.links). connect() refuses what Chromium refuses.
 */
export function installFakeAudio({ cableRateHz = 48000, defaultRateHz = 48000 } = {}) {
  const fake = {
    rates: { "": defaultRateHz, default: defaultRateHz, "out-head": defaultRateHz, "cable-in": cableRateHz },
    hideLabels: false,
    unlocked: false,
    defaultOutputIsCable: false,
    hang: { enumerate: 0, gum: 0, close: 0 },
    hangIf: { close: null },
    pending: { enumerate: [], gum: [] },
    calls: { enumerate: 0, gum: 0 },
    contexts: [],
    meters: [],
    sources: [],
    tracks: [],
  };

  const list = () => {
    if (fake.hideLabels && !fake.unlocked) return [dev("", "", "audioinput", ""), dev("", "", "audiooutput", "")];
    const defaultOut = fake.defaultOutputIsCable
      ? dev("default", "g-cable", "audiooutput", "Default - CABLE Input (VB-Audio Virtual Cable)")
      : dev("default", "g-head", "audiooutput", "Default - Headset Earphone (Test Headset)");
    return [
      dev("default", "g-head", "audioinput", "Default - Headset Microphone (Test Headset)"),
      dev("mic-head", "g-head", "audioinput", "Headset Microphone (Test Headset)"),
      dev("mic-laptop", "g-laptop", "audioinput", "Microphone Array (Test Laptop)"),
      dev("cable-out", "g-cable", "audioinput", "CABLE Output (VB-Audio Virtual Cable)"),
      defaultOut,
      dev("out-head", "g-head", "audiooutput", "Headset Earphone (Test Headset)"),
      dev("cable-in", "g-cable", "audiooutput", "CABLE Input (VB-Audio Virtual Cable)"),
    ];
  };

  const md = new EventTarget();
  md.enumerateDevices = () => {
    fake.calls.enumerate++;
    if (fake.hang.enumerate > 0) {
      fake.hang.enumerate--;
      return new Promise((resolve) => fake.pending.enumerate.push(() => resolve(list())));
    }
    return Promise.resolve(list());
  };
  md.getUserMedia = (constraints) => {
    fake.calls.gum++;
    const id = constraints?.audio?.deviceId?.exact ?? "default";
    const open = () => {
      fake.unlocked = true;
      const track = new FakeTrack(id);
      fake.tracks.push(track);
      return streamOf(track);
    };
    if (fake.hang.gum > 0) {
      fake.hang.gum--;
      return new Promise((resolve) =>
        fake.pending.gum.push(() => {
          const stream = open();
          resolve(stream);
          return stream;
        }),
      );
    }
    return Promise.resolve(open());
  };

  class FakeNode {
    constructor(context, kind, numberOfInputs = 1, numberOfOutputs = 1) {
      this.context = context;
      this.kind = kind;
      this.numberOfInputs = numberOfInputs;
      this.numberOfOutputs = numberOfOutputs;
      this.links = []; // the nodes this one is connected to
      this.channelCount = 2;
      this.channelCountMode = "max";
      this.channelInterpretation = "speakers";
      context.nodes.push(this);
    }

    /**
     * Refuses what Chromium refuses, in its order: no audio node, an output or
     * input that does not exist, another context's node.
     */
    connect(dest, output = 0, input = 0) {
      if (!(dest instanceof FakeNode)) {
        throw new TypeError("Failed to execute 'connect' on 'AudioNode': parameter 1 is not of type 'AudioNode'.");
      }
      if (output >= this.numberOfOutputs) {
        throw named("IndexSizeError", `Output index (${output}) exceeds number of outputs (${this.numberOfOutputs}).`);
      }
      if (input >= dest.numberOfInputs) {
        throw named("IndexSizeError", `Input index (${input}) exceeds number of inputs (${dest.numberOfInputs}).`);
      }
      if (dest.context !== this.context) {
        throw named("InvalidAccessError", "Cannot connect to an AudioNode belonging to a different audio context.");
      }
      if (!this.links.includes(dest)) this.links.push(dest); // connecting twice changes nothing
      return dest;
    }

    disconnect(dest) {
      if (dest === undefined) {
        this.links = [];
        return;
      }
      const i = this.links.indexOf(dest);
      if (i < 0) throw named("InvalidAccessError", "Not connected.");
      this.links.splice(i, 1);
    }
  }

  class FakeAudioContext extends EventTarget {
    constructor(options = {}) {
      super();
      this.onerror = null;
      this.explicitRate = options.sampleRate !== undefined;
      const sinkId = typeof options.sinkId === "string" ? options.sinkId : "";
      this.sampleRate = options.sampleRate ?? fake.rates[sinkId] ?? 48000;
      this._sinkId = sinkId;
      this.state = "suspended";
      this._frames = 0;
      this._since = null;
      this.baseLatency = 0.01;
      this.outputLatency = 0.02;
      this.nodes = []; // every node made in this context
      this.destination = new FakeNode(this, "destination", 1, 0);
      this.audioWorklet = { addModule: () => Promise.resolve() };
      fake.contexts.push(this);
      queueMicrotask(() => this._set("running")); // the app may play without a click
    }

    get sinkId() {
      return this._sinkId;
    }

    get currentTime() {
      return this.frameNow() / this.sampleRate;
    }

    /** Frames rendered so far (they move only while the context runs). */
    frameNow() {
      const running = this._since === null ? 0 : Math.floor(((Date.now() - this._since) * this.sampleRate) / 1000);
      return this._frames + running;
    }

    _set(state) {
      if (this.state === "closed" || this.state === state) return;
      if (this.state === "running") {
        this._frames = this.frameNow();
        this._since = null;
      }
      this.state = state;
      if (state === "running") this._since = Date.now();
      queueMicrotask(() => this.dispatchEvent(new Event("statechange")));
    }

    setSinkId(id) {
      if (this.state === "closed") return Promise.reject(named("InvalidStateError", "The context is closed."));
      this._sinkId = typeof id === "string" ? id : "";
      return Promise.resolve();
    }

    resume() {
      if (this.state === "closed") return Promise.reject(named("InvalidStateError", "The context is closed."));
      this._set("running");
      return Promise.resolve();
    }

    close() {
      if (fake.hang.close > 0 || fake.hangIf.close?.(this)) {
        if (fake.hang.close > 0) fake.hang.close--;
        return new Promise(() => {});
      }
      this._set("closed");
      return Promise.resolve();
    }

    createGain() {
      const node = new FakeNode(this, "gain");
      node.gain = { value: 1 };
      return node;
    }

    createMediaStreamSource(stream) {
      const node = new FakeNode(this, "source", 0, 1);
      node.mediaStream = stream;
      node.startFrame = this.frameNow(); // the context frame it was made at
      fake.sources.push(node);
      return node;
    }

    createMediaStreamDestination() {
      const node = new FakeNode(this, "stream-destination", 1, 0);
      node.stream = streamOf(new FakeTrack("destination"));
      return node;
    }
  }

  class FakeAudioWorkletNode extends FakeNode {
    constructor(context, name, options = {}) {
      super(context, name, options.numberOfInputs ?? 1, options.numberOfOutputs ?? 1);
      this.name = name;
      this.port = new FakePort();
      if (name === "ac-meter") {
        this.frame0 = context.frameNow();
        this.queued = [];
        fake.meters.push(this);
        this._tick();
      }
    }

    /** A micBus zero run of `frames` starting at context frame `atContextFrame`, sent with the next message. */
    queueHole(atContextFrame, frames = 480) {
      this.queued.push({ atContextFrame, frames });
    }

    _tick() {
      setTimeout(() => {
        const ctx = this.context;
        if (ctx.state === "closed") return;
        if (ctx.state === "running") {
          const contextFrame = ctx.frameNow();
          const due = this.queued.filter((h) => h.atContextFrame + h.frames <= contextFrame);
          this.queued = this.queued.filter((h) => !due.includes(h));
          const data = {
            type: "levels",
            frame: contextFrame - this.frame0,
            contextFrame,
            micRmsDb: -30,
            micPeakDb: -20,
            outRmsDb: -30,
            outPeakDb: -20,
            micHoles: due.map((h) => ({ startFrame: h.atContextFrame - this.frame0, frames: h.frames })),
            micOpenZeroFrames: 0,
          };
          this.port.dispatchEvent(new MessageEvent("message", { data }));
        }
        this._tick();
      }, 100);
    }
  }

  const saved = {
    AudioContext: Object.getOwnPropertyDescriptor(globalThis, "AudioContext"),
    AudioWorkletNode: Object.getOwnPropertyDescriptor(globalThis, "AudioWorkletNode"),
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  };
  const define = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  define("AudioContext", FakeAudioContext);
  define("AudioWorkletNode", FakeAudioWorkletNode);
  define("navigator", { mediaDevices: md });

  Object.assign(fake, {
    md,
    graphContexts: () => fake.contexts.filter((c) => c.explicitRate),
    liveTracks: () => fake.tracks.filter((t) => t.readyState === "live"),
    devicechange: () => md.dispatchEvent(new Event("devicechange")),
    /** The microphone stops by itself (unplugged): its track ends and says so. */
    endMic() {
      const track = fake.liveTracks().at(-1);
      if (!track) return;
      track.readyState = "ended";
      track.dispatchEvent(new Event("ended"));
    },
    /** Answer the hung calls of one kind now. → what they handed out. */
    answerLate(kind) {
      const answers = fake.pending[kind].splice(0);
      return answers.map((answer) => answer());
    },
    uninstall() {
      for (const [key, desc] of Object.entries(saved)) {
        if (desc) Object.defineProperty(globalThis, key, desc);
        else delete globalThis[key];
      }
    },
  });
  return fake;
}

/** Mock timers and the fakes for one test (undone when it ends). → the fake's controls. */
export function useFakeAudio(t, options) {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const fake = installFakeAudio(options);
  t.after(() => {
    fake.uninstall();
    mock.timers.reset();
  });
  return fake;
}

/** Let pending promise jobs run (the mock timers leave setImmediate alone). */
export async function flush(rounds = 2) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Move the mocked clock on by `ms`, in steps, with promise jobs run between them. */
export async function advance(ms, step = 10) {
  for (let done = 0; done < ms; done += step) {
    mock.timers.tick(Math.min(step, ms - done));
    await flush();
  }
}

/** Watch a promise without waiting for it: { done, value, error } fill in when it settles. */
export function watch(promise) {
  const w = { done: false, value: undefined, error: undefined };
  Promise.resolve(promise).then(
    (value) => Object.assign(w, { done: true, value }),
    (error) => Object.assign(w, { done: true, error }),
  );
  return w;
}
