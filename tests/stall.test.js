import test from "node:test";
import assert from "node:assert/strict";
import { StallDetector } from "../src/core/stall.js";
import { Vad, frameLevelsDb } from "../src/core/vad.js";
import { breathNoise, delayed, recolour, rng, synthSpeech } from "./helpers/synth.js";

const SR = 48000;
const BLOCK = 128; // one AudioWorklet render quantum
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
  const out = new Float32Array(Math.max(0, n));
  for (let i = 0; i < out.length; i++) {
    let u = -3;
    for (let k = 0; k < 6; k++) u += rand();
    out[i] = amp * u;
  }
  return out;
}

/** A converted voice: the original `delayMs` later, a different colour (one-pole low-pass) and -6 dB. */
function converted(samples, delayMs, { gainDb = -6, cutoffHz = 2500 } = {}) {
  return recolour(delayed(samples, ms(delayMs)), SR, { gainDb, cutoffHz });
}

/**
 * The mixer's view, block by block: the Vad on the original gives the speech
 * flag. Times are sample counts at the end of the block where it happened.
 */
function run(orig, conv, delayMs, { block = BLOCK, until = orig.length, options, onBlock } = {}) {
  const vad = new Vad();
  const stall = new StallDetector(options);
  let firedAt = null;
  let badAt = null;
  let maxMissMs = 0;
  for (let i = 0; i < until; i += block) {
    const end = Math.min(until, i + block);
    const o = orig.subarray(i, end);
    const c = conv.subarray(i, end);
    vad.push(o);
    stall.push(o, c, typeof delayMs === "function" ? delayMs(i) : delayMs, vad.speaking);
    if (!stall.stalled && stall.missMs > maxMissMs) maxMissMs = stall.missMs;
    if (stall.stalled && firedAt === null) firedAt = end;
    if (stall.badOutput && badAt === null) badAt = end;
    onBlock?.(stall, end, vad);
  }
  return { stall, firedAt, badAt, maxMissMs };
}

/**
 * Speech frames of the original, independent of the detector: 10 ms frames
 * within 25 dB of the recording's peak (the Vad's rule), above -55 dBFS.
 */
function speechFrames(samples) {
  const levels = frameLevelsDb(samples, SR, 10);
  let peak = -Infinity;
  for (const v of levels) peak = Math.max(peak, v);
  return Uint8Array.from(levels, (v) => (v >= peak - 25 && v >= -55 ? 1 : 0));
}

/** Ms of original speech between content samples [from, to), in whole speech frames (a frame counts where its middle is). */
function speechMs(isSpeech, from, to) {
  let n = 0;
  for (let j = 0; j < isSpeech.length; j++) {
    const mid = (j + 0.5) * FRAME;
    if (mid >= from && mid < to && isSpeech[j]) n++;
  }
  return n * 10;
}

/**
 * Places where a stall cuts into continuous speech: inside a vowel (±30 ms
 * within 6 dB of the peak), at least 700 ms before the end of its sentence,
 * not in the first sentence. One per sentence, at a random sample.
 */
function stallPoints(samples, utterances, rand, count, levels = frameLevelsDb(samples, SR, 10)) {
  let peak = -Infinity;
  for (const v of levels) peak = Math.max(peak, v);
  const points = [];
  for (const u of utterances.slice(1)) {
    const options = [];
    for (let j = Math.ceil(u.start * 100) + 3; j < Math.floor((u.end - 0.7) * 100); j++) {
      let vowel = true;
      for (let t = -3; t <= 3; t++) if (levels[j + t] < peak - 6) vowel = false;
      if (vowel) options.push(j);
    }
    if (options.length) points.push(options[Math.floor(rand() * options.length)] * FRAME + Math.floor(rand() * FRAME));
    if (points.length === count) break;
  }
  return points;
}

/** What a jitter buffer plays when packets stop at `at`: the last 20 ms again and again, fading 3 dB per 10 ms for 80 ms, then noise at -50 dBFS. */
function conceal(conv, at, seed) {
  const period = ms(20);
  const last = conv.slice(at - period, at);
  const fadeEnd = Math.min(conv.length, at + ms(80));
  for (let i = at; i < fadeEnd; i++) conv[i] = last[(i - at) % period] * 10 ** ((-3 * (i - at)) / FRAME / 20);
  conv.set(noise(conv.length - fadeEnd, -50, seed), fadeEnd);
}

