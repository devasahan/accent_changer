import test from "node:test";
import assert from "node:assert/strict";
import { decodeWav, encodeWav } from "../src/core/wav.js";

test("16-bit stereo round trip keeps samples within one step", () => {
  const left = Float32Array.from([0, 0.5, -0.5, 1, -1, 0.25]);
  const right = Float32Array.from([0.1, -0.1, 0.9, -0.9, 0, 0]);
  const bytes = encodeWav([left, right], 48000);
  assert.equal(bytes.byteLength, 44 + 6 * 2 * 2);
  const text = (o) => String.fromCharCode(...bytes.slice(o, o + 4));
  assert.equal(text(0), "RIFF");
  assert.equal(text(8), "WAVE");
  const { sampleRate, channels } = decodeWav(bytes);
  assert.equal(sampleRate, 48000);
  assert.equal(channels.length, 2);
  channels[0].forEach((v, i) => assert.ok(Math.abs(v - left[i]) < 1 / 16000, `L${i}`));
  channels[1].forEach((v, i) => assert.ok(Math.abs(v - right[i]) < 1 / 16000, `R${i}`));
});

test("out-of-range and NaN samples are clipped, not wrapped", () => {
  const { channels } = decodeWav(encodeWav([Float32Array.from([2, -3, NaN])], 16000));
  assert.ok(channels[0][0] > 0.999);
  assert.equal(channels[0][1], -1);
  assert.equal(channels[0][2], 0);
});

test("32-bit float round trip is exact", () => {
  const x = Float32Array.from([0.123456, -0.654321, 0]);
  const { channels } = decodeWav(encodeWav([x], 44100, { float: true }));
  assert.deepEqual(Array.from(channels[0]), Array.from(x));
});

test("rejects channels of different lengths and non-WAV input", () => {
  assert.throws(() => encodeWav([new Float32Array(2), new Float32Array(3)], 8000), /differ/);
  assert.throws(() => decodeWav(new Uint8Array(20)), /not a WAV/);
});
