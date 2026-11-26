import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeRun,
  bandwidthHz,
  envelopeDb,
  estimateDelay,
  fft,
  findGaps,
  hasSignal,
  median,
  percentile,
  speechMask,
  utterances,
} from "../src/core/delay-estimate.js";
import { addNoise, bandNoise, breathNoise, delayed, padded, recolour, rng, synthSpeech } from "./helpers/synth.js";

const SR = 48000;
const ms = (x) => Math.round((x * SR) / 1000);

test("percentile and median interpolate and ignore non-numbers", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(percentile([0, 10], 25), 2.5);
  assert.equal(percentile([5, NaN, null, 7], 100), 7);
  assert.equal(percentile([], 50), null);
});

test("fft finds a pure tone in its bin", () => {
  const n = 256;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 10 * i) / n);
  fft(re, im);
  const mag = Array.from(re, (r, k) => Math.hypot(r, im[k]));
  const peak = mag.indexOf(Math.max(...mag.slice(0, n / 2)));
  assert.equal(peak, 10);
  assert.ok(Math.abs(mag[10] - n / 2) < 1e-6);
});

test("envelope: one frame per hop, silence floors at -120 dB", () => {
  const { db, hopMs } = envelopeDb(new Float32Array(SR), SR, { hopMs: 2, winMs: 10 });
  assert.equal(hopMs, 2);
  assert.equal(db.length, Math.floor((SR - 480) / 96) + 1);
  assert.ok(db.every((v) => v === -120));
  assert.equal(hasSignal(db), false);
});

test("a 237 ms delay is found within ±5 ms", () => {
  const { samples } = synthSpeech({ seconds: 14, seed: 11 });
  const sig = delayed(samples, ms(237));
  const est = estimateDelay(samples, sig, SR);
  assert.ok(est, "expected an estimate");
  assert.ok(Math.abs(est.lagMs - 237) <= 5, `got ${est.lagMs.toFixed(1)} ms`);
  assert.ok(est.score > 0.9, `score ${est.score}`);
});

test("delay survives a different voice colour, a level change and noise (±10 ms)", () => {
  for (const seed of [2, 5, 9]) {
    const { samples } = synthSpeech({ seconds: 14, seed });
    let sig = recolour(delayed(samples, ms(312)), SR, { cutoffHz: 1800, gainDb: -9 });
    sig = addNoise(sig, -50, seed + 100);
    const est = estimateDelay(samples, sig, SR);
    assert.ok(est, `seed ${seed}: expected an estimate`);
    assert.ok(Math.abs(est.lagMs - 312) <= 10, `seed ${seed}: got ${est.lagMs.toFixed(1)} ms`);
  }
});

test("delay near zero and slightly negative (second device ahead) are found", () => {
  const { samples } = synthSpeech({ seconds: 10, seed: 4 });
  const zero = estimateDelay(samples, samples, SR);
  assert.ok(Math.abs(zero.lagMs) <= 2, `got ${zero.lagMs}`);
  const ahead = estimateDelay(samples, delayed(samples, -ms(40)), SR);
  assert.ok(Math.abs(ahead.lagMs + 40) <= 5, `got ${ahead.lagMs}`);
});

test("no estimate when either side is silent", () => {
  const { samples } = synthSpeech({ seconds: 6, seed: 3 });
  assert.equal(estimateDelay(samples, new Float32Array(samples.length), SR), null);
  assert.equal(estimateDelay(new Float32Array(samples.length), samples, SR), null);
});

test("speech mask and utterances follow the synthetic sentences", () => {
  const { samples, utterances: truth } = synthSpeech({ seconds: 16, seed: 21 });
  const { db, hopMs } = envelopeDb(samples, SR);
  const segs = utterances(speechMask(db, hopMs), hopMs);
  assert.equal(segs.length, truth.length, `found ${segs.length}, made ${truth.length}`);
  segs.forEach((s, i) => {
    assert.ok(Math.abs((s.start * hopMs) / 1000 - truth[i].start) < 0.05, `utterance ${i} start`);
  });
});