/** Adds `x` into `into` from sample `at` on (in place). */
function addAt(into, x, at) {
  for (let i = 0; i < x.length && at + i < into.length; i++) into[at + i] += x[i];
}

const DELAYS = [0, 120, 250, 300, 333, 450, 600];

test("digital silence from mid-sentence: fires after 350-450 ms of the user's speech; stallStartSample within ±20 ms, never late", () => {
  let cases = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const { samples, utterances } = speech(seed);
    const isSpeech = speechFrames(samples);
    const levels = frameLevelsDb(samples, SR, 10);
    const rand = rng(100 + seed);
    DELAYS.forEach((D, n) => {
      for (const at of stallPoints(samples, utterances, rand, 2, levels)) {
        const Ds = ms(D);
        const orig = samples.subarray(0, Math.min(samples.length, at + Ds + ms(2000)));
        const conv = n % 2 ? converted(orig, D) : delayed(orig, Ds);
        conv.fill(0, at + Ds); // the stream stops: content from `at` on never comes back
        const { stall, firedAt } = run(orig, conv, D);
        const what = `seed ${seed}, D ${D} ms, stall at ${(at / SR).toFixed(3)} s`;
        assert.ok(firedAt !== null, `${what}: no stall`);
        assert.ok(firedAt > at + Ds, `${what}: fired before the stall`);
        // The user's speech that was due in the converted stream by the time it fired.
        const lost = speechMs(isSpeech, at, firedAt - Ds);
        assert.ok(lost >= 350 && lost <= 450, `${what}: fired after ${lost} ms of speech`);
        const errMs = ((stall.stallStartSample - at) * 1000) / SR;
        assert.ok(errMs >= -20 && errMs <= 0, `${what}: stallStartSample off by ${errMs.toFixed(1)} ms`);
        cases++;
      }
    });
  }
  assert.ok(cases >= 60, `${cases} cases`);
});

test("concealment-like stall (last 20 ms repeated and fading, then noise at -50 dBFS): fires within 350-500 ms of speech", () => {
  let cases = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const { samples, utterances } = speech(seed);
    const isSpeech = speechFrames(samples);
    const levels = frameLevelsDb(samples, SR, 10);
    const rand = rng(200 + seed);
    DELAYS.forEach((D, n) => {
      for (const at of stallPoints(samples, utterances, rand, 2, levels)) {
        const Ds = ms(D);
        const orig = samples.subarray(0, Math.min(samples.length, at + Ds + ms(2000)));
        const conv = n % 2 ? delayed(orig, Ds) : converted(orig, D);
        conceal(conv, at + Ds, seed + D);
        const { stall, firedAt } = run(orig, conv, D);
        const what = `seed ${seed}, D ${D} ms, stall at ${(at / SR).toFixed(3)} s`;
        assert.ok(firedAt !== null, `${what}: no stall`);
        const lost = speechMs(isSpeech, at, firedAt - Ds);
        assert.ok(lost >= 350 && lost <= 500, `${what}: fired after ${lost} ms of speech`);
        // The concealment carries the voice's level for a frame or two, so the start can be a little late.
        const errMs = ((stall.stallStartSample - at) * 1000) / SR;
        assert.ok(errMs >= -20 && errMs <= 60, `${what}: stallStartSample off by ${errMs.toFixed(1)} ms`);
        cases++;
      }
    });
  }
  assert.ok(cases >= 60, `${cases} cases`);
});

