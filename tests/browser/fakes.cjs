// Fakes for the headless app test (tests/browser/app.cjs). Each export is an
// init script: context.addInitScript(fn, arg) runs it in the page before the
// page's own scripts, on every load. They share window.__fake.
//  - fakeFlags: flags for the next load, kept in sessionStorage
//    ("fake-flags"), so a test can set a flag "before the page loads" and
//    reload.
//  - fakeTauri: window.__TAURI__ as the app's Rust side answers (Tauri
//    rejects with the command's error text, a plain string, so this does
//    too). The key and the settings live in sessionStorage in place of
//    Windows Credential Manager and settings.json, so they outlast a reload.
//  - fakeAudio: VB-CABLE in headless Chromium. Chromium's fake devices are
//    relabelled as a headset, a laptop microphone and VB-CABLE's two ends;
//    whatever a context or an <audio> element plays into "CABLE Input" comes
//    out of "CABLE Output" (a shared bus). Switches for the failures the app
//    must survive, and registries the test reads.
// These functions are serialised into the page: they use nothing from here.

/** Flags for this load (set by the test, then a reload): sessionStorage "fake-flags" → window.__fake. */
function fakeFlags() {
  const fake = (window.__fake = window.__fake || {});
  try {
    Object.assign(fake, JSON.parse(sessionStorage.getItem("fake-flags") || "{}"));
  } catch {
    // about:blank has no storage.
  }
}

/**
 * The commands of src-tauri/src/lib.rs. New for Step 2: settings_load and
 * settings_save (sessionStorage "fake-settings"; __fake.settingsLoadFails
 * and __fake.settingsSaveFails make them fail), window_hide_for (recorded; hidden for __fake.hideMs
 * or the minutes asked), window_state (hidden until then),
 * mic_permission_allow (counted; fails with __fake.permissionFails; with
 * __fake.permissionFixes it also lifts both sink refusals) and log_line
 * (kept in __fake.log).
 */
function fakeTauri({ build, tokenResponse, refusedKey, refusedSavedKey }) {
  const KEY = "fake-credential-manager";
  const SETTINGS = "fake-settings";
  const store = {
    get(name) {
      try {
        return sessionStorage.getItem(name);
      } catch {
        return null; // about:blank has no storage
      }
    },
    set: (name, value) => sessionStorage.setItem(name, value),
    remove: (name) => sessionStorage.removeItem(name),
  };
  const tail = (key) => `…${key.slice(-4)}`;
  const fake = (window.__fake = window.__fake || {});
  Object.assign(fake, { calls: [], keySetGot: [], log: [], hides: [], settingsSaved: [], permissionCalls: 0 });
  if (fake.refuseToken === undefined) fake.refuseToken = false;
  window.__TAURI__ = {
    core: {
      async invoke(cmd, args = {}) {
        fake.calls.push(cmd);
        await new Promise((resolve) => setTimeout(resolve, 5)); // IPC never answers at once
        switch (cmd) {
          case "app_info":
            return { name: "Accent Changer", version: "0.1.0", build };
          case "key_status": {
            const key = store.get(KEY);
            return { saved: key !== null, tail: key === null ? null : tail(key) };
          }
          case "key_set":
            fake.keySetGot.push(args.key);
            if (args.key.includes("REFUSED")) throw refusedKey; // a refused key is not saved
            store.set(KEY, args.key);
            if (args.key.includes("OFFLINE")) {
              return { checked: "unknown", note: "Could not reach identity.sanas.ai: check the internet connection", tail: tail(args.key) };
            }
            return { checked: "accepted", note: null, tail: tail(args.key) };
          case "key_delete":
            store.remove(KEY);
            return null;
          case "sanas_token":
            if (store.get(KEY) === null) throw "No Sanas key saved yet: paste it on the Diagnostics page.";
            if (fake.refuseToken) throw refusedSavedKey;
            return tokenResponse;
          case "settings_load":
            if (fake.settingsLoadFails) throw "Could not read the settings file (PermissionDenied).";
            return store.get(SETTINGS);
          case "settings_save":
            if (fake.settingsSaveFails) throw "Could not write the settings file (PermissionDenied).";
            store.set(SETTINGS, args.json);
            fake.settingsSaved.push(args.json);
            return null;
          case "window_hide_for": {
            const now = Date.now();
            fake.hides.push({ minutes: args.minutes });
            const showAtMs = now + (fake.hideMs ?? args.minutes * 60000);
            fake.hiddenUntil = showAtMs;
            return { hiddenAtMs: now, showAtMs, minutes: args.minutes };
          }
          case "window_state":
            return { visible: Date.now() >= (fake.hiddenUntil ?? 0), minimized: false, focused: true };
          case "mic_permission_allow":
            fake.permissionCalls += 1;
            if (fake.permissionFails) throw "SetPermissionState failed";
            if (fake.permissionFixes) {
              fake.refuseContextSink = false;
              fake.refuseElementSink = false;
            }
            return `microphone allowed for ${location.origin} in the WebView2 profile`;
          case "log_line":
            fake.log.push({ level: args.level, text: args.text });
            return null;
          default:
            throw `command ${cmd} not found`;
        }
      },
    },
  };
}

