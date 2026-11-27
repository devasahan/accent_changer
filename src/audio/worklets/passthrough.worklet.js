/**
 * ac-passthrough: the processor slot's Step 2 occupant. Input 0 (the
 * microphone, or the test tone during the long check) goes to the output
 * unchanged, sample for sample, with no delay. Input 1 is where Step 4's
 * safety mixer gets the converted voice; it is ignored here. A missing input
 * (nothing connected yet) gives silence.
 *
 * Node options (graph.js): 2 inputs, 1 output with 1 channel, channelCount 1,
 * channelCountMode "explicit", channelInterpretation "speakers" (mono).
 */
class Passthrough extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const out = outputs[0]?.[0];
    if (!out) return true;
    const src = inputs[0]?.[0];
    if (src && src.length === out.length) out.set(src);
    else out.fill(0);
    return true;
  }
}

registerProcessor("ac-passthrough", Passthrough);
