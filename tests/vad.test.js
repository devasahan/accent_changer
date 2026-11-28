import test from "node:test";
import assert from "node:assert/strict";
import { SpeechPeak, Vad, frameLevelsDb } from "../src/core/vad.js";
import { envelopeDb } from "../src/core/delay-estimate.js";
import { breathNoise, rng, synthSpeech } from "./helpers/synth.js";

const SR = 48000;
const FRAME = 480; // 10 ms
const ms = (x) => Math.round((x * SR) / 1000);

const cache = new Map();
function speech(seed, seconds = 16) {
  const key = `${seed}/${seconds}`;
  if (!cache.has(key)) cache.set(key, synthSpeech({ seconds, seed }));
  return cache.get(key);
}

/** Steady noise with the given RMS level (dBFS); near-Gaussian, deterministic. */
function noise(n, rmsDb, seed) {
  const rand = rng(seed);
  const amp = 10 ** (rmsDb / 20) * Math.SQRT2; // a sum of 6 uniforms has variance 1/2
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let u = -3;
    for (let k = 0; k < 6; k++) u += rand();
    out[i] = amp * u;
  }
  return out;
}

function mix(a, b) {
  return a.map((v, i) => v + (b[i] ?? 0));
}

/**
 * Push `x` in blocks; returns the speaking segments ({ on, off } in seconds,
 * at the end of the block where `speaking` changed; off is null if still on).
 */
function segments(x, { block = 96, vad = new Vad() } = {}) {
  const segs = [];
  let on = null;
  for (let i = 0; i < x.length; i += block) {
    const end = Math.min(x.length, i + block);
    vad.push(x.subarray(i, end));
    if (vad.speaking && on === null) on = end / SR;
    if (!vad.speaking && on !== null) {
      segs.push({ on, off: end / SR });
      on = null;
    }
  }
  if (on !== null) segs.push({ on, off: null });
  return { segs, vad };
}

test("frameLevelsDb: one level per whole 10 ms frame, the same numbers as envelopeDb", () => {
  const { samples } = speech(2, 4);
  const x = samples.subarray(0, samples.length - 100); // the partial frame at the end is left out
  const levels = frameLevelsDb(x, SR, 10);
  const env = envelopeDb(x, SR, { hopMs: 10, winMs: 10 }).db;
  assert.equal(levels.length, Math.floor(x.length / FRAME));
  assert.equal(levels.length, env.length);
  for (let i = 0; i < levels.length; i++) assert.ok(Math.abs(levels[i] - env[i]) < 1e-4, `frame ${i}`);
  const sine = Float32Array.from({ length: 4800 }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / SR));
  for (const v of frameLevelsDb(sine, SR, 10)) assert.ok(Math.abs(v + 3.01) < 0.05, `full-scale sine ${v}`);
  assert.ok(frameLevelsDb(new Float32Array(960), SR, 10).every((v) => v === -120));
  assert.equal(frameLevelsDb(new Float32Array(400), SR, 10).length, 0);
});

test("the Vad sees the same frames whatever the block size", () => {
  const { samples } = speech(4);
  const ref = frameLevelsDb(samples, SR, 10);
  const trace = (block) => {
    const vad = new Vad();
    const out = [];
    let frames = 0;
    for (let i = 0; i < samples.length; i += block) {
      vad.push(samples.subarray(i, i + block));
      const done = Math.floor(Math.min(samples.length, i + block) / FRAME);
      if (done > frames) {
        frames = done;
        assert.equal(Math.fround(vad.levelDb), ref[done - 1], `block ${block}: level of frame ${done - 1}`);
        out.push(`${done}:${vad.speaking ? 1 : 0}`);
      }
    }
    return out;
  };
  const a = trace(128);
  assert.ok(a.length > 1000);
  assert.deepEqual(trace(480), a);
  assert.deepEqual(trace(7), a);
  assert.deepEqual(trace(160), a);
});

test("utterances of synthSpeech: on within attack + frame of the start, off within hangMs + frame of the end", () => {
  const attack = 0.03 + 0.01;
  const hang = 0.3 + 0.01;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const { samples, utterances } = speech(seed);
    const { segs } = segments(samples, { block: 96 }); // 96 divides a frame: the state is seen as it changes
    assert.equal(segs.length, utterances.length, `seed ${seed}: ${segs.length} segments for ${utterances.length} utterances`);
    utterances.forEach((u, i) => {
      const s = segs[i];
      assert.ok(Math.abs(s.on - u.start) <= attack + 1e-9, `seed ${seed} utterance ${i}: on ${s.on.toFixed(3)} vs start ${u.start.toFixed(3)}`);
      assert.ok(s.off !== null, `seed ${seed} utterance ${i}: still speaking at the end`);
      assert.ok(Math.abs(s.off - u.end) <= hang + 1e-9, `seed ${seed} utterance ${i}: off ${s.off.toFixed(3)} vs end ${u.end.toFixed(3)}`);
    });
  }
});