test("a cough, a click or one loud word during speech does not blind it: a stall 600 ms later still fires after 350-450 ms of speech", () => {
  // A speech peak that jumped to the transient and held there would leave every ordinary
  // voice frame more than speechRangeDb under it for seconds: nothing decided, no stall.
  let cases = 0;
  for (const seed of [1, 2, 3, 4]) {
    const { samples, utterances } = speech(seed);
    const isSpeech = speechFrames(samples);
    const levels = frameLevelsDb(samples, SR, 10);
    let voicePeak = -Infinity;
    for (const v of levels) voicePeak = Math.max(voicePeak, v);
    const rand = rng(400 + seed);
    for (const D of [250, 400]) {
      const [at] = stallPoints(samples, utterances, rand, 1, levels);
      for (const kind of ["cough", "click", "loud word"]) {
        const orig = Float32Array.from(samples.subarray(0, at + ms(D) + ms(2000)));
        if (kind === "cough") addAt(orig, noise(ms(100), -3, seed), at - ms(600)); // 100 ms at -3 dBFS RMS: 15 dB over the vowels
        else if (kind === "click") addAt(orig, noise(ms(30), -8, seed), at - ms(600)); // a mic bump, a plosive pop
        else for (let i = at - ms(900); i < at - ms(600); i++) orig[i] *= 4; // a word said 12 dB louder
        const conv = converted(orig, D); // the converter passes it on too
        conv.fill(0, at + ms(D));
        const { stall, firedAt } = run(orig, conv, D);
        const what = `${kind}, seed ${seed}, D ${D} ms`;
        assert.ok(firedAt !== null, `${what}: no stall`);
        const lost = speechMs(isSpeech, at, firedAt - ms(D));
        assert.ok(lost >= 350 && lost <= 450, `${what}: fired after ${lost} ms of speech`);
        const errMs = ((stall.stallStartSample - at) * 1000) / SR;
        assert.ok(errMs >= -20 && errMs <= 0, `${what}: stallStartSample off by ${errMs.toFixed(1)} ms`);
        assert.ok(stall.speechPeakDb <= voicePeak + 4, `${what}: speech peak ${stall.speechPeakDb.toFixed(1)} dB, the voice's ${voicePeak.toFixed(1)}`);
        cases++;
      }
    }
  }
  assert.equal(cases, 24);
});

test("steady noise that starts while the user listens or talks never counts as missing speech: a fan, an unmute, a noise step", () => {
  // The Vad's floor climbs 3 dB/s, so for seconds it takes new steady noise for speech, and
  // the converter returns the voice only. Noise does not rise and fall with syllables, so it
  // decides nothing, and the speech peak does not sink to its level.
  const D = 300;
  const { samples } = speech(1);
  const end = ms(8000); // the user talks for 8 s ...
  const total = end + ms(13000); // ... then listens
  const voice = new Float32Array(total);
  voice.set(samples.subarray(0, end));
  const bed = noise(total, 0, 51); // 0 dBFS RMS, scaled below
  const scaled = (db, from = 0, fadeMs = 0) => {
    const g = 10 ** (db / 20);
    const out = new Float32Array(total);
    for (let i = from; i < total; i++) out[i] = g * bed[i] * Math.min(1, (i - from) / Math.max(1, ms(fadeMs)));
    return out;
  };
  const room = scaled(-65);
  const scenes = {
    // Listening: a fan at -40 dBFS spins up 1 s after the user stopped talking.
    fan: () => {
      const fan = scaled(-40, end + ms(1000), 300);
      return voice.map((v, i) => v + room[i] + fan[i]);
    },
    // Listening: the headset is muted (hiss at -90 dBFS) for 2 s, then unmuted into a -50 dBFS room.
    unmute: () => {
      const hiss = scaled(-90);
      const loud = scaled(-50);
      const muteFrom = end + ms(500);
      return voice.map((v, i) => (i < muteFrom ? v + room[i] : i < muteFrom + ms(2000) ? hiss[i] : loud[i]));
    },
    // Talking: an air conditioner at -30 dBFS (11 dB under the vowels) comes on mid-speech.
    step: () => {
      const ac = scaled(-30, ms(3000), 200);
      return voice.map((v, i) => v + room[i] + ac[i]);
    },
  };
  const conv = converted(voice, D);
  for (const [name, make] of Object.entries(scenes)) {
    const r = run(make(), conv, D);
    assert.equal(r.firedAt, null, `${name}: a stall`);
    assert.ok(r.maxMissMs <= 60, `${name}: a miss run of ${r.maxMissMs} ms`);
    assert.equal(r.badAt, null, `${name}: bad output`);
    assert.ok(r.stall.speechPeakDb > -24, `${name}: the speech peak sank to ${r.stall.speechPeakDb.toFixed(1)} dB`);
  }
});

