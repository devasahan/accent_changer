/**
 * ac-meter: the level meters and the heartbeat of the passthrough graph.
 * Input 0 is micBus (the microphone after its clock crossing), input 1 is
 * outBus (what goes to the cable). The node has no outputs: Chromium pulls
 * it on every render quantum, which keeps the context's silent-sink
 * suspender off, so the voice never waits for it after a long silence.
 *
 * Every windowFrames (4800 = 100 ms at 48 kHz) it posts:
 *   { type: "levels", frame, contextFrame, micRmsDb, micPeakDb, outRmsDb,
 *     outPeakDb, micHoles: [{startFrame, frames}], micOpenZeroFrames }
 * frame: samples this node has measured (micHoles' startFrame counts the
 * same way); contextFrame: the context's own frame count at the end of the
 * window, so the page can tell a message made after a given moment;
 * micHoles: runs of digital silence of 1 ms or more on input 0 that ended
 * since the last message (a clock crossing's underrun inserts 10 ms of
 * zeros); micOpenZeroFrames: the length of a run still open.
 * Messages are made on the audio thread, so a busy or hidden page cannot
 * hold them back: they prove that the context renders.
 * A missing input channel counts as zeros.
 */
import { LevelWindow, ZeroRuns } from "../../core/signal-watch.js";

class Meter extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const asked = options?.processorOptions?.windowFrames;
    const frames = Number.isFinite(asked) && asked > 0 ? Math.round(asked) : 4800;
    this.mic = new LevelWindow({ frames });
    this.out = new LevelWindow({ frames });
    this.holes = new ZeroRuns({ minFrames: 48 });
    this.frame = 0;
    this.zeros = new Float32Array(128);
  }

  /** A preallocated block of zeros as long as `n` (a render quantum is 128 frames). */
  silence(n) {
    if (this.zeros.length !== n) this.zeros = new Float32Array(n);
    return this.zeros;
  }

  process(inputs) {
    const a = inputs[0]?.[0];
    const b = inputs[1]?.[0];
    const n = a ? a.length : b ? b.length : 128;
    const mic = a ?? this.silence(n);
    const out = b && b.length === n ? b : this.silence(n);
    const done = this.mic.push(mic);
    this.out.push(out);
    this.holes.push(mic);
    this.frame += n;
    if (done) {
      this.port.postMessage({
        type: "levels",
        frame: this.frame,
        contextFrame: currentFrame + n,
        micRmsDb: this.mic.rmsDb,
        micPeakDb: this.mic.peakDb,
        outRmsDb: this.out.rmsDb,
        outPeakDb: this.out.peakDb,
        micHoles: this.holes.takeRuns(),
        micOpenZeroFrames: this.holes.openFrames,
      });
    }
    return true;
  }
}

registerProcessor("ac-meter", Meter);