test("pauseMs: Infinity before any speech, 0 while speaking (hangover included), then the time since the last speech frame", () => {
  const { samples, utterances } = speech(3);
  const vad = new Vad();
  const first = utterances[0];
  const block = 96;
  let lastOn = null;
  let sawPause = false;
  for (let i = 0; i < samples.length; i += block) {
    vad.push(samples.subarray(i, i + block));
    const t = (i + block) / SR;
    if (t < first.start) assert.equal(vad.pauseMs, Infinity);
    if (vad.speaking) {
      assert.equal(vad.pauseMs, 0);
      lastOn = t;
    } else if (lastOn !== null) {
      // Not speaking any more: the pause is counted from the last speech frame, so it is at
      // least the hangover and grows with the samples pushed.
      assert.ok(vad.pauseMs >= 300 - 1e-9, `pause ${vad.pauseMs} at ${t}`);
      assert.ok(Math.abs(vad.pauseMs - ((t - lastOn) * 1000 + 300)) <= 10 + 1e-9, `pause ${vad.pauseMs} at ${t}`);
      sawPause = true;
    }
  }
  assert.ok(sawPause);
});

test("steady noise at -45 dBFS is never speech, and the floor settles on it", () => {
  for (const seed of [1, 2]) {
    const { segs, vad } = segments(noise(ms(10000), -45, seed), { block: 128 });
    assert.equal(segs.length, 0, `seed ${seed}: ${JSON.stringify(segs)}`);
    assert.ok(Math.abs(vad.floorDb + 45) < 1.5, `floor ${vad.floorDb}`);
  }
  // The same after digital silence (a mic that starts late): the floor starts at the first sound.
  const late = new Float32Array(ms(12000));
  late.set(noise(ms(10000), -45, 3), ms(2000));
  assert.equal(segments(late, { block: 128 }).segs.length, 0);
});

test("speech over -45 dBFS room noise is still found, one segment per utterance", () => {
  for (const seed of [1, 2, 3, 4]) {
    const { samples, utterances } = speech(seed);
    const { segs, vad } = segments(mix(samples, noise(samples.length, -45, 100 + seed)));
    assert.equal(segs.length, utterances.length, `seed ${seed}`);
    utterances.forEach((u, i) => {
      // Noise hides the softest start of a syllable: allow two more frames than in a quiet room.
      assert.ok(Math.abs(segs[i].on - u.start) <= 0.06, `seed ${seed} utterance ${i}: on ${segs[i].on} vs ${u.start}`);
      assert.ok(Math.abs(segs[i].off - u.end) <= 0.31, `seed ${seed} utterance ${i}: off ${segs[i].off} vs ${u.end}`);
    });
    assert.ok(Math.abs(vad.floorDb + 45) < 2, `seed ${seed}: floor ${vad.floorDb}`);
  }
});

test("breaths between utterances are not speech (30 dB under the voice)", () => {
  let breathFrames = 0;
  let speechInBreath = 0;
  for (const seed of [1, 2, 3, 4]) {
    const { samples, utterances } = speech(seed);
    const x = Float32Array.from(samples);
    const breaths = [];
    utterances.forEach((u, k) => {
      const next = utterances[k + 1];
      // A breath 350 ms after the sentence (the hangover is over) that ends 150 ms before the next one.
      const from = Math.round((u.end + 0.35) * SR);
      const to = next ? Math.round((next.start - 0.15) * SR) : x.length - ms(200);
      if (to - from < ms(250)) return;
      const b = breathNoise(SR, (to - from) / SR, 50 + k);
      const gain = 10 ** (-40 / 20); // peak -40 dBFS: about -49 dB per frame, 30 dB under the vowels
      for (let i = 0; i < b.length; i++) x[from + i] += gain * b[i];
      breaths.push([from, from + b.length]);
    });
    assert.ok(breaths.length >= 2, `seed ${seed}: ${breaths.length} breaths`);
    const vad = new Vad();
    let i = 0;
    for (; i + FRAME <= x.length; i += FRAME) {
      vad.push(x.subarray(i, i + FRAME));
      if (breaths.some(([a, b]) => i >= a && i + FRAME <= b)) {
        breathFrames++;
        if (vad.speaking) speechInBreath++;
      }
    }
    // The sentences are still found as before.
    assert.equal(segments(x).segs.length, utterances.length, `seed ${seed}`);
  }
  assert.ok(breathFrames > 300);
  assert.ok(speechInBreath / breathFrames < 0.2, `${speechInBreath} of ${breathFrames} breath frames counted as speech`);
});