test("analyzeRun: clean delayed copy has no gaps and a steady per-utterance delay", () => {
  const { samples } = synthSpeech({ seconds: 16, seed: 8 });
  const r = analyzeRun({ ref: samples, sig: recolour(delayed(samples, ms(250)), SR, { gainDb: -3 }), sampleRate: SR });
  assert.equal(r.ok, true);
  assert.equal(r.gapCount, 0, JSON.stringify(r.gaps));
  assert.ok(Math.abs(r.delayMs - 250) <= 6, `delay ${r.delayMs}`);
  assert.ok(Math.abs(r.delayMedianMs - 250) <= 8, `median ${r.delayMedianMs}`);
  assert.ok(r.utterances.length >= 6);
  assert.ok(r.levelDiffDb < -1, `level diff ${r.levelDiffDb}`);
});

test("analyzeRun: a delay that grows mid-run shows in the per-utterance p95", () => {
  const { samples, utterances: truth } = synthSpeech({ seconds: 20, seed: 13 });
  // Switch from 237 to 285 ms in the pause after the middle utterance.
  const mid = truth[Math.floor(truth.length / 2)];
  const switchAt = Math.round((mid.end + 0.3) * SR);
  const a = delayed(samples, ms(237));
  const b = delayed(samples, ms(285));
  const sig = new Float32Array(samples.length);
  sig.set(a.subarray(0, switchAt + ms(237)));
  sig.set(b.subarray(switchAt + ms(237)), switchAt + ms(237));
  const r = analyzeRun({ ref: samples, sig, sampleRate: SR });
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.delayMinMs - 237) <= 8, `min ${r.delayMinMs}`);
  assert.ok(Math.abs(r.delayMaxMs - 285) <= 8, `max ${r.delayMaxMs}`);
  assert.ok(r.delayP95Ms > 270, `p95 ${r.delayP95Ms}`);
});

test("findGaps: 300 ms of missing output inside speech is one gap; shared pauses are not", () => {
  const { samples, utterances: truth } = synthSpeech({ seconds: 16, seed: 31 });
  const lag = 240;
  const sig = delayed(samples, ms(lag));
  const long = truth.find((u) => u.end - u.start > 0.9);
  assert.ok(long, "need an utterance longer than 0.9 s");
  const cut = Math.round((long.start + 0.25) * SR) + ms(lag);
  sig.fill(0, cut, cut + ms(300));
  const A = envelopeDb(samples, SR);
  const B = envelopeDb(sig, SR);
  const gaps = findGaps(A.db, B.db, A.hopMs, lag);
  assert.equal(gaps.length, 1, JSON.stringify(gaps));
  assert.ok(Math.abs(gaps[0].silentMs - 300) <= 90, `silent ${gaps[0].silentMs}`);
  assert.ok(gaps[0].missingSpeechMs >= 100);
  assert.ok(Math.abs(gaps[0].atSec - (long.start + 0.25)) < 0.12, `at ${gaps[0].atSec}`);
});

test("findGaps: output that stops early is reported as a gap past the end", () => {
  const { samples } = synthSpeech({ seconds: 10, seed: 17, tailSec: 0.5 });
  const sig = delayed(samples, ms(200));
  sig.fill(0, Math.round(sig.length * 0.6));
  const A = envelopeDb(samples, SR);
  const B = envelopeDb(sig, SR);
  const gaps = findGaps(A.db, B.db, A.hopMs, 200);
  assert.ok(gaps.length >= 1);
  assert.ok(gaps.at(-1).missingSpeechMs > 500);
});

test("bandwidth tells phone band, wideband and full band apart", () => {
  const narrow = bandwidthHz(bandNoise(SR, 1.5, 3400), SR);
  const wide = bandwidthHz(bandNoise(SR, 1.5, 7000), SR);
  const full = bandwidthHz(bandNoise(SR, 1.5, 20000), SR);
  assert.ok(Math.abs(narrow - 3400) < 400, `narrow ${narrow}`);
  assert.ok(Math.abs(wide - 7000) < 400, `wide ${wide}`);
  assert.ok(full > 18000, `full ${full}`);
  assert.equal(bandwidthHz(new Float32Array(SR), SR), null);
});

