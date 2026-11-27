/**
 * ac-cablewatch: the long check's ears on what the meeting hears.
 * Input 0 is micBus (the microphone as the passthrough has it; on the audio
 * element route, a fresh source of the microphone). Input 1 is "CABLE
 * Output", recorded in a context that runs on VB-CABLE's clock. The node has
 * no outputs: Chromium pulls it on every render quantum while its context
 * runs. A missing input channel counts as zeros.
 *
 * processorOptions: { mode: "tone" | "mic", stopAfterFrames, summaryFrames }
 *  - tone: a ToneCheck listens to the test tone on CABLE Output (holes,
 *    skips, clicks, drop-outs, gaps, other sound, volume changes), and the
 *    microphone's runs of digital silence are kept.
 *  - mic: 5 ms loudness envelopes of both inputs, and the runs of digital
 *    silence of both.
 *
 * Every summaryFrames (48000 = 1 s at 48 kHz) it posts:
 *   { type: "summary", frame, contextFrame, producedEpochMs, mode, final,
 *     tone?: { locked, levelDb, lockDb, minStableDb, phaseDriftPpm, counts, events },
 *     env?: { frame0, ref, sig, dropped }   (Float32Arrays, their buffers transferred),
 *     refRuns, refZeroFrames, refDropped, sigRuns?, sigZeroFrames?, sigDropped? }
 * frame: the samples this node has watched (every atFrame and startFrame in
 * the summary counts the same way); producedEpochMs: Date.now() when the
 * summary was made, on the audio thread, so a busy or hidden page cannot
 * move it; events, refRuns and sigRuns: what ended since the last summary;
 * counts, refZeroFrames and sigZeroFrames: everything so far.
 *
 * After stopAfterFrames samples it closes what is still going on (a tone
 * lost at the very end is a gap), posts a last summary (final: true) and
 * { type: "done", frame }, and then does nothing more: process() returns
 * false from then on, so the browser drops the node once its inputs are
 * disconnected (until then it calls it, and it returns at once).
 * Messages in: "stop" (the same, now); { type: "extend", stopAfterFrames }
 * (stop later, or now when that many samples have already been watched).
 */
import { EnvelopeStream, ToneCheck, ZeroRuns } from "../../core/signal-watch.js";

const SUMMARY_FRAMES = 48000;
const HOP_FRAMES = 240; // 5 ms at 48 kHz: one envelope frame

const wholeOr = (v, fallback) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : fallback);

class CableWatch extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options?.processorOptions ?? {};
    this.mode = o.mode === "mic" ? "mic" : "tone";
    const every = wholeOr(o.summaryFrames, SUMMARY_FRAMES);
    this.summaryFrames = every > 0 ? every : SUMMARY_FRAMES;
    this.stopAfter = wholeOr(o.stopAfterFrames, Infinity);
    this.frame = 0;
    this.sinceSummary = 0;
    this.done = false;
    this.zeros = new Float32Array(128);
    this.refRuns = new ZeroRuns();
    if (this.mode === "tone") {
      this.tone = new ToneCheck({ sampleRate });
    } else {
      // Room for one summary's frames between two takes, and some to spare.
      const capacity = Math.max(2048, Math.ceil(this.summaryFrames / HOP_FRAMES) + 64);
      this.envRef = new EnvelopeStream({ sampleRate, hopMs: 5, winMs: 10, capacity });
      this.envSig = new EnvelopeStream({ sampleRate, hopMs: 5, winMs: 10, capacity });
      this.sigRuns = new ZeroRuns();
    }
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    if (this.done) return;
    if (m === "stop" || m?.type === "stop") {
      this.finish();
    } else if (m?.type === "extend" && Number.isFinite(m.stopAfterFrames)) {
      this.stopAfter = Math.max(Math.round(m.stopAfterFrames), this.frame);
      if (this.frame >= this.stopAfter) this.finish();
    }
  }

  /** A preallocated block of zeros as long as `n` (a render quantum is 128 frames). */
  silence(n) {
    if (this.zeros.length !== n) this.zeros = new Float32Array(n);
    return this.zeros;
  }

  process(inputs) {
    if (this.done) return false;
    if (this.frame >= this.stopAfter) {
      this.finish();
      return false;
    }
    const a = inputs[0]?.[0];
    const b = inputs[1]?.[0];
    const n = a ? a.length : b ? b.length : 128;
    let ref = a && a.length === n ? a : this.silence(n);
    let sig = b && b.length === n ? b : this.silence(n);
    let take = n;
    const left = this.stopAfter - this.frame;
    if (left < n) {
      // The last block: only the samples up to the stop.
      take = left;
      ref = ref.subarray(0, take);
      sig = sig.subarray(0, take);
    }
    this.refRuns.push(ref);
    if (this.mode === "tone") {
      this.tone.push(sig);
    } else {
      this.envRef.push(ref);
      this.envSig.push(sig);
      this.sigRuns.push(sig);
    }
    this.frame += take;
    this.sinceSummary += take;
    if (this.frame >= this.stopAfter) {
      this.finish();
    } else if (this.sinceSummary >= this.summaryFrames) {
      this.sinceSummary -= this.summaryFrames;
      this.post(false);
    }
    return !this.done;
  }

  /** The end: close what is still going on, post the last summary and "done", then stay idle. */
  finish() {
    if (this.done) return;
    this.done = true;
    if (this.tone) this.tone.finish();
    this.refRuns.finish();
    if (this.sigRuns) this.sigRuns.finish();
    this.post(true);
    this.port.postMessage({ type: "done", frame: this.frame });
  }

  post(final) {
    const msg = {
      type: "summary",
      frame: this.frame,
      contextFrame: currentFrame,
      producedEpochMs: Date.now(),
      mode: this.mode,
      final,
      refRuns: this.refRuns.takeRuns(),
      refZeroFrames: this.refRuns.zeroFrames,
      refDropped: this.refRuns.dropped,
    };
    const transfer = [];
    if (this.tone) {
      const t = this.tone;
      msg.tone = {
        locked: t.locked,
        levelDb: t.levelDb,
        lockDb: t.lockDb,
        minStableDb: t.minStableDb,
        phaseDriftPpm: t.phaseDriftPpm,
        counts: t.counts,
        events: t.takeEvents(),
      };
    } else {
      const frame0 = this.envRef.frame0;
      const ref = this.envRef.take();
      const sig = this.envSig.take();
      msg.env = { frame0, ref, sig, dropped: this.envRef.dropped + this.envSig.dropped };
      transfer.push(ref.buffer, sig.buffer);
      msg.sigRuns = this.sigRuns.takeRuns();
      msg.sigZeroFrames = this.sigRuns.zeroFrames;
      msg.sigDropped = this.sigRuns.dropped;
    }
    this.port.postMessage(msg, transfer);
  }
}

registerProcessor("ac-cablewatch", CableWatch);