test("the speech peak holds through a long silence: a breath after 20 s of listening is still not speech", () => {
  const { samples } = speech(5, 6);
  const quietRoom = noise(ms(20000), -80, 9);
  const breath = breathNoise(SR, 0.5, 9).map((v) => v * 10 ** (-40 / 20));
  const x = new Float32Array(samples.length + quietRoom.length + breath.length + ms(500));
  x.set(samples);
  x.set(quietRoom, samples.length);
  x.set(breath, samples.length + quietRoom.length);
  const vad = new Vad();
  vad.push(x.subarray(0, samples.length + quietRoom.length));
  const peak = vad.peakDb;
  assert.ok(peak > -21, `peak ${peak}`);
  assert.equal(vad.speaking, false);
  for (let i = samples.length + quietRoom.length; i < x.length; i += 128) {
    vad.push(x.subarray(i, i + 128));
    assert.equal(vad.speaking, false, `breath counted as speech at ${(i / SR).toFixed(2)} s`);
  }
  assert.ok(vad.pauseMs > 20000);
});

test("a voice that drops 30 dB is not ignored for good: the peak sinks while there is sound", () => {
  // A mic boom flipped up: at first the voice is 30 dB under the old peak (not speech), but
  // the peak holds 2 s and then sinks 3 dB/s while there is sound, so the voice is found again.
  const { samples, utterances } = speech(6);
  const soft = samples.map((v) => v * 10 ** (-30 / 20));
  const x = new Float32Array(samples.length * 2);
  x.set(samples);
  x.set(soft, samples.length);
  const { segs } = segments(x);
  const offset = samples.length / SR;
  const later = utterances.filter((u) => u.start > 12.5);
  assert.ok(later.length >= 1);
  for (const u of later) {
    const [a, b] = [u.start + offset, u.end + offset];
    assert.ok(
      segs.some((s) => s.on < b && (s.off === null || s.off > a)),
      `soft utterance at ${a.toFixed(2)} s not found: ${JSON.stringify(segs.map((s) => s.on.toFixed(2)))}`,
    );
  }
  // ... and not right away: just after the drop the soft voice is under the old peak's range.
  const first = utterances[0].start + offset;
  assert.ok(!segs.some((s) => s.on > first - 0.05 && s.on < first + 1), "the soft voice passed at once");
});

test("a cough does not make the next sentences too quiet to be speech: the peak follows the voice, not the loudest sound", () => {
  // A speech peak that jumped to the cough and held there would put most of the voice more
  // than 25 dB under it for seconds: whole sentences after the cough would be missed.
  const attack = 0.03 + 0.01;
  const hang = 0.3 + 0.01;
  for (const seed of [1, 2, 3, 4]) {
    const { samples, utterances } = speech(seed);
    for (const [voiceDb, coughDb] of [
      [-12, -6], // a quiet speaker (vowels near -31 dBFS) coughs 25 dB louder than they speak
      [0, -3], // 100 ms at -3 dBFS: 15 dB over the vowels
    ]) {
      const x = samples.map((v) => v * 10 ** (voiceDb / 20));
      const cough = noise(ms(100), coughDb, seed);
      const at = Math.round((utterances[2].start + 0.2) * SR); // in the middle of the third sentence
      for (let i = 0; i < cough.length; i++) x[at + i] += cough[i];
      const { segs, vad } = segments(x);
      const what = `seed ${seed}, voice ${voiceDb} dB, cough ${coughDb} dBFS`;
      assert.equal(segs.length, utterances.length, `${what}: ${segs.length} segments`);
      utterances.slice(3).forEach((u, k) => {
        const s = segs[k + 3];
        assert.ok(Math.abs(s.on - u.start) <= attack + 1e-9, `${what}: sentence ${k + 3} on at ${s.on.toFixed(3)} s, starts ${u.start.toFixed(3)} s`);
        assert.ok(s.off !== null && Math.abs(s.off - u.end) <= hang + 1e-9, `${what}: sentence ${k + 3} off at ${s.off} s, ends ${u.end.toFixed(3)} s`);
      });
      const voicePeak = Math.max(...frameLevelsDb(samples, SR, 10)) + voiceDb;
      assert.ok(vad.peakDb <= voicePeak + 4, `${what}: peak ${vad.peakDb.toFixed(1)} dB, the voice's ${voicePeak.toFixed(1)}`);
    }
  }
});

