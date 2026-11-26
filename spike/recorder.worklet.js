/**
 * Records several inputs side by side, sample-aligned (they are read in the
 * same render quantum), and posts them to the page in 100 ms chunks.
 * Messages in: "start", "stop". Messages out: { type: "chunk", parts },
 * { type: "stopped" }.
 */
class SpikeRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.inputsCount = options.numberOfInputs;
    this.chunkFrames = options.processorOptions?.chunkFrames ?? Math.round(sampleRate / 10);
    this.active = false;
    this.fresh();
    this.port.onmessage = (e) => {
      if (e.data === "start") {
        this.fresh();
        this.active = true;
      } else if (e.data === "stop") {
        this.flush();
        this.active = false;
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
    if (!this.active) return true;
    const frames = inputs[0]?.[0]?.length ?? 128;
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

registerProcessor("spike-recorder", SpikeRecorder);