test("a converted stream that keeps losing pieces is a stall, counted from its first hole; it earns no health", () => {
  // Sustained underruns (every other 128-sample block), 40 ms on / 40 ms off, 20 on / 60 off:
  // each ±tol span still holds a voice-level frame, but where the voice is due half or more
  // of it is gone.
  let cases = 0;
  for (const [on, off] of [
    [128, 128],
    [ms(40), ms(40)],
    [ms(20), ms(60)],
  ]) {
    for (const seed of [1, 2, 3, 4]) {
      const { samples, utterances } = speech(seed);
      const isSpeech = speechFrames(samples);
      const levels = frameLevelsDb(samples, SR, 10);
      const rand = rng(500 + seed);
      for (const D of seed % 2 ? [250] : [400]) {
        const [at] = stallPoints(samples, utterances, rand, 1, levels);
        const conv = converted(samples, D);
        for (let t = at + ms(D); t < conv.length; t += on + off) conv.fill(0, t + on, t + on + off);
        let choppyAt = null;
        const until = Math.min(samples.length, at + ms(D) + ms(2500));
        const { stall, firedAt } = run(samples, conv, D, { until, onBlock: (s, e) => choppyAt === null && s.choppy && (choppyAt = e) });
        const what = `${on}/${off} samples, seed ${seed}, D ${D}`;
        assert.ok(firedAt !== null, `${what}: no stall`);
        assert.ok(choppyAt !== null && choppyAt <= firedAt, `${what}: not seen as choppy`);
        // The meeting hears the garbled voice for at most about a second of speech.
        const lost = speechMs(isSpeech, at, firedAt - ms(D));
        assert.ok(lost <= 1200, `${what}: fired after ${lost} ms of speech`);
        // The replay point is where the losses began: the first hole that took away speech
        // (a hole can fall between two syllables). Early rather than late, and late by no more
        // than the mixer's replay margin (70 ms).
        let first = null;
        for (let t = at + ms(D); first === null; t += on + off) {
          for (let a = t + on; a < t + on + off; a++) {
            if (isSpeech[Math.floor((a - ms(D)) / FRAME)]) {
              first = a - ms(D);
              break;
            }
          }
        }
        const errMs = ((stall.stallStartSample - first) * 1000) / SR;
        assert.ok(errMs >= -60 && errMs <= 70, `${what}: stallStartSample ${errMs.toFixed(1)} ms from the first speech lost`);
        cases++;
      }
    }
  }
  assert.equal(cases, 12);

  // From the start of the stream (the engine's clock crossing underruns all the time): never
  // 3 s of health, so the mixer would never switch to it.
  for (const seed of [1]) {
    const { samples } = speech(seed);
    const conv = converted(samples, 300);
    for (let t = 0; t < conv.length; t += 256) conv.fill(0, t + 128, t + 256);
    let maxHealthy = 0;
    run(samples, conv, 300, { onBlock: (s) => (maxHealthy = Math.max(maxHealthy, s.healthyMs)) });
    assert.ok(maxHealthy < 1000, `seed ${seed}: ${maxHealthy} ms of health`);
  }
});

test("a stall that starts in a pause fires during the next sentence, and the replay point is before that sentence", () => {
  for (const seed of [1, 2, 3]) {
    const { samples, utterances } = speech(seed);
    const isSpeech = speechFrames(samples);
    for (const D of [250, 450]) {
      const Ds = ms(D);
      const k = 3;
      const at = Math.round(((utterances[k - 1].end + utterances[k].start) / 2) * SR); // mid-pause
      const conv = converted(samples, D);
      conv.fill(0, at + Ds);
      const { stall, firedAt } = run(samples, conv, D);
      const next = Math.round(utterances[k].start * SR);
      assert.ok(firedAt !== null, `seed ${seed} D ${D}: no stall`);
      const lost = speechMs(isSpeech, next, firedAt - Ds);
      assert.ok(lost >= 350 && lost <= 450, `seed ${seed} D ${D}: fired after ${lost} ms of speech`);
      assert.ok(stall.stallStartSample <= next, `seed ${seed} D ${D}: the replay would start after the sentence did`);
      assert.ok(stall.stallStartSample >= Math.round(utterances[k - 1].end * SR) - ms(300), `seed ${seed} D ${D}: replay point far too early`);
    }
  }
});

test("never fires at the start of sentences when D is right (D 0, 120, 300, 450, 600 ms): not one missing frame", () => {
  for (const seed of [1, 2, 3, 4]) {
    const { samples } = speech(seed);
    for (const D of [0, 120, 300, 450, 600]) {
      const r = run(samples, delayed(samples, ms(D)), D);
      assert.equal(r.firedAt, null, `seed ${seed} D ${D}`);
      assert.equal(r.maxMissMs, 0, `seed ${seed} D ${D}: a miss run of ${r.maxMissMs} ms`);
      assert.equal(r.badAt, null, `seed ${seed} D ${D}: bad output`);
      assert.ok(r.stall.healthyMs > 5000, `seed ${seed} D ${D}: healthy ${r.stall.healthyMs} ms`);
    }
  }
});