test("SpeechPeak: at most capDb over the level the loudest fifth of recent speech reaches; follows a voice that gets louder or quieter", () => {
  const p = new SpeechPeak(); // 10 ms frames, 2 s hold, 3 dB/s decay, 2.5 s window, loudest fifth + 4 dB
  assert.equal(p.db, -Infinity);
  const voice = (i, gain = 0) => gain - 20 - 8 * Math.abs(Math.sin(i * 0.37)); // syllables: -28..-20 dB
  let i = 0;
  for (; i < 300; i++) p.push(voice(i), true);
  assert.ok(p.db <= -20 && p.db > -21, `voice peak ${p.db}`); // the loudest recent frame, held then sinking
  // A cough, a click, one shouted word: 3, 10 and 30 frames 15-25 dB over the voice.
  for (const [n, level] of [
    [3, 0],
    [10, -5],
    [30, -8],
  ]) {
    for (let k = 0; k < n; k++) p.push(level, true);
    assert.ok(p.db <= -20 + 4 + 0.5, `after ${n} frames at ${level} dB: peak ${p.db}`);
    for (let k = 0; k < 100; k++, i++) p.push(voice(i), true);
  }
  // Frames that are not speech let time pass but never raise it.
  for (let k = 0; k < 50; k++) p.push(-3, false);
  assert.ok(p.db <= -15.5, `after loud non-speech: ${p.db}`);
  // The voice gets 10 dB louder for good: within a fifth of the window (0.5 s).
  for (let k = 0; k < 60; k++, i++) p.push(voice(i, 10), true);
  assert.ok(Math.abs(p.db + 10) < 0.5, `louder voice: ${p.db}`);
  // ... and 20 dB quieter: down to it within the window (2.5 s).
  for (let k = 0; k < 250; k++, i++) p.push(voice(i, -20), true);
  assert.ok(p.db <= -40 + 4 + 0.5, `quieter voice: ${p.db}`);
  p.reset();
  assert.equal(p.db, -Infinity);
});

test("attack: a 15 ms click is not speech, a 35 ms burst is", () => {
  const burst = (lenMs) => {
    const x = new Float32Array(ms(1000));
    x.set(noise(ms(lenMs), -20, 4), ms(500)); // starts on a frame boundary
    return segments(x, { block: 128 }).segs.length;
  };
  assert.equal(burst(15), 0);
  assert.equal(burst(35), 1);
});

test("floorDb: never below -100, ignores digital silence, falls at once and rises about 3 dB/s", () => {
  const vad = new Vad();
  assert.equal(vad.floorDb, -100);
  vad.push(new Float32Array(ms(1000)));
  assert.equal(vad.floorDb, -100); // nothing heard yet
  vad.push(noise(ms(500), -70, 2)); // the first sound sets it
  const at70 = vad.floorDb;
  assert.ok(Math.abs(at70 + 70) < 1.5, `floor ${at70}`);
  vad.push(new Float32Array(ms(500))); // a dropout: the room is still there
  assert.equal(vad.floorDb, at70);
  vad.push(noise(ms(2000), -50, 3)); // a louder room: about +3 dB/s
  const rise = vad.floorDb - at70;
  assert.ok(rise > 4.5 && rise < 7.5, `rose ${rise.toFixed(2)} dB in 2 s`);
  vad.push(noise(ms(30), -75, 4)); // a quieter one: at once
  assert.ok(Math.abs(vad.floorDb + 75) < 1.5, `fell to ${vad.floorDb}`);
  vad.push(noise(ms(500), -115, 5));
  assert.equal(vad.floorDb, -100);
});

test("a NaN from the mic does not poison the detector", () => {
  const { samples, utterances } = speech(7);
  const x = Float32Array.from(samples);
  x[ms(100)] = NaN;
  x[Math.round(utterances[2].start * SR) + 500] = NaN;
  const { segs, vad } = segments(x);
  assert.equal(segs.length, utterances.length);
  assert.ok(Number.isFinite(vad.floorDb) && Number.isFinite(vad.peakDb) && Number.isFinite(vad.levelDb));
});

test("reset() forgets everything", () => {
  const { samples } = speech(8, 4);
  const vad = new Vad();
  for (let i = 0; !vad.speaking; i += 128) vad.push(samples.subarray(i, i + 128));
  assert.ok(vad.peakDb > -30);
  vad.reset();
  assert.equal(vad.speaking, false);
  assert.equal(vad.pauseMs, Infinity);
  assert.equal(vad.levelDb, -120);
  assert.equal(vad.floorDb, -100);
  assert.equal(vad.peakDb, -Infinity);
});