test("analyzeRun: dropouts of 300 ms inside sentences are all found, and nothing else", () => {
  for (const seed of [3, 5, 8]) {
    const { samples, utterances: truth } = synthSpeech({ seconds: 20, seed });
    const sig = recolour(delayed(samples, ms(240)), SR, { gainDb: -3 });
    const rand = rng(seed);
    const drops = [];
    for (const u of truth) {
      if (u.end - u.start < 0.6) continue;
      const at = u.start + 0.15 + rand() * (u.end - u.start - 0.6);
      drops.push(at);
      sig.fill(0, Math.round(at * SR) + ms(240), Math.round(at * SR) + ms(240 + 300));
    }
    const r = analyzeRun({ ref: samples, sig, sampleRate: SR });
    assert.equal(r.gapCount, drops.length, `seed ${seed}: ${JSON.stringify(r.gaps)}`);
    for (const at of drops) {
      // The reported hole is the dropout, give or take a fading syllable at either side.
      const hit = r.gaps.some((g) => g.atSec > at - 0.1 && g.atSec + g.holeMs / 1000 < at + 0.4);
      assert.ok(hit, `seed ${seed}: no gap inside the dropout at ${at.toFixed(2)} s`);
    }
  }
});

test("analyzeRun: a short take in a noisy room: the zero padding does not turn the noise into speech", () => {
  const { samples, utterances: truth } = synthSpeech({ seconds: 12, seed: 41 });
  const ref = padded(addNoise(samples, -45, 5), SR); // room noise well within 40 dB of the voice
  // The converter removes the room noise (pauses go quiet) but keeps every word.
  const sig = padded(addNoise(recolour(delayed(samples, ms(280)), SR, { gainDb: -3 }), -85, 6), SR);
  const r = analyzeRun({ ref, sig, sampleRate: SR });
  assert.equal(r.ok, true);
  assert.equal(r.gapCount, 0, JSON.stringify(r.gaps));
  assert.equal(r.utterances.length, truth.length);
  assert.ok(r.speechSec < 0.9 * (samples.length / SR), `speech ${r.speechSec} s`);
});

test("analyzeRun: breaths the converter leaves out are not gaps and do not merge sentences", () => {
  const { samples, utterances: truth } = synthSpeech({ seconds: 20, seed: 23 });
  const peak = percentile(envelopeDb(samples, SR).db, 99.5);
  const withBreaths = Float32Array.from(samples);
  truth.forEach((u, k) => {
    const b = breathNoise(SR, 0.3, 100 + k);
    const gain = 10 ** ((peak - 30 - Math.max(...envelopeDb(b, SR).db)) / 20); // 30 dB under the voice
    const at = Math.round((u.start - 0.15) * SR) - b.length; // ends 150 ms before the sentence
    if (at < 0) return;
    for (let i = 0; i < b.length; i++) withBreaths[at + i] += gain * b[i];
  });
  const ref = padded(addNoise(withBreaths, -85, 3), SR); // a quiet room: the breaths stand out
  const sig = padded(recolour(delayed(samples, ms(300)), SR, { gainDb: -2 }), SR);
  const r = analyzeRun({ ref, sig, sampleRate: SR });
  assert.equal(r.gapCount, 0, JSON.stringify(r.gaps));
  // Same sentences as the take without breaths (each line keeps its own rating row).
  const plain = envelopeDb(padded(addNoise(samples, -85, 3), SR), SR);
  const expected = utterances(speechMask(plain.db, plain.hopMs), plain.hopMs);
  assert.ok(expected.length >= 8);
  assert.deepEqual(
    r.utterances.map((u) => u.startSec.toFixed(1)),
    expected.map((s) => ((s.start * plain.hopMs) / 1000).toFixed(1)),
  );
});