test("never fires in pauses both share: long silences, room noise and breaths the converter leaves out", () => {
  for (const seed of [5, 6]) {
    const { samples, utterances } = speech(seed);
    // The user listens for 12 s in the middle (the interviewer talks).
    const cut = Math.round(utterances[3].start * SR) - ms(300);
    const clean = new Float32Array(samples.length + ms(12000));
    clean.set(samples.subarray(0, cut));
    clean.set(samples.subarray(cut), cut + ms(12000));
    // The mic hears the room (-60 dBFS) and a breath before each sentence; the converter returns neither.
    const mic = Float32Array.from(clean);
    const room = noise(mic.length, -60, seed);
    for (let i = 0; i < mic.length; i++) mic[i] += room[i];
    const starts = utterances.map((u) => Math.round(u.start * SR) + (u.start * SR >= cut ? ms(12000) : 0));
    starts.forEach((s, k) => {
      const b = breathNoise(SR, 0.35, 70 + k);
      const from = s - ms(150) - b.length;
      if (from < 0) return;
      for (let i = 0; i < b.length; i++) mic[from + i] += 0.01 * b[i]; // peak -40 dBFS
    });
    for (const D of [250, 450]) {
      const r = run(mic, converted(clean, D), D);
      assert.equal(r.firedAt, null, `seed ${seed} D ${D}`);
      assert.ok(r.maxMissMs <= 50, `seed ${seed} D ${D}: a miss run of ${r.maxMissMs} ms`);
      assert.equal(r.badAt, null, `seed ${seed} D ${D}: bad output`);
    }
  }
});

test("never fires with isolated 2.7 ms and 10 ms zero blocks every 200 ms in the converted stream", () => {
  for (const seed of [1, 2, 3]) {
    const { samples } = speech(seed);
    const rand = rng(300 + seed);
    for (const D of [0, 300, 600]) {
      const conv = converted(samples, D);
      for (let t = ms(100); t < conv.length; t += ms(200)) {
        const at = t + Math.floor(rand() * FRAME); // anywhere in a frame
        conv.fill(0, at, at + (rand() < 0.5 ? 128 : 480));
      }
      const r = run(samples, conv, D);
      assert.equal(r.firedAt, null, `seed ${seed} D ${D}`);
      assert.ok(r.maxMissMs <= 50, `seed ${seed} D ${D}: a miss run of ${r.maxMissMs} ms`);
      assert.equal(r.badAt, null, `seed ${seed} D ${D}: bad output`);
    }
  }
});

test("never fires when the converted voice is recoloured, 6 dB down and D is 30 ms off either way", () => {
  for (const seed of [1, 2, 3, 4]) {
    const { samples } = speech(seed);
    for (const D of [120, 300, 450]) {
      for (const off of [-30, 30]) {
        const r = run(samples, converted(samples, D + off), D);
        assert.equal(r.firedAt, null, `seed ${seed} D ${D}${off > 0 ? "+" : ""}${off}`);
        assert.ok(r.maxMissMs <= 100, `seed ${seed} D ${D}${off > 0 ? "+" : ""}${off}: a miss run of ${r.maxMissMs} ms`);
        assert.equal(r.badAt, null, `seed ${seed} D ${D}${off > 0 ? "+" : ""}${off}: bad output`);
      }
    }
  }
});

test("a stale D (a jitter buffer that grew or drained by 100 ms) does not make a stall either", () => {
  for (const seed of [1, 2, 3]) {
    const { samples } = speech(seed);
    for (const off of [-100, 100]) {
      const r = run(samples, converted(samples, 300 + off), 300);
      assert.equal(r.firedAt, null, `seed ${seed} off ${off}`);
      assert.equal(r.badAt, null, `seed ${seed} off ${off}: bad output`);
    }
  }
});

test("D that changes at a pause: the jitter buffer grows 300 -> 420 ms, the mixer applies the new D a few seconds later", () => {
  for (const seed of [1, 2, 3]) {
    const { samples, utterances } = speech(seed);
    const pauseAfter = (k) => Math.round(((utterances[k].end + utterances[k + 1].start) / 2) * SR);
    const grow = pauseAfter(2) + ms(300); // arrival time, in a pause
    const conv = converted(samples, 300);
    conv.set(converted(samples, 420).subarray(grow), grow);
    const applied = pauseAfter(4);
    const r = run(samples, conv, (i) => (i < applied ? 300 : 420));
    assert.equal(r.firedAt, null, `seed ${seed}`);
    assert.equal(r.badAt, null, `seed ${seed}: bad output`);
    assert.equal(r.stall.following, true);
    assert.ok(r.stall.healthyMs > 1000, `seed ${seed}: healthy ${r.stall.healthyMs}`);
  }
});