/**
 * VB-CABLE in headless Chromium (needs --use-fake-device-for-media-stream).
 *
 * Devices (enumerateDevices returns plain objects; before the page may use
 * the microphone it returns Chromium's own nameless list):
 *   inputs  "Default - <the first plugged-in fake input>"; "Fake Audio Input 1"
 *           (id fake-mic-1, groupId fake-headset); "Fake Audio Input 2"
 *           (fake-mic-2, fake-laptop); "CABLE Output (VB-Audio Virtual
 *           Cable)" (fake-cable-output, fake-cable)
 *   outputs "Default - Headset Earphone (Fake Headset)"; "Fake Audio Output 1"
 *           as "CABLE Input (VB-Audio Virtual Cable)" (fake-cable-input,
 *           fake-cable); "Fake Audio Output 2" as "Headset Earphone (Fake
 *           Headset)" (fake-earpiece, fake-headset: the headset's earpiece)
 * The ids stay the same across reloads, as WebView2 keeps them in its
 * profile (headless Chromium gives every page load new ones): each is
 * mapped to Chromium's real id of that device wherever the page passes an id
 * back (getUserMedia, setSinkId, new AudioContext({sinkId})), and a context's
 * sinkId reads back the id the page gave. __fake.ids holds them;
 * __fake.realIds holds Chromium's own (for the leak checks).
 *
 * The loop: a context whose setSinkId took the cable gets a copy of its
 * destination (a MediaStream tap) mixed into a bus context (the fake's own);
 * an <audio> element whose setSinkId took the cable has its stream mixed in.
 * busGate (a gain) feeds busOut, whose track getUserMedia hands out as
 * "CABLE Output". Every connect(ctx.destination) of an app context is
 * recorded in __fake.destinationConnects with the sink at that moment. A
 * context that was ever sinked to the cable has __everCable; the voice
 * graph's contexts have __graph (they make the ac-passthrough and ac-meter
 * nodes, which the monitor's contexts never do).
 *
 * Refusals are worded as Chromium words them, ids included:
 * AudioContext.setSinkId names Chromium's own (64-hex) device id
 * ("access to the device <id> is not permitted."), the <audio> element's
 * does not ("No permission to use requested device").
 *
 * Switches (window.__fake): noCable, cableAlias(id), defaultOutputIsCable,
 * hideLabels, unplug(label) / plug(label) (a fake input, or "Fake Audio
 * Output 2", the earpiece), refuseContextSink,
 * refuseElementSink, resumeHangsOnce, pauseElement(), endMic(),
 * setMicGain(v), gumDelayMs, sinkDelayMs, cutCable(ms), devicechange(),
 * synthMic (set before the load: microphones are a steady 220 Hz tone made
 * in the fake's own context instead of a capture; Chromium lets a page
 * that captures the microphone start audio without a click, so only then
 * does a page without the autoplay flag need one).
 * Registries and helpers: contexts, cableContext(), oscillators, mics,
 * liveMics(), cablePeak(ms), ids, realIds.
 */