test("analyzeRun: sentences that come back late are late, not missing", () => {
  const { samples, utterances: truth } = synthSpeech({ seconds: 24, seed: 29 });
  assert.ok(truth.length >= 8);
  const base = 240;
  for (const extra of [250, 450]) {
    const sig = new Float32Array(samples.length + ms(1000));
    truth.forEach((u, k) => {
      const d = ms(base + (k >= 3 && k <= 5 ? extra : 0)); // a jitter buffer that grew for three sentences
      const a = Math.max(0, Math.round((u.start - 0.05) * SR));
      const b = Math.min(samples.length, Math.round((u.end + 0.05) * SR));
      for (let i = a; i < b; i++) sig[i + d] += samples[i];
    });
    const ref = new Float32Array(sig.length);
    ref.set(samples);
    const r = analyzeRun({ ref, sig, sampleRate: SR });
    assert.equal(r.gapCount, 0, `+${extra} ms: ${JSON.stringify(r.gaps)}`);
    assert.ok(Math.abs(r.delayMaxMs - (base + extra)) <= 10, `+${extra} ms: max ${r.delayMaxMs}`);
    assert.ok(Math.abs(r.delayMedianMs - base) <= 10, `+${extra} ms: median ${r.delayMedianMs}`);
  }
});

test("analyzeRun: a clipped sentence end is reported at its own length, where it happened", () => {
  const { samples, utterances: truth } = synthSpeech({ seconds: 16, seed: 31 });
  const lag = 240;
  const sig = delayed(samples, ms(lag));
  const u = truth.find((x, k) => k > 0 && x.end - x.start > 0.9);
  const from = u.end - 0.35;
  sig.fill(0, Math.round(from * SR) + ms(lag), Math.round(u.end * SR) + ms(lag));
  const r = analyzeRun({ ref: samples, sig, sampleRate: SR });
  assert.equal(r.gapCount, 1, JSON.stringify(r.gaps));
  assert.ok(r.longestGapMs >= 150 && r.longestGapMs <= 380, `longest ${r.longestGapMs} (the pause after it is not part of it)`);
  assert.ok(Math.abs(r.gaps[0].atSec - from) < 0.15, `at ${r.gaps[0].atSec} vs ${from}`);
});

test("findGaps: a click inside a hole does not hide it", () => {
  const { samples, utterances: truth } = synthSpeech({ seconds: 16, seed: 31 });
  const lag = 240;
  const sig = delayed(samples, ms(lag));
  const long = truth.find((u) => u.end - u.start > 0.9);
  const cut = Math.round((long.start + 0.25) * SR) + ms(lag);
  sig.fill(0, cut, cut + ms(300));
  for (let i = 0; i < ms(4); i++) sig[cut + ms(150) + i] = i % 2 ? 0.5 : -0.5;
  const A = envelopeDb(samples, SR);
  const B = envelopeDb(sig, SR);
  assert.equal(findGaps(A.db, B.db, A.hopMs, lag).length, 1);
});

test("analyzeRun reports why when nothing came back", () => {
  const { samples } = synthSpeech({ seconds: 6, seed: 3 });
  const r = analyzeRun({ ref: samples, sig: new Float32Array(samples.length), sampleRate: SR });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no converted audio/);
});

test("analyzeRun: a sentence cut off by the end of the recording gets no wrong delay and no false gap inside it", () => {
  // Speech right up to the end (someone still talking at Stop): the converted
  // copy of the last sentence runs past the end of the recording.
  for (const seed of [3, 5, 8]) {
    const sr = 48000;
    const { samples: ref } = synthSpeech({ sampleRate: sr, seconds: 9, seed, leadSec: 0.4, tailSec: 0 });
    const sig = delayed(ref, Math.round(0.25 * sr));
    const r = analyzeRun({ ref, sig, sampleRate: sr });
    assert.ok(r.ok);
    for (const u of r.utterances.filter((u) => u.trusted)) {
      assert.ok(Math.abs(u.lagMs - 250) <= 20, `seed ${seed}: trusted sentence at ${u.startSec} s has ${u.lagMs} ms`);
    }
    const inside = r.gaps.filter((g) => !g.pastEnd);
    assert.deepEqual(inside, [], `seed ${seed}: ${JSON.stringify(r.gaps)}`);
  }
});
