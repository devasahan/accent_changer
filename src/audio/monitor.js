/**
 * Sounds for the user's own ears: test beeps (later Step 5's beeps and
 * Step 6's previews) and the test tone of the long check. None of it may
 * ever reach VB-CABLE, or the meeting would hear it.
 *
 * Every context here gets an explicit playback device with setSinkId before
 * anything is connected to it. An explicit device never follows a change of
 * Windows' default device, and when it goes away Chromium reports an error
 * instead of falling back to another device.
 *  - Beeps and previews go to the earpiece of the headset whose microphone is
 *    in use, else to the real device behind Windows' default. They are
 *    refused when that device is the cable or another virtual device, when
 *    device names are hidden, and while a stand-in microphone is in use (the
 *    headset is unplugged: a beep from the laptop's speakers would reach the
 *    meeting through the laptop's microphone).
 *  - The tone plays on the real device behind Windows' default output: the
 *    clock the converted voice will come from in Step 7. It goes into a
 *    MediaStream (the graph's test source), never to the speakers.
 * A refusal throws a MonitorError whose code is a WARNINGS key and whose
 * message is that warning's text.
 *
 * At most two contexts are kept, one per device (beeps and the tone share
 * one when they resolve to the same device). They are made when first
 * needed. Nothing touches the page when this module is imported.
 */
import { TONE_HZ } from "../core/signal-watch.js";
import { WARNINGS, headphonesFor, toneOutput, virtualOutputs } from "../core/device-choice.js";

const SINK_TIMEOUT_MS = 5000;
const BEEP_DBFS = -18;
const RAMP_SEC = 0.005; // 5 ms fade in and out: no click at either end
const LEAD_SEC = 0.03; // beeps start a little after "now", on the audio clock

/** Beep patterns: tones { hz, ms } and gaps { gap: ms }. */
const BEEPS = Object.freeze({
  test: [{ hz: 660, ms: 120 }, { gap: 60 }, { hz: 880, ms: 120 }],
  on: [{ hz: 880, ms: 100 }],
  off: [{ hz: 440, ms: 100 }],
  warn: [{ hz: 440, ms: 80 }, { gap: 60 }, { hz: 440, ms: 80 }],
});

/** A sound the monitor refused to play. code: a WARNINGS key; message: its text. */
export class MonitorError extends Error {
  /** @param {string} code */
  constructor(code) {
    const text = typeof WARNINGS[code] === "string" ? WARNINGS[code] : String(code);
    super(text);
    this.name = "MonitorError";
    this.code = code;
  }
}

function nameOf(err) {
  return err && typeof err === "object" && typeof err.name === "string" && err.name ? err.name : "Error";
}