test("the block size does not matter", () => {
  const { samples, utterances } = speech(4);
  const D = 300;
  const at = stallPoints(samples, utterances, rng(4), 1)[0];
  const orig = samples.subarray(0, at + ms(D) + ms(2000));
  const conv = converted(orig, D);
  conv.fill(0, at + ms(D));
  const results = [128, 480, 100, 1024].map((block) => {
    const r = run(orig, conv, D, { block });
    return { block, firedAt: r.firedAt, start: r.stall.stallStartSample, offset: r.stall.offsetDb };
  });
  for (const r of results) {
    assert.equal(r.start, results[0].start, `block ${r.block}`);
    assert.ok(Math.abs(r.firedAt - results[0].firedAt) <= 1024, `block ${r.block}: fired at ${r.firedAt} vs ${results[0].firedAt}`);
    assert.ok(Math.abs(r.offset - results[0].offset) < 0.1, `block ${r.block}: offset ${r.offset}`);
  }
});

test("with D unknown (null) it never declares a stall, still flags NaN, and does not judge the time before D was known", () => {
  const { samples } = speech(2);
  const silent = new Float32Array(samples.length);
  const r = run(samples, silent, null);
  assert.equal(r.firedAt, null);
  assert.equal(r.stall.healthyMs, 0);
  assert.equal(r.stall.badOutput, false);

  const nan = Float32Array.from(silent);
  nan[ms(7000)] = NaN;
  const n = run(samples, nan, null);
  assert.equal(n.firedAt, null);
  assert.ok(n.badAt !== null && n.badAt - ms(7000) <= BLOCK, `NaN seen at ${n.badAt}`);

  // The engine starts at 5 s: no converted audio before, D known from then on.
  const late = converted(samples, 300);
  late.fill(0, 0, ms(5000));
  const l = run(samples, late, (i) => (i < ms(5000) ? null : 300));
  assert.equal(l.firedAt, null);
  assert.ok(l.stall.healthyMs > 3000, `healthy ${l.stall.healthyMs}`);
});

test("a delay too long for the history is treated as unknown, not misjudged", () => {
  const { samples } = speech(3);
  const r = run(samples, delayed(samples, ms(3000)), 3000);
  assert.equal(r.firedAt, null);
  assert.equal(r.stall.healthyMs, 0);
});

test("healthyMs grows with matched speech and resets on a miss run; following tells the latest decision", () => {
  const { samples, utterances } = speech(4);
  const isSpeech = speechFrames(samples);
  const D = 300;
  const Ds = ms(D);
  const u = utterances.find((x) => x.start > 6 && x.end - x.start > 1);
  const at = Math.round((u.start + 0.3) * SR);
  const conv = converted(samples, D);
  conv.fill(0, at + Ds, at + Ds + ms(200)); // a 200 ms hole in the converted stream
  const seen = [];
  const r = run(samples, conv, D, { onBlock: (s, end) => seen.push([end, s.healthyMs, s.following]) });
  assert.equal(r.firedAt, null);
  const before = seen.filter(([t]) => t <= at + Ds);
  const healthyBefore = before.at(-1)[1];
  // Before the hole: every 10 ms frame of decided speech counts, never going down.
  for (let i = 1; i < before.length; i++) assert.ok(before[i][1] >= before[i - 1][1], "healthyMs went down");
  const spoken = speechMs(isSpeech, 0, at);
  assert.ok(healthyBefore > 0.75 * spoken && healthyBefore <= spoken, `healthy ${healthyBefore} of ${spoken} ms of speech`);
  // In the hole: reset, and not following.
  const inHole = seen.filter(([t]) => t > at + Ds + ms(100) && t < at + Ds + ms(250));
  assert.ok(inHole.some(([, h]) => h === 0), "healthyMs was not reset by the hole");
  assert.ok(inHole.some(([, , f]) => f === false), "still following in the hole");
  // After it: following again, counting up from zero (only speech after the hole counts).
  const end = seen.at(-1);
  assert.equal(end[2], true);
  const after = speechMs(isSpeech, at, samples.length);
  assert.ok(end[1] > 1000 && end[1] <= after, `healthy at the end ${end[1]}, ${after} ms of speech after the hole`);
});

