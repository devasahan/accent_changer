/**
 * Records several inputs side by side, sample-aligned (they are read in the
 * same render quantum), and posts them to the page in chunks (4800 frames =
 * 100 ms at 48 kHz unless processorOptions.chunkFrames says otherwise).
 * Used by the app's checks (src/audio/measure.js) and by the Step 0 probe.
 *
 * Any number of inputs (the node's numberOfInputs), mono. An input that is
 * not connected, or not flowing yet, is written as zeros, so the inputs stay
 * aligned. It works with or without an output: with numberOfOutputs 0 the
 * browser pulls it on every render quantum while its context runs, until it
 * has stopped (see below).
 *
 * Messages in: "start" (from now on, recording starts afresh), "stop" (the
 * part of a chunk recorded so far is sent, then { type: "stopped" }).
 * Messages out: { type: "chunk", parts } (one Float32Array per input, their
 * buffers transferred), { type: "stopped" }.
 *
 * Its life: process() returns true until "stop" and false after it. A
 * processor that returns false while no input is connected is never called
 * again, so the browser drops a stopped recorder once its inputs are
 * disconnected. Before "start" it must stay: its inputs may not be connected
 * yet.
 */
const CHUNK_FRAMES = 4800;

class Recorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const inputs = options?.numberOfInputs;
    this.inputsCount = Number.isInteger(inputs) && inputs > 0 ? inputs : 1;
    const chunk = options?.processorOptions?.chunkFrames;
    this.chunkFrames = Number.isInteger(chunk) && chunk > 0 ? chunk : CHUNK_FRAMES;
    this.active = false;
    this.stopped = false;
    this.fresh();
    this.port.onmessage = (e) => {
      if (e.data === "start") {
        this.fresh();
        this.active = true;
        this.stopped = false;
      } else if (e.data === "stop") {
        this.flush();
        this.active = false;
        this.stopped = true;
        this.port.postMessage({ type: "stopped" });
      }
    };
  }

  fresh() {
    this.buffers = Array.from({ length: this.inputsCount }, () => new Float32Array(this.chunkFrames));
    this.fill = 0;
  }

  flush() {
    if (!this.fill) return;
    const parts = this.buffers.map((b) => (this.fill === b.length ? b : b.slice(0, this.fill)));
    this.port.postMessage({ type: "chunk", parts }, parts.map((p) => p.buffer));
    this.fresh();
  }

  process(inputs) {
    if (!this.active) return !this.stopped;
    let frames = 128;
    for (let i = 0; i < this.inputsCount; i++) {
      const channel = inputs[i]?.[0];
      if (channel) {
        frames = channel.length;
        break;
      }
    }
    let k = 0;
    while (k < frames) {
      const take = Math.min(frames - k, this.chunkFrames - this.fill);
      for (let i = 0; i < this.inputsCount; i++) {
        const channel = inputs[i]?.[0];
        const target = this.buffers[i];
        if (channel) target.set(channel.subarray(k, k + take), this.fill);
        else target.fill(0, this.fill, this.fill + take); // input not flowing yet: silence keeps alignment
      }
      this.fill += take;
      k += take;
      if (this.fill === this.chunkFrames) this.flush();
    }
    return true;
  }
}

registerProcessor("ac-recorder", Recorder);