function fakeAudio() {
  const fake = (window.__fake = window.__fake || {});
  const md = navigator.mediaDevices;
  if (!md || typeof window.AudioContext !== "function") return;

  const NativeAC = window.AudioContext;
  const nativeEnumerate = md.enumerateDevices.bind(md);
  const nativeGum = md.getUserMedia.bind(md);
  const nativeCtxSetSink = NativeAC.prototype.setSinkId;
  const nativeSinkId = Object.getOwnPropertyDescriptor(NativeAC.prototype, "sinkId").get;
  const nativeConnect = AudioNode.prototype.connect;
  const nativeDisconnect = AudioNode.prototype.disconnect;
  const nativeElementSink = HTMLMediaElement.prototype.setSinkId;
  const nativeStart = AudioScheduledSourceNode.prototype.start;

  const CABLE_OUT_ID = "fake-cable-output";
  const CABLE_IN_ID = "fake-cable-input";
  const STABLE = Object.freeze({
    "Fake Audio Input 1": "fake-mic-1",
    "Fake Audio Input 2": "fake-mic-2",
    "Fake Audio Output 1": CABLE_IN_ID,
    "Fake Audio Output 2": "fake-earpiece",
  });
  const IN1 = "Fake Audio Input 1";
  const IN2 = "Fake Audio Input 2";
  const OUT1 = "Fake Audio Output 1";
  const OUT2 = "Fake Audio Output 2";
  const CABLE_IN_LABEL = "CABLE Input (VB-Audio Virtual Cable)";
  const CABLE_OUT_LABEL = "CABLE Output (VB-Audio Virtual Cable)";
  const EARPIECE_LABEL = "Headset Earphone (Fake Headset)";

  const defaults = {
    noCable: false,
    defaultOutputIsCable: false,
    hideLabels: false,
    refuseContextSink: false,
    refuseElementSink: false,
    resumeHangsOnce: false,
    gumDelayMs: 0,
    sinkDelayMs: 0,
    synthMic: false,
  };
  for (const [name, value] of Object.entries(defaults)) if (fake[name] === undefined) fake[name] = value;
  Object.assign(fake, {
    contexts: [],
    destinationConnects: [],
    oscillators: [],
    mics: [],
    cableElements: [],
    ids: { in1: STABLE[IN1], in2: STABLE[IN2], cableIn: CABLE_IN_ID, headsetOut: STABLE[OUT2], cableOut: CABLE_OUT_ID },
    realIds: {},
    alias: null,
    unplugged: new Set(),
    micGain: 1,
  });
  const native = new Map(); // the page's id → Chromium's id (refreshed by every enumerateDevices)
  const labelOf = new Map(); // the page's id → Chromium's own label

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const refusal = (name, message) => new DOMException(message, name);
  const sinkText = (ctx) => {
    const s = ctx.sinkId;
    return String(s?.type ?? s);
  };

  // ---- the bus: CABLE Input → CABLE Output ----
  const own = []; // the fake's own contexts (never in __fake.contexts)
  const bus = new NativeAC({ sampleRate: 48000 });
  own.push(bus);
  const busGate = bus.createGain();
  const busOut = bus.createMediaStreamDestination();
  busOut.channelCount = 1;
  busOut.channelCountMode = "explicit";
  const analyser = bus.createAnalyser();
  analyser.fftSize = 2048;
  nativeConnect.call(busGate, busOut);
  nativeConnect.call(busGate, analyser);

  // The fake's contexts play as soon as the page may play sound: at once with the autoplay flag, else after a click.
  const resumeOwn = () => {
    for (let i = own.length - 1; i >= 0; i--) {
      const c = own[i];
      if (c.state === "closed") own.splice(i, 1);
      else if (c.state === "suspended") c.resume().catch(() => {});
    }
  };
  for (const type of ["pointerdown", "keydown", "click"]) window.addEventListener(type, resumeOwn, true);
  resumeOwn();

  const isCable = (id) => typeof id === "string" && id !== "" && id === (fake.alias ?? CABLE_IN_ID);
  // After cableAlias the cable is no longer listed under its old id.
  const isOldCable = (id) => Boolean(fake.alias) && id === CABLE_IN_ID;
  /** Chromium's id for an id the page gives (the cable under its alias too); anything else as it is. */
  const toNative = (id) => (typeof id !== "string" ? id : isCable(id) ? native.get(CABLE_IN_ID) ?? id : native.get(id) ?? id);

  const taps = new Map(); // app context → { tap, source, linked }: its destination's copy into the bus
  function cableOn(ctx) {
    let t = taps.get(ctx);
    if (!t) {
      const tap = ctx.createMediaStreamDestination();
      tap.channelCount = 1;
      tap.channelCountMode = "explicit";
      t = { tap, source: bus.createMediaStreamSource(tap.stream), linked: false };
      taps.set(ctx, t);
    }
    if (!t.linked) {
      nativeConnect.call(t.source, busGate);
      t.linked = true;
    }
  }
  function cableOff(ctx) {
    const t = taps.get(ctx);
    if (!t || !t.linked) return;
    try {
      nativeDisconnect.call(t.source, busGate);
    } catch {
      // Not connected.
    }
    t.linked = false;
  }

  // ---- contexts ----
  class FakeAudioContext extends NativeAC {
    constructor(options) {
      let opts = options;
      let given = null;
      if (opts && typeof opts === "object" && typeof opts.sinkId === "string" && opts.sinkId) {
        given = { id: opts.sinkId, real: toNative(opts.sinkId) };
        opts = { ...opts, sinkId: given.real };
      }
      super(opts);
      this.__sink = given; // the id the page gave, and Chromium's id for it
      this.__everCable = false;
      fake.contexts.push(this);
    }

    get sinkId() {
      const real = nativeSinkId.call(this);
      return this.__sink && real === this.__sink.real ? this.__sink.id : real;
    }

    async setSinkId(id) {
      if (fake.sinkDelayMs > 0) await sleep(fake.sinkDelayMs);
      const cable = isCable(id);
      const real = toNative(id);
      if ((cable && fake.noCable) || isOldCable(id)) throw refusal("NotFoundError", `the device ${real} is not found.`);
      if (cable && fake.refuseContextSink) throw refusal("NotAllowedError", `access to the device ${real} is not permitted.`);
      await nativeCtxSetSink.call(this, real);
      this.__sink = typeof id === "string" && id ? { id, real } : null;
      if (cable) {
        this.__everCable = true;
        cableOn(this);
      } else {
        cableOff(this);
      }
    }

    resume() {
      if (taps.get(this)?.linked && (fake.noCable || fake.resumeHangsOnce)) {
        // The device fails again: Chromium fires "error" and the resume never settles.
        fake.resumeHangsOnce = false;
        setTimeout(() => this.dispatchEvent(new Event("error")), 0);
        return new Promise(() => {});
      }
      return super.resume();
    }
  }
  window.AudioContext = FakeAudioContext;

  fake.cableContext = () => {
    for (let i = fake.contexts.length - 1; i >= 0; i--) {
      const c = fake.contexts[i];
      if (c.state !== "closed" && taps.get(c)?.linked) return c;
    }
    return null;
  };

  // The voice graph's contexts: those that make its passthrough and meter nodes.
  const NativeWorkletNode = window.AudioWorkletNode;
  if (typeof NativeWorkletNode === "function") {
    window.AudioWorkletNode = class FakeAudioWorkletNode extends NativeWorkletNode {
      constructor(context, name, options) {
        super(context, name, options);
        if (name === "ac-passthrough" || name === "ac-meter") context.__graph = true;
      }
    };
  }

  // ---- connections: a copy into the bus, and a record of every connect to a destination ----
  AudioNode.prototype.connect = function connect(dest, ...rest) {
    const r = nativeConnect.call(this, dest, ...rest);
    if (dest instanceof AudioDestinationNode) {
      const ctx = dest.context;
      const index = fake.contexts.indexOf(ctx);
      if (index >= 0) fake.destinationConnects.push({ ctx: index, sinkIdAtConnect: sinkText(ctx) });
      const t = taps.get(ctx);
      if (t) nativeConnect.call(this, t.tap, rest[0] ?? 0);
    }
    return r;
  };
  AudioNode.prototype.disconnect = function disconnect(...args) {
    const r = nativeDisconnect.apply(this, args);
    const dest = args[0];
    if (dest instanceof AudioDestinationNode) {
      const t = taps.get(dest.context);
      if (t) {
        try {
          nativeDisconnect.call(this, t.tap);
        } catch {
          // Not connected to the copy.
        }
      }
    }
    return r;
  };

  OscillatorNode.prototype.start = function start(...args) {
    if (fake.contexts.includes(this.context)) fake.oscillators.push({ sinkId: sinkText(this.context), hz: this.frequency.value });
    return nativeStart.apply(this, args);
  };

  // ---- <audio> elements ----
  const loops = new Map(); // element → its stream's source in the bus
  function unloop(el) {
    const source = loops.get(el);
    if (!source) return;
    try {
      nativeDisconnect.call(source);
    } catch {
      // Already disconnected.
    }
    loops.delete(el);
  }
  function loop(el) {
    unloop(el);
    if (!(el.srcObject instanceof MediaStream) || el.srcObject.getAudioTracks().length === 0) return;
    const source = bus.createMediaStreamSource(el.srcObject);
    nativeConnect.call(source, busGate);
    loops.set(el, source);
    if (!fake.cableElements.includes(el)) fake.cableElements.push(el);
    el.addEventListener("pause", () => unloop(el), { once: true });
  }
  HTMLMediaElement.prototype.setSinkId = async function setSinkId(id) {
    if (fake.sinkDelayMs > 0) await sleep(fake.sinkDelayMs);
    const cable = isCable(id);
    if ((cable && fake.noCable) || isOldCable(id)) throw refusal("NotFoundError", "Requested device not found");
    if (cable && fake.refuseElementSink) throw refusal("SecurityError", "No permission to use requested device");
    await nativeElementSink.call(this, toNative(id));
    if (cable) loop(this);
    else unloop(this);
  };
  fake.pauseElement = () => {
    const el = fake.cableElements[fake.cableElements.length - 1];
    if (!el) return false;
    el.pause();
    return true;
  };

  // ---- device lists ----
  const entry = (deviceId, groupId, kind, label) => ({ deviceId, groupId, kind, label });
  md.enumerateDevices = async function enumerateDevices() {
    const list = (await nativeEnumerate()).filter((d) => d.kind === "audioinput" || d.kind === "audiooutput");
    if (!list.some((d) => d.label)) return list.map((d) => entry(d.deviceId, d.groupId, d.kind, d.label));
    const find = (kind, label) => list.find((d) => d.kind === kind && d.label === label) ?? null;
    for (const [label, id] of Object.entries(STABLE)) {
      const d = find(label.includes("Input") ? "audioinput" : "audiooutput", label);
      if (!d) continue;
      native.set(id, d.deviceId);
      labelOf.set(id, label);
      fake.realIds[id] = d.deviceId;
    }
    const in1 = find("audioinput", IN1);
    const in2 = find("audioinput", IN2);
    const out1 = find("audiooutput", OUT1);
    const out2 = find("audiooutput", OUT2);
    const plugged = [
      [in1, "fake-headset"],
      [in2, "fake-laptop"],
    ].filter(([d]) => d && !fake.unplugged.has(d.label));
    const out = [];
    if (plugged.length) out.push(entry("default", plugged[0][1], "audioinput", `Default - ${plugged[0][0].label}`));
    for (const [d, group] of plugged) out.push(entry(STABLE[d.label], group, "audioinput", d.label));
    if (!fake.noCable) out.push(entry(CABLE_OUT_ID, "fake-cable", "audioinput", CABLE_OUT_LABEL));
    out.push(
      fake.defaultOutputIsCable
        ? entry("default", "fake-cable", "audiooutput", `Default - ${CABLE_IN_LABEL}`)
        : entry("default", "fake-headset", "audiooutput", `Default - ${EARPIECE_LABEL}`),
    );
    if (!fake.noCable && out1) out.push(entry(fake.alias ?? CABLE_IN_ID, "fake-cable", "audiooutput", CABLE_IN_LABEL));
    if (out2 && !fake.unplugged.has(OUT2)) out.push(entry(STABLE[OUT2], "fake-headset", "audiooutput", EARPIECE_LABEL));
    if (fake.hideLabels) for (const d of out) d.label = "";
    return out;
  };
  const devicechange = () => md.dispatchEvent(new Event("devicechange"));
  fake.devicechange = devicechange;
  fake.unplug = (label) => {
    fake.unplugged.add(label);
    devicechange();
  };
  fake.plug = (label) => {
    fake.unplugged.delete(label);
    devicechange();
  };
  fake.cableAlias = (id) => {
    fake.alias = id;
  };

  // ---- microphones ----
  /** A microphone through a gain the test turns (setMicGain): the captured stream, or a synthetic tone. */
  function wrapMic(stream, label) {
    const ctx = new NativeAC({ sampleRate: 48000 });
    own.push(ctx);
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const gain = ctx.createGain();
    gain.gain.value = fake.micGain;
    const out = ctx.createMediaStreamDestination();
    out.channelCount = 1;
    out.channelCountMode = "explicit";
    let source;
    if (stream) {
      source = ctx.createMediaStreamSource(stream);
    } else {
      source = ctx.createOscillator();
      source.frequency.value = 220;
      const level = ctx.createGain();
      level.gain.value = 0.3;
      nativeConnect.call(source, level);
      source.start();
      source = level;
    }
    nativeConnect.call(source, gain);
    nativeConnect.call(gain, out);
    const track = out.stream.getAudioTracks()[0];
    const nativeTrack = stream?.getAudioTracks()[0] ?? null;
    // What the browser reports for the real microphone (processing off, as asked), not for the copy.
    const synthetic = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: 48000, channelCount: 1 };
    track.getSettings = () => (nativeTrack ? { ...nativeTrack.getSettings() } : { ...synthetic });
    const mic = { label, track, gain, live: true };
    const stop = track.stop.bind(track);
    track.stop = () => {
      if (!mic.live) return;
      mic.live = false;
      stop();
      for (const t of stream?.getTracks() ?? []) t.stop();
      ctx.close().catch(() => {});
    };
    fake.mics.push(mic);
    return out.stream;
  }
  md.getUserMedia = async function getUserMedia(constraints) {
    if (fake.gumDelayMs > 0) await sleep(fake.gumDelayMs);
    const want = constraints?.audio?.deviceId;
    const exact = typeof want === "string" ? want : want?.exact;
    if (exact === CABLE_OUT_ID) {
      if (fake.noCable) throw refusal("NotFoundError", "Requested device not found");
      bus.resume().catch(() => {});
      return new MediaStream([busOut.stream.getAudioTracks()[0].clone()]);
    }
    const label = exact ? (labelOf.get(exact) ?? "unknown") : "default";
    if (exact && fake.unplugged.has(label)) {
      let err;
      try {
        err = new OverconstrainedError("deviceId", "The microphone is not connected.");
      } catch {
        err = refusal("OverconstrainedError", "The microphone is not connected.");
      }
      throw err;
    }
    if (fake.synthMic) return wrapMic(null, label);
    let asked = constraints;
    if (exact) asked = { ...constraints, audio: { ...constraints.audio, deviceId: { exact: toNative(exact) } } };
    return wrapMic(await nativeGum(asked), label);
  };
  // A local stop() fires no "ended": this does, as an unplugged headset or a stopped Windows Audio would.
  fake.endMic = () => {
    const mic = [...fake.mics].reverse().find((m) => m.live);
    if (!mic) return false;
    mic.track.stop();
    mic.track.dispatchEvent(new Event("ended"));
    return true;
  };
  fake.liveMics = () => fake.mics.filter((m) => m.live).map((m) => m.label);
  fake.setMicGain = (v) => {
    fake.micGain = v;
    for (const m of fake.mics) if (m.live) m.gain.gain.value = v;
  };

  // ---- what the meeting would hear ----
  fake.cutCable = (ms) => {
    const t = bus.currentTime;
    busGate.gain.setValueAtTime(0, t);
    busGate.gain.setValueAtTime(1, t + ms / 1000);
  };
  /** The highest level that reached CABLE Output during the next `ms`. */
  fake.cablePeak = async (ms = 1000) => {
    resumeOwn();
    const buf = new Float32Array(analyser.fftSize);
    let peak = 0;
    const until = performance.now() + ms;
    do {
      analyser.getFloatTimeDomainData(buf);
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i]);
        if (v > peak) peak = v;
      }
      await sleep(20);
    } while (performance.now() < until);
    return peak;
  };
}

module.exports = { fakeFlags, fakeTauri, fakeAudio };