/** `promise`, or a rejection named TimeoutError after `ms`. */
function timed(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error("setSinkId timed out");
        e.name = "TimeoutError";
        reject(e);
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const isVirtualOutput = (entry) => virtualOutputs([{ ...entry, kind: "audiooutput" }]).length > 0;

export class Monitor {
  /**
   * @param {object} [options]
   * @param {() => object|null} [options.getSnapshot] the graph's device snapshot
   * @param {() => {entry: object, standIn: boolean}|null} [options.getMic] the graph's microphone
   * @param {(level: string, text: string) => void} [options.log] codes and names only
   */
  constructor({ getSnapshot = () => null, getMic = () => null, log = () => {} } = {}) {
    this._getSnapshot = getSnapshot;
    this._getMic = getMic;
    this._logFn = log;
    this._slots = new Map(); // deviceId → slot
  }

  /**
   * Play a beep in the user's headphones. kind: "test" (660 Hz then 880 Hz,
   * 120 ms each), or Step 5's "on", "off", "warn". Scheduled on the audio
   * clock. Resolves when it has played: { sink: "mic-sibling" | "default" }.
   * Throws a MonitorError when the headphones cannot be used.
   * @param {string} [kind]
   */
  async beep(kind = "test") {
    const target = this._beepTarget();
    const slot = await this._slot(target.entry, "beep");
    const { ctx } = slot;
    const pattern = BEEPS[kind] ?? BEEPS.test;
    const level = 10 ** (BEEP_DBFS / 20);
    let t = ctx.currentTime + LEAD_SEC;
    const nodes = [];
    for (const part of pattern) {
      if (part.gap) {
        t += part.gap / 1000;
        continue;
      }
      const dur = part.ms / 1000;
      const osc = ctx.createOscillator();
      osc.frequency.value = part.hz;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(level, t + RAMP_SEC);
      gain.gain.setValueAtTime(level, t + dur - RAMP_SEC);
      gain.gain.linearRampToValueAtTime(0, t + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + dur);
      nodes.push(osc, gain);
      t += dur;
    }
    const last = nodes[nodes.length - 2];
    await this._play(slot, nodes, last, (t - ctx.currentTime) * 1000);
    return { sink: target.how };
  }

  /**
   * The long check's test tone on the clock of Windows' default playback
   * device: an oscillator (hz) → gain (dbfs) → a mono MediaStream. Nothing
   * is played on that device. → { stream, stop(), onLost(callback) }; the
   * callbacks run when the tone stops by itself (its device went away or
   * failed). Throws a MonitorError when that device cannot be used.
   * @param {{hz?: number, dbfs?: number}} [options]
   */
  async toneStream({ hz = TONE_HZ, dbfs = -12 } = {}) {
    const choice = toneOutput(this._getSnapshot());
    if (choice.refusal) {
      this._log("info", `monitor refused ${choice.refusal}`);
      throw new MonitorError(choice.refusal);
    }
    const slot = await this._slot(choice.entry, "tone");
    const { ctx } = slot;
    const osc = ctx.createOscillator();
    osc.frequency.value = hz;
    const gain = ctx.createGain();
    gain.gain.value = 10 ** (dbfs / 20);
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 1;
    dest.channelCountMode = "explicit";
    osc.connect(gain);
    gain.connect(dest);
    osc.start();
    const tone = { osc, gain, dest, callbacks: [], lost: false, stopped: false };
    slot.tones.add(tone);
    return {
      stream: dest.stream,
      stop: () => this._stopTone(slot, tone),
      onLost: (callback) => {
        if (typeof callback !== "function") return;
        if (tone.lost) queueMicrotask(callback);
        else tone.callbacks.push(callback);
      },
    };
  }

  /**
   * Step 6's previews: play an AudioBuffer in the headphones (BufferSource →
   * Gain → destination), refused like a beep (the refusal is thrown at
   * once). → { stop(), done } where done resolves when it has played and
   * rejects with a MonitorError when the headphones failed.
   * @param {AudioBuffer} audioBuffer
   */
  play(audioBuffer) {
    const target = this._beepTarget();
    let stopped = false;
    let source = null;
    const done = (async () => {
      const slot = await this._slot(target.entry, "beep");
      if (stopped) return;
      const { ctx } = slot;
      source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      const gain = ctx.createGain();
      gain.gain.value = 1;
      source.connect(gain);
      gain.connect(ctx.destination);
      source.start();
      await this._play(slot, [source, gain], source, (audioBuffer?.duration ?? 0) * 1000);
    })();
    done.catch(() => {});
    return {
      stop() {
        stopped = true;
        try {
          source?.stop();
        } catch {
          // Not started, or already stopped.
        }
      },
      done,
    };
  }

  /**
   * The devices changed (main.js calls this on the graph's "devices" event):
   * a context whose device is gone or is now a virtual device is closed (a
   * beep stops, a tone's onLost callbacks run); beeps stop on a device that
   * is no longer the headphones, or while they are refused. A tone keeps its
   * device when Windows' default merely moved to another real device.
   */
  refresh() {
    const snap = this._getSnapshot();
    if (!snap) return;
    const mic = this._getMic();
    const beep = headphonesFor(snap, { mic: mic?.entry ?? null, standIn: Boolean(mic?.standIn) });
    for (const slot of [...this._slots.values()]) {
      const entry = (snap.outputs ?? []).find((d) => d.deviceId === slot.id);
      if (!entry || (snap.labelsVisible && isVirtualOutput(entry))) {
        this._log("warn", `monitor device ${entry ? "now virtual" : "gone"}`);
        this._drop(slot, true);
        continue;
      }
      if (slot.roles.has("beep") && (beep.refusal || beep.entry?.deviceId !== slot.id)) {
        slot.roles.delete("beep");
        for (const sound of [...slot.sounds]) sound.stop();
      }
      if (slot.roles.size === 0 && slot.tones.size === 0 && slot.sounds.size === 0) this._drop(slot, false);
    }
  }

  /** "closed" (no context), "running" (one runs) or "suspended". */
  get state() {
    if (this._slots.size === 0) return "closed";
    for (const slot of this._slots.values()) if (slot.ctx.state === "running") return "running";
    return "suspended";
  }

  /** Close every context (beeps stop, tones end; no onLost callbacks). */
  async close() {
    const slots = [...this._slots.values()];
    for (const slot of slots) this._drop(slot, false);
    await Promise.all(slots.map((s) => s.closing));
  }

  // ---------------------------------------------------------------- inner workings

  /** Where a beep or a preview may play, or a MonitorError. */
  _beepTarget() {
    const mic = this._getMic();
    const choice = headphonesFor(this._getSnapshot(), { mic: mic?.entry ?? null, standIn: Boolean(mic?.standIn) });
    if (choice.refusal) {
      this._log("info", `monitor refused ${choice.refusal}`);
      throw new MonitorError(choice.refusal);
    }
    return choice;
  }

  /**
   * The context for a device, made on first use: its sink is set to the
   * device before anything is connected. A role ("beep" or "tone") moves to
   * the newest device that asked for it; a context left without a role and
   * without sounds is closed, so at most two stay open.
   */
  async _slot(entry, role) {
    for (const other of [...this._slots.values()]) {
      if (other.id === entry.deviceId || !other.roles.has(role)) continue;
      const busy = role === "tone" ? other.tones.size > 0 : other.sounds.size > 0;
      if (busy) continue;
      other.roles.delete(role);
      if (other.roles.size === 0 && other.tones.size === 0 && other.sounds.size === 0) this._drop(other, false);
    }
    let slot = this._slots.get(entry.deviceId);
    if (!slot) slot = this._newSlot(entry.deviceId);
    slot.roles.add(role);
    try {
      await slot.ready;
    } catch (err) {
      this._log("warn", `monitor sink failed ${nameOf(err)}`);
      this._drop(slot, true);
      throw new MonitorError("NO_HEADPHONES");
    }
    if (slot.dropped || slot.ctx.state === "closed") throw new MonitorError("NO_HEADPHONES");
    if (slot.ctx.state !== "running") slot.ctx.resume().catch(() => {});
    return slot;
  }

  _newSlot(deviceId) {
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    const slot = {
      id: deviceId,
      ctx,
      roles: new Set(),
      tones: new Set(),
      sounds: new Set(),
      listeners: new AbortController(),
      settingSink: true,
      dropped: false,
      closing: null,
      ready: null,
    };
    const signal = slot.listeners.signal;
    ctx.addEventListener("statechange", () => this._onState(slot), { signal });
    ctx.addEventListener("error", () => {
      this._log("warn", "monitor context error");
      this._drop(slot, true);
    }, { signal });
    slot.ready = (async () => {
      try {
        await timed(ctx.setSinkId(deviceId), SINK_TIMEOUT_MS);
        if (ctx.sinkId !== deviceId) {
          const e = new Error("The monitor's context did not switch to the headphones.");
          e.name = "InvalidStateError";
          throw e;
        }
      } finally {
        slot.settingSink = false;
      }
    })();
    slot.ready.catch(() => {});
    this._slots.set(deviceId, slot);
    return slot;
  }

  /** A suspension the monitor did not cause: resume once; if that fails, drop the context. */
  _onState(slot) {
    if (slot.dropped) return;
    const { ctx } = slot;
    if (ctx.state === "closed") {
      this._drop(slot, true);
      return;
    }
    if ((ctx.state === "suspended" || ctx.state === "interrupted") && !slot.settingSink) {
      ctx.resume().catch(() => {
        this._log("warn", "monitor resume failed");
        this._drop(slot, true);
      });
    }
  }

  /**
   * Track a sound until `last` has ended (or the slot is dropped); then
   * disconnect its nodes. A backstop timer covers a context that never runs.
   */
  _play(slot, nodes, last, durationMs) {
    return new Promise((resolve) => {
      let timer = null;
      const sound = {
        stop: () => {
          for (const node of nodes) {
            try {
              if (typeof node.stop === "function") node.stop();
            } catch {
              // Not started, or already stopped.
            }
          }
          finish();
        },
      };
      const finish = () => {
        if (!slot.sounds.has(sound)) return;
        slot.sounds.delete(sound);
        clearTimeout(timer);
        for (const node of nodes) {
          try {
            node.disconnect();
          } catch {
            // Already disconnected.
          }
        }
        resolve();
      };
      slot.sounds.add(sound);
      if (last) last.addEventListener("ended", finish, { once: true });
      timer = setTimeout(finish, Math.max(0, durationMs) + 1500);
    });
  }

  _stopTone(slot, tone) {
    if (tone.stopped) return;
    tone.stopped = true;
    try {
      tone.osc.stop();
    } catch {
      // Already stopped.
    }
    for (const node of [tone.osc, tone.gain]) {
      try {
        node.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    for (const track of tone.dest.stream.getTracks()) track.stop();
    slot.tones.delete(tone);
  }

  /** Close a slot's context. lost: its tones stopped by themselves (run their onLost callbacks). */
  _drop(slot, lost) {
    if (slot.dropped) return;
    slot.dropped = true;
    if (this._slots.get(slot.id) === slot) this._slots.delete(slot.id);
    slot.listeners.abort();
    for (const sound of [...slot.sounds]) sound.stop();
    for (const tone of [...slot.tones]) {
      this._stopTone(slot, tone);
      if (lost && !tone.lost) {
        tone.lost = true;
        for (const cb of tone.callbacks) {
          try {
            cb();
          } catch {
            // The listener's own problem.
          }
        }
      }
    }
    let closing;
    try {
      closing = slot.ctx.state === "closed" ? Promise.resolve() : slot.ctx.close();
    } catch {
      closing = Promise.resolve();
    }
    slot.closing = Promise.resolve(closing).catch(() => {});
  }

  _log(level, text) {
    try {
      this._logFn(level, text);
    } catch {
      // A log line is never worth an error.
    }
  }
}