test("badOutput: NaN or Infinity at once; a +20 dB burst for 30 ms is bad, +15 dB is not", () => {
  const { samples } = speech(3);
  const levels = frameLevelsDb(samples, SR, 10);
  let peak = -Infinity;
  for (const v of levels) peak = Math.max(peak, v);
  // A steady vowel after 4 s: a 30 ms burst there (not frame-aligned).
  let j = 400;
  while (![-2, -1, 0, 1, 2, 3, 4, 5].every((t) => levels[j + t] >= peak - 3)) j++;
  for (const D of [0, 300]) {
    for (const colour of [false, true]) {
      const burst = (gainDb) => {
        const conv = colour ? converted(samples, D) : delayed(samples, ms(D));
        const at = j * FRAME + ms(D) + 100;
        for (let i = at; i < at + ms(30); i++) conv[i] *= 10 ** (gainDb / 20);
        const r = run(samples, conv, D, { until: at + ms(500) });
        return r.badAt === null ? null : ((r.badAt - at) * 1000) / SR;
      };
      const what = `D ${D}${colour ? ", recoloured" : ""}`;
      const t20 = burst(20);
      assert.ok(t20 !== null && t20 <= 32, `${what}: +20 dB seen after ${t20} ms`);
      assert.equal(burst(15), null, `${what}: +15 dB flagged`);
    }
  }
  for (const bad of [NaN, Infinity, -Infinity]) {
    const conv = delayed(samples, ms(300));
    conv[ms(5000) + 17] = bad;
    const r = run(samples, conv, 300);
    assert.ok(r.badAt !== null && r.badAt - (ms(5000) + 17) <= BLOCK, `${bad} seen at ${r.badAt}`);
  }
});

test("badOutput: a loud burst while the user is silent is bad, converted speech arriving off-time is not", () => {
  const { samples, utterances } = speech(5);
  const D = 300;
  const pause = Math.round(((utterances[2].end + utterances[3].start) / 2) * SR) + ms(D);
  const conv = converted(samples, D);
  for (let i = pause; i < pause + ms(40); i++) conv[i] = 0.5 * Math.sin((2 * Math.PI * 2000 * i) / SR); // a -9 dBFS whistle
  assert.ok(run(samples, conv, D).badAt !== null);
  // A whole sentence that arrives 200 ms late (into the pause after it) is not a burst.
  const late = converted(samples, D);
  const u = utterances[4];
  const a = Math.round(u.start * SR) + ms(D);
  const b = Math.round(u.end * SR) + ms(D);
  late.fill(0, a, b);
  late.set(converted(samples, D).subarray(a, b), a + ms(200));
  assert.equal(run(samples, late, D).badAt, null);
});

test("badOutput is not raised by a burst once stalled, and stays set until reset()", () => {
  const { samples, utterances } = speech(1);
  const D = 300;
  const Ds = ms(D);
  const at = stallPoints(samples, utterances, rng(1), 1)[0];
  const conv = delayed(samples, Ds);
  conv.fill(0, at + Ds);
  const blast = at + Ds + ms(800);
  for (let i = blast; i < blast + ms(50); i++) conv[i] = 0.9; // after the stall was declared
  const r = run(samples, conv, D, { until: blast + ms(200) });
  assert.ok(r.firedAt !== null && r.firedAt < blast);
  assert.equal(r.stall.badOutput, false);

  const nan = delayed(samples, Ds);
  nan[ms(3000)] = NaN;
  const n = run(samples, nan, D);
  assert.equal(n.stall.badOutput, true); // long after the NaN
  n.stall.reset();
  assert.equal(n.stall.badOutput, false);
});

test("offsetDb learns the converted level over matched speech (EMA ~2 s), clamped to ±12 dB", () => {
  const { samples } = speech(6);
  for (const gainDb of [-6, 0, 6]) {
    const r = run(samples, converted(samples, 300, { gainDb }), 300);
    // The one-pole low-pass takes about another 0.5 dB off the vowels.
    assert.ok(Math.abs(r.stall.offsetDb - (gainDb - 0.5)) < 0.75, `${gainDb} dB: offset ${r.stall.offsetDb}`);
    assert.equal(r.firedAt, null);
  }
  const quiet = run(samples, converted(samples, 300, { gainDb: -12 }), 300);
  assert.equal(quiet.stall.offsetDb, -12); // -12.5 with the low-pass: clamped
  assert.equal(quiet.firedAt, null);
  assert.ok(quiet.maxMissMs <= 50, `a miss run of ${quiet.maxMissMs} ms`);
  const loud = run(samples, converted(samples, 300, { gainDb: 16 }), 300);
  assert.equal(loud.stall.offsetDb, 12);
  assert.equal(loud.firedAt, null);
  // Far out of range, a voice 20 dB under the mic cannot be told from comfort noise before
  // its level is learned: it counts as missing (the mixer stays on the user's own voice)
  // rather than noise counting as healthy converted speech.
  const faint = run(samples, converted(samples, 300, { gainDb: -20 }), 300);
  assert.ok(faint.firedAt !== null);
  assert.ok(faint.stall.healthyMs < 1000, `healthy ${faint.stall.healthyMs}`);

  // The converter gets 6 dB louder halfway: the estimate follows within a few seconds of speech.
  const conv = converted(samples, 300, { gainDb: -6 });
  const half = Math.round(samples.length / 2);
  for (let i = half; i < conv.length; i++) conv[i] *= 2;
  const offsets = [];
  const s = run(samples, conv, 300, { onBlock: (st, end) => offsets.push([end, st.offsetDb]) }).stall;
  const atHalf = offsets.find(([t]) => t >= half)[1];
  assert.ok(Math.abs(atHalf + 6.5) < 0.75, `before the step ${atHalf}`);
  assert.ok(Math.abs(s.offsetDb + 0.5) < 2, `at the end ${s.offsetDb}`);
  const after1s = offsets.find(([t]) => t >= half + ms(1000))[1];
  assert.ok(after1s < -2, `moved too fast: ${after1s} 1 s after the step`);
});

test("stalled is sticky until reset(); reset() keeps the learned offset and the stream position", () => {
  const { samples, utterances } = speech(2, 24);
  const D = 250;
  const Ds = ms(D);
  const [at, at2] = stallPoints(samples, utterances, rng(2), 6).filter((p, i, all) => i === 0 || p > all[0] + ms(7000));
  assert.ok(at2, "need a second stall point 7 s after the first");
  const conv = converted(samples, D);
  conv.fill(0, at + Ds, at + Ds + ms(1200)); // the engine recovers after 1.2 s
  conv.fill(0, at2 + Ds); // and stalls again for good
  let first = null;
  let resetDone = false;
  const r = run(samples, conv, D, {
    onBlock: (s, end) => {
      if (s.stalled && first === null) first = s.stallStartSample;
      if (!resetDone && end > at + Ds + ms(4000)) {
        assert.equal(s.stalled, true, "the stall cleared itself");
        assert.equal(s.stallStartSample, first);
        assert.ok(s.healthyMs > 500, `healthy again after the recovery: ${s.healthyMs}`);
        const offset = s.offsetDb;
        s.reset();
        assert.equal(s.stalled, false);
        assert.equal(s.stallStartSample, null);
        assert.equal(s.healthyMs, 0);
        assert.equal(s.following, false);
        assert.equal(s.badOutput, false);
        assert.equal(s.offsetDb, offset);
        resetDone = true;
      }
    },
  });
  assert.ok(resetDone);
  assert.ok(Math.abs(first - at) <= ms(20));
  // Positions keep counting from the start of the stream: the second stall is placed in stream time.
  assert.equal(r.stall.stalled, true);
  const err = ((r.stall.stallStartSample - at2) * 1000) / SR;
  assert.ok(err >= -20 && err <= 0, `second stall start off by ${err.toFixed(1)} ms`);
});

test("cheap enough for the audio thread: 60 s of 128-sample blocks in well under a second", () => {
  const { samples } = speech(7);
  const conv = converted(samples, 300);
  const stall = new StallDetector();
  const vad = new Vad();
  const t0 = performance.now();
  for (let rep = 0; rep < 4; rep++) {
    for (let i = 0; i + BLOCK <= samples.length; i += BLOCK) {
      const o = samples.subarray(i, i + BLOCK);
      vad.push(o);
      stall.push(o, conv.subarray(i, i + BLOCK), 300, vad.speaking);
    }
  }
  const msPerSecond = (performance.now() - t0) / (4 * 16);
  // About 0.5 ms here; the mixer's whole budget is 30 ms per second of audio.
  assert.ok(msPerSecond < 5, `${msPerSecond.toFixed(2)} ms per second of audio`);
  assert.equal(stall.stalled, false);
});
