import test from "node:test";
import assert from "node:assert/strict";
import { OriginalTimeline } from "../src/core/timeline.js";
import { addNoise, breathNoise, rng, synthSpeech } from "./helpers/synth.js";

const SR = 48000;
const BLOCK = 128;
const ms = (x) => Math.round((x * SR) / 1000);
const FADE = ms(5);
const KEEP = ms(150);
const MIN_PAUSE = ms(60);

const takes = new Map();
/**
 * A take: synthSpeech utterances, trimmed to their sound, separated by pauses
 * drawn from `pauseRanges` ([lo, hi] ms each), with a noise floor everywhere
 * (`noiseDb`, null for none). `utts` are the true speech spans [on, off) in samples.
 */
function take({ seed = 1, seconds = 24, pauseRanges = [[300, 600]], noiseDb = -60 } = {}) {
  const key = JSON.stringify({ seed, seconds, pauseRanges });
  if (!takes.has(key)) {
    const src = synthSpeech({ seconds: seconds * 1.4, seed, leadSec: 0.1, tailSec: 0.1 });
    const rand = rng(seed + 99);
    const total = Math.floor(ms(seconds * 1000) / BLOCK) * BLOCK;
    const clean = new Float32Array(total);
    const utts = [];
    let t = ms(500);
    for (const u of src.utterances) {
      let a = Math.round(u.start * SR);
      let b = Math.round(u.end * SR);
      while (a < b && src.samples[a] === 0) a++;
      while (b > a && src.samples[b - 1] === 0) b--;
      if (t + (b - a) + ms(2500) > total) break;
      clean.set(src.samples.subarray(a, b), t);
      utts.push({ on: t, off: t + (b - a) });
      const [lo, hi] = pauseRanges[Math.floor(rand() * pauseRanges.length)];
      t += b - a + ms(lo + (hi - lo) * rand());
    }
    takes.set(key, { clean, utts, noisy: new Map() });
  }
  const { clean, utts, noisy } = takes.get(key);
  if (noiseDb === null) return { audio: clean, utts };
  if (!noisy.has(noiseDb)) noisy.set(noiseDb, addNoise(clean, noiseDb, seed + 7));
  return { audio: noisy.get(noiseDb), utts };
}

/**
 * A VAD's flag per block (its state after the block): rises attackMs after a
 * word's first sound, falls hangMs after its last.
 */
function blockFlags(utts, length, { attackMs = 40, hangMs = 60 } = {}) {
  const f = new Uint8Array(length);
  for (const u of utts) f.fill(1, Math.min(length, u.on + ms(attackMs)), Math.min(length, u.off + ms(hangMs)));
  const blocks = new Uint8Array(Math.floor(length / BLOCK));
  for (let b = 0; b < blocks.length; b++) blocks[b] = f[b * BLOCK + BLOCK - 1];
  return blocks;
}

/** Write and read block by block; `step(b, tl)` runs after each write (jumps), `target(b)` is the target lag. */
function simulate({ audio, flags, target = () => 0, step = () => {}, options = {} }) {
  const tl = new OriginalTimeline(options);
  const blocks = flags.length;
  const out = new Float32Array(blocks * BLOCK);
  const lags = new Float64Array(blocks);
  for (let b = 0; b < blocks; b++) {
    const s = b * BLOCK;
    tl.write(audio.subarray(s, s + BLOCK), flags[b] === 1);
    step(b, tl);
    tl.read(out.subarray(s, s + BLOCK), target(b));
    lags[b] = tl.lagSamples;
  }
  return { tl, out, lags };
}

/**
 * Output index where each span of the input comes out verbatim and in one
 * piece (every sample bit-exact, consecutive), searching in order from
 * `from`; -1 when it does not.
 */
function locate(out, audio, spans, from = 0) {
  let i0 = from;
  return spans.map(({ on, off }) => {
    const len = off - on;
    for (let i = i0; i + len <= out.length; i++) {
      if (out[i] !== audio[on]) continue;
      let k = 1;
      while (k < len && out[i + k] === audio[on + k]) k++;
      if (k === len) {
        i0 = i + len;
        return i;
      }
    }
    return -1;
  });
}

/**
 * As locate, but each sample within `tol` of the input: a skip onto near-silent content lets the
 * last value before it fade out over fadeMs on top of what follows (at most the pause's level).
 */
function locateNear(out, audio, spans, from = 0, tol = 0.002) {
  let i0 = from;
  return spans.map(({ on, off }) => {
    const len = off - on;
    for (let i = i0; i + len <= out.length; i++) {
      if (Math.abs(out[i] - audio[on]) > tol) continue;
      let k = 1;
      while (k < len && Math.abs(out[i + k] - audio[on + k]) <= tol) k++;
      if (k === len) {
        i0 = i + len;
        return i;
      }
    }
    return -1;
  });
}

function maxStep(x, from = 1) {
  let m = 0;
  for (let i = Math.max(1, from); i < x.length; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
}

/** Samples of [from, to) whose block is flagged as a pause. */
function flaggedPause(flags, from, to) {
  let n = 0;
  for (let p = Math.max(0, from); p < Math.min(to, flags.length * BLOCK); p++) if (!flags[Math.floor(p / BLOCK)]) n++;
  return n;
}

/**
 * Every span comes out verbatim and whole, in order; between two spans the
 * output pause is the input pause minus what was dropped, and the drop
 * respects the rules: at most half of the flagged pause after its first
 * 60 ms, at least keepPauseMs of the flagged pause kept, nothing inserted.
 */
function checkSpeechAndPauses({ out, audio, flags, spans, from, attackMs, anchor }) {
  const at = locate(out, audio, spans, from);
  at.forEach((i, k) => assert.ok(i >= 0, `span ${k} [${spans[k].on}, ${spans[k].off}) is not in the output verbatim`));
  // The anchor (content inPos came out at outPos: the end of the replay fade) stands before
  // the first span; its pause, if the replay started in one, began at anchor.pauseFrom.
  const gaps = [{ inFrom: anchor.inPos, outFrom: anchor.outPos, pauseFrom: anchor.pauseFrom, to: 0 }];
  for (let k = 0; k + 1 < spans.length; k++) {
    const outFrom = at[k] + spans[k].off - spans[k].on;
    gaps.push({ inFrom: spans[k].off, outFrom, pauseFrom: spans[k].off, to: k + 1 });
  }
  let droppedTotal = 0;
  for (const [k, g] of gaps.entries()) {
    const dropped = spans[g.to].on - g.inFrom - (at[g.to] - g.outFrom);
    const flagged = flaggedPause(flags, g.pauseFrom, spans[g.to].on + ms(attackMs) + BLOCK);
    assert.ok(dropped >= 0, `pause ${k}: ${-dropped} samples inserted while catching up`);
    const half = Math.max(0, Math.floor((flagged - MIN_PAUSE) / 2));
    assert.ok(dropped <= half, `pause ${k}: dropped ${dropped} of ${flagged}`);
    assert.ok(dropped <= Math.max(0, flagged - KEEP), `pause ${k}: kept less than keepPauseMs (${flagged - dropped})`);
    droppedTotal += dropped;
  }
  return { at, droppedTotal };
}

/** Anchor for checkSpeechAndPauses after a replay jump to content J during block jb. */
function replayAnchor(utts, J, jb) {
  const before = utts.filter((u) => u.off <= J).pop();
  return { inPos: J + FADE, outPos: jb * BLOCK + FADE, pauseFrom: before ? before.off : 0 };
}

/** Utterances after content position `pos`; the one holding `pos` is cut to start there. */
function spansFrom(utts, pos, until) {
  const spans = [];
  for (const u of utts) {
    if (u.off <= pos || u.off > until) continue;
    spans.push({ on: Math.max(u.on, pos), off: u.off });
  }
  return spans;
}

test("target 0 after each write: a bit-exact passthrough", () => {
  const { audio, utts } = take({ seed: 1, seconds: 10 });
  const flags = blockFlags(utts, audio.length);
  const { tl, out, lags } = simulate({ audio, flags });
  for (let i = 0; i < out.length; i++) if (!Object.is(out[i], audio[i])) assert.fail(`sample ${i}`);
  assert.ok(lags.every((l) => l === 0));
  assert.equal(tl.writePos, flags.length * BLOCK);
});

test("a target lag from the start: silence, then the original delayed by exactly that lag", () => {
  const { audio, utts } = take({ seed: 2, seconds: 8 });
  const flags = blockFlags(utts, audio.length);
  for (const L of [ms(400), 12345]) {
    const { out, lags } = simulate({ audio, flags, target: () => L });
    for (let i = 0; i < out.length; i++) {
      const want = i >= L ? audio[i - L] : 0;
      if (!Object.is(out[i], want)) assert.fail(`L=${L} sample ${i}: ${out[i]} vs ${want}`);
    }
    lags.forEach((l, b) => assert.equal(l, Math.min(L, (b + 1) * BLOCK), `block ${b}`));
  }
});

/**
 * Replay 0.75 s back during block `jb` (as the mixer does at a stall), then
 * check: the lag never goes below the target, reaches it and stays; every
 * speech sample from the end of the replay fade on comes out verbatim and
 * whole; pauses follow the rules and give back exactly the excess; no clicks.
 * Returns how many pauses of the replayed content the catch-up took.
 */
function replayCase({ seed, targetMs, jb: jbAt, noiseDb = -60, pauseRanges = [[300, 600]], edit = null }) {
  const target = ms(targetMs);
  const t = take({ seed, noiseDb, pauseRanges });
  const utts = t.utts;
  const audio = edit ? edit(Float32Array.from(t.audio), utts) : t.audio;
  const flags = blockFlags(utts, audio.length);
  const jb = jbAt(utts);
  let J = null;
  const { tl, out, lags } = simulate({
    audio,
    flags,
    target: () => target,
    step: (b, t) => {
      if (b !== jb) return;
      J = t.writePos - ms(750);
      t.jumpTo(J);
    },
  });
  const label = `seed ${seed}, target ${targetMs} ms`;
  for (let b = jb; b < lags.length; b++) assert.ok(lags[b] >= target, `${label}: lag ${lags[b]} at block ${b}`);
  const done = lags.findIndex((l, b) => b > jb && l === target);
  assert.ok(done > 0, `${label}: never caught up (final lag ${lags[lags.length - 1]})`);
  for (let b = done; b < lags.length; b++) assert.equal(lags[b], target, `${label}: left the target at block ${b}`);
  const spans = spansFrom(utts, J + FADE, tl.writePos - tl.lagSamples);
  const anchor = replayAnchor(utts, J, jb);
  const { droppedTotal } = checkSpeechAndPauses({ out, audio, flags, spans, from: jb * BLOCK, attackMs: 40, anchor });
  assert.equal(droppedTotal, ms(750) - BLOCK - target, `${label}: exactly the excess comes out of the pauses`);
  assert.ok(maxStep(out) <= 2 * maxStep(audio), `${label}: step ${maxStep(out)} vs ${maxStep(audio)}`);
  const head = (done + 1) * BLOCK - target; // content being read when the lag reached the target
  let pauses = 0;
  for (let k = 0; k + 1 < utts.length; k++) if (utts[k + 1].on > J && utts[k].off < head) pauses++;
  // The fewest pauses the rules allow: each flagged pause of P gives back at
  // most min((P - 60 ms) / 2, P - keepPauseMs).
  let fewest = 0;
  let room = 0;
  for (let k = 0; k + 1 < utts.length && room < ms(750) - BLOCK - target; k++) {
    if (utts[k + 1].on <= J) continue;
    const flagged = flaggedPause(flags, Math.max(J, utts[k].off), utts[k + 1].on + ms(40) + BLOCK);
    room += Math.max(0, Math.min(Math.floor((flagged - MIN_PAUSE) / 2), flagged - KEEP));
    fewest++;
  }
  return { pauses, fewest, label, inSpeech: utts.some((u) => J >= u.on && J < u.off) };
}

test("replay 0.75 s back from mid-word: lag back to target within 3-5 pauses, no speech dropped, no clicks", () => {
  // A stall cuts a word: the replay starts in the middle of the 4th utterance.
  const midWord = (utts) => Math.floor((Math.floor((utts[3].on + utts[3].off) / 2) + ms(750)) / BLOCK) - 1;
  const counts = [];
  for (const seed of [1, 4, 5, 8, 13]) {
    for (const targetMs of [0, 200]) {
      const { pauses, fewest, label, inSpeech } = replayCase({ seed, targetMs, jb: midWord });
      assert.ok(inSpeech, `${label}: the replay should start in a word`);
      // Never slower than the rules allow, give or take the one pause the
      // word-start guard can cost at the live edge.
      assert.ok(pauses <= fewest + 1, `${label}: ${pauses} pauses where ${fewest} could do`);
      // Each pause gives back at most half of itself, so 750 ms takes 3 or
      // more; 3-5 whenever the pauses allow it (seed 4: five pauses of
      // 308-456 ms give back only 675 ms, so it takes 6).
      assert.ok(pauses >= 3 && (pauses <= 5 || fewest >= 5), `${label}: caught up after ${pauses} pauses`);
      counts.push(pauses);
    }
  }
  assert.ok(counts.filter((n) => n <= 5).length >= counts.length - 1, `pauses taken: ${counts}`);
});

test("replay with a noisy room (pauses at -35 dBFS: skips crossfade): the same guarantees", () => {
  const midWord = (utts) => Math.floor((Math.floor((utts[3].on + utts[3].off) / 2) + ms(750)) / BLOCK) - 1;
  for (const seed of [1, 2, 5]) {
    for (const targetMs of [0, 200]) {
      const { pauses, fewest, label } = replayCase({ seed, targetMs, jb: midWord, noiseDb: -35 });
      assert.ok(pauses <= fewest + 1, `${label}: ${pauses} pauses where ${fewest} could do`);
    }
  }
});

test("replay starting inside a pause: the same rules, still catches up", () => {
  // Seed 4: 0.75 s before the middle of the 4th utterance is the pause before it.
  const jb = (utts) => Math.floor((utts[3].on + utts[3].off) / 2 / BLOCK);
  const { inSpeech } = replayCase({ seed: 4, targetMs: 0, jb });
  assert.equal(inSpeech, false);
});

test("replay with an inhale before every sentence (400 ms, peak -40 dBFS, ending 100 ms before it): the breath goes with the pause, no slower than the rules allow", () => {
  // A breath is louder than the pause's quiet; it lasts far longer than a word's soft first sound
  // and falls back to the quiet before the word, so a skip may drop it.
  const midWord = (utts) => Math.floor((Math.floor((utts[3].on + utts[3].off) / 2) + ms(750)) / BLOCK) - 1;
  const breaths = (seed) => (audio, utts) => {
    utts.forEach((u, k) => {
      if (k === 0) return;
      const b = breathNoise(SR, 0.4, 50 * seed + k);
      for (let i = 0; i < b.length; i++) audio[u.on - ms(100) - b.length + i] += 0.01 * b[i];
    });
    return audio;
  };
  for (const seed of [1, 4, 5]) {
    for (const targetMs of [0, 200]) {
      const { pauses, fewest, label } = replayCase({ seed, targetMs, jb: midWord, noiseDb: -65, pauseRanges: [[700, 1000]], edit: breaths(seed) });
      assert.ok(pauses <= fewest + 1, `${label}: ${pauses} pauses where ${fewest} could do`);
    }
  }
});

test("short pauses are left alone, long ones catch up, a sluggish VAD loses no word", () => {
  for (const seed of [5, 6]) {
    const { audio, utts } = take({ seed, seconds: 30, pauseRanges: [[60, 140], [300, 600], [1000, 2000]] });
    // The flag rises 70 ms after a word starts (a slow VAD) and falls 40 ms after it ends.
    const flags = blockFlags(utts, audio.length, { attackMs: 70, hangMs: 40 });
    const jb = Math.floor((utts[2].on + utts[2].off) / 2 / BLOCK);
    let J = null;
    const { tl, out, lags } = simulate({
      audio,
      flags,
      step: (b, t) => {
        if (b !== jb) return;
        J = t.writePos - ms(1500);
        t.jumpTo(J);
      },
    });
    assert.equal(lags[lags.length - 1], 0, `seed ${seed}: caught up`);
    const spans = spansFrom(utts, J + FADE, tl.writePos);
    const anchor = replayAnchor(utts, J, jb);
    const from = jb * BLOCK;
    const { at, droppedTotal } = checkSpeechAndPauses({ out, audio, flags, spans, from, attackMs: 70, anchor });
    assert.equal(droppedTotal, ms(1500) - BLOCK, `seed ${seed}: dropped`);
    // Pauses whose flagged part is under keepPauseMs come out exactly as long as they went in.
    for (let k = 0; k + 1 < spans.length; k++) {
      const flagged = flaggedPause(flags, spans[k].off, spans[k + 1].on + ms(70) + BLOCK);
      if (flagged >= KEEP) continue;
      const gapOut = at[k + 1] - (at[k] + spans[k].off - spans[k].on);
      assert.equal(gapOut, spans[k + 1].on - spans[k].off, `seed ${seed}: short pause ${k} changed`);
    }
    assert.ok(maxStep(out) <= 2 * maxStep(audio));
  }
});

/** A soft first sound (an "f", an "h"): high-passed noise of RMS `rmsDb`, 10 ms ramps, n samples. */
function fricative(n, rmsDb, seed) {
  const rand = rng(seed);
  const out = new Float32Array(n);
  let prev = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const w = rand() * 2 - 1;
    out[i] = w - prev;
    prev = w;
    sum += out[i] * out[i];
  }
  const g = 10 ** (rmsDb / 20) / Math.sqrt(sum / n);
  for (let i = 0; i < n; i++) out[i] *= g * Math.min(1, i / ms(10), (n - i) / ms(10));
  return out;
}

test("a soft first sound the VAD calls pause (an h, an f, a breathy start) is never dropped or crossfaded while catching up", () => {
  // 120-200 ms of fricative 26-31 dB under the vowels before each word: the flag rises only
  // with the vowel, so for the timeline all of it is pause, longer than the word-start guard.
  for (const seed of [1, 4, 5]) {
    const { audio: base, utts } = take({ seed });
    const audio = Float32Array.from(base);
    const words = []; // the soft start and the word after it
    utts.forEach((u, k) => {
      if (k === 0) return;
      const len = ms(k % 2 ? 120 : 200);
      const f = fricative(len, k % 2 ? -46 : -50, 10 * seed + k);
      for (let i = 0; i < len; i++) audio[u.on - len + i] += f[i];
      words.push({ on: u.on - len, off: u.off });
    });
    const flags = blockFlags(utts, audio.length);
    const jb = Math.floor((Math.floor((utts[3].on + utts[3].off) / 2) + ms(750)) / BLOCK) - 1;
    let J = null;
    const { tl, out, lags } = simulate({
      audio,
      flags,
      step: (b, t) => {
        if (b !== jb) return;
        J = t.writePos - ms(750);
        t.jumpTo(J);
      },
    });
    assert.equal(lags[lags.length - 1], 0, `seed ${seed}: never caught up`);
    const after = words.filter((w) => w.on > J + FADE);
    assert.ok(after.length >= 5, `seed ${seed}: ${after.length} words`);
    locate(out, audio, after, jb * BLOCK).forEach((p, k) => {
      assert.ok(p >= 0, `seed ${seed}: the word at ${(after[k].on / SR).toFixed(3)} s and its soft start are not in the output whole`);
    });
    assert.ok(maxStep(out) <= 2 * maxStep(audio));
  }
});

test("a soft 's' with a stop closure before the vowel (\"stop\", \"speak\") is never dropped while catching up, though it falls back to quiet first", () => {
  // 60-150 ms of fricative, then a 70 ms closure as quiet as the pause, then the vowel: unlike a
  // breath it is too short to be skipped. (The closure is pause as quiet as the rest: the rules
  // may shorten it before the word-start guard, as any pause.)
  for (const seed of [1, 4, 5]) {
    const { audio: base, utts } = take({ seed, noiseDb: -65 });
    const audio = Float32Array.from(base);
    const words = [];
    utts.forEach((u, k) => {
      if (k === 0) return;
      const len = ms(60 + 30 * (k % 4)); // 60-150 ms
      const f = fricative(len, k % 2 ? -46 : -42, 30 * seed + k);
      const from = u.on - ms(70) - len;
      for (let i = 0; i < len; i++) audio[from + i] += f[i];
      words.push({ on: from, off: from + len }, { on: u.on, off: u.off });
    });
    const flags = blockFlags(utts, audio.length);
    const jb = Math.floor((Math.floor((utts[3].on + utts[3].off) / 2) + ms(750)) / BLOCK) - 1;
    let J = null;
    const { out, lags } = simulate({
      audio,
      flags,
      step: (b, t) => {
        if (b !== jb) return;
        J = t.writePos - ms(750);
        t.jumpTo(J);
      },
    });
    assert.equal(lags[lags.length - 1], 0, `seed ${seed}: never caught up`);
    const after = words.filter((w) => w.on > J + FADE);
    assert.ok(after.length >= 10, `seed ${seed}: ${after.length / 2} words`);
    locateNear(out, audio, after, jb * BLOCK).forEach((p, k) => {
      assert.ok(p >= 0, `seed ${seed}: the ${k % 2 ? "word" : "'s'"} at ${(after[k].on / SR).toFixed(3)} s is not in the output whole`);
    });
  }
});

test("never skips speech: without a pause the replay lag stays and the output is the content", () => {
  const { audio } = take({ seed: 3, seconds: 8 });
  const flags = new Uint8Array(audio.length / BLOCK).fill(1);
  const jb = 1000;
  const back = ms(500);
  const { out, lags } = simulate({ audio, flags, step: (b, t) => b === jb && t.jumpTo(t.writePos - back) });
  const lag = back - BLOCK; // the jump block's read already advanced one block
  for (let b = jb; b < lags.length; b++) assert.equal(lags[b], lag, `block ${b}`);
  for (let i = jb * BLOCK + FADE; i < out.length; i++) if (out[i] !== audio[i - lag]) assert.fail(`sample ${i}`);
  // Missing flags count as speech too.
  const tl = new OriginalTimeline();
  const blk = new Float32Array(BLOCK);
  for (let b = 0; b < 400; b++) {
    tl.write(blk);
    if (b === 200) tl.jumpTo(tl.writePos - ms(300));
    tl.read(blk, 0);
  }
  assert.equal(tl.lagSamples, ms(300) - BLOCK);
});

test("no clicks on a steady tone: replay jump, pause skips, a hold and catching up again", () => {
  const n = Math.floor(ms(16000) / BLOCK) * BLOCK;
  const tone = new Float32Array(n);
  for (let i = 0; i < n; i++) tone[i] = 0.5 * Math.sin((2 * Math.PI * 200 * i) / SR);
  // Flags alternate 700 ms "speech" and 400 ms "pause"; the content is the same tone throughout.
  const flags = new Uint8Array(n / BLOCK);
  for (let b = 0; b < flags.length; b++) flags[b] = (b * BLOCK) % ms(1100) < ms(700) ? 1 : 0;
  const L = ms(300);
  const targetAt = (b) => (b * BLOCK >= ms(8000) && b * BLOCK < ms(12000) ? L : 0);
  const { out, lags } = simulate({
    audio: tone,
    flags,
    target: targetAt,
    step: (b, t) => b * BLOCK === ms(3328) - (ms(3328) % BLOCK) && t.jumpTo(t.writePos - ms(750)),
  });
  const limit = 2 * maxStep(tone);
  for (let i = 1; i < out.length; i++) {
    const step = Math.abs(out[i] - out[i - 1]);
    if (step > limit) assert.fail(`click at ${i}: ${step} > ${limit}`);
  }
  const at = (sec) => lags[Math.floor(ms(sec * 1000) / BLOCK)];
  assert.equal(at(7.9), 0, "caught up after the replay");
  assert.equal(at(11.9), L, "held back to the larger target");
  assert.equal(at(15.9), 0, "caught up again");
});

test("a larger target holds back in a pause: silence goes in, speech is never repeated or cut", () => {
  const { audio, utts } = take({ seed: 7, seconds: 20 });
  const flags = blockFlags(utts, audio.length);
  const L = ms(400);
  const up = Math.floor((utts[3].on + 1000) / BLOCK); // switched on while a word is being said
  const down = Math.floor((utts[8].on + 1000) / BLOCK);
  const { out, lags } = simulate({ audio, flags, target: (b) => (b >= up && b < down ? L : 0) });
  // The lag grows only inside the first pause after the switch, to exactly L.
  const pauseStart = utts[3].off;
  const pauseEnd = utts[4].on;
  for (let b = up; b < down; b++) {
    const head = (b + 1) * BLOCK - lags[b]; // content position being read
    if (head < pauseStart) assert.equal(lags[b], 0, `block ${b}: grew inside the word`);
    if (head >= pauseEnd) assert.equal(lags[b], L, `block ${b}: not at the target after the pause`);
    assert.ok(lags[b] <= L);
  }
  assert.equal(lags[lags.length - 1], 0, "back to 0 when the target drops");
  // Every utterance verbatim and whole, exactly once.
  const at = locate(out, audio, utts, 0);
  utts.forEach((u, k) => {
    assert.ok(at[k] >= 0, `utterance ${k} cut or changed`);
    assert.equal(locate(out, audio, [u], at[k] + 1)[0], -1, `utterance ${k} repeated`);
  });
  // The silence went into pause 3: it came out L longer.
  const gapOut = at[4] - (at[3] + utts[3].off - utts[3].on);
  assert.equal(gapOut, utts[4].on - utts[3].off + L);
  assert.ok(maxStep(out) <= 2 * maxStep(audio));
});

test("a larger target never holds inside a soft first sound the flag still calls pause: the silence goes into the next real pause", () => {
  // Room at -65 dBFS, a 150 ms 'h' (noise at -46 dBFS RMS), then a vowel (flagged from 40 ms in).
  // The original runs 300 ms behind; the target becomes 400 ms while it plays the 'h'.
  const n = Math.floor(ms(3000) / BLOCK) * BLOCK;
  const pre = ms(1200);
  const h = ms(150);
  const v = ms(400);
  for (const seed of [1, 2]) {
    const rand = rng(seed);
    const gauss = () => {
      let u = -3;
      for (let k = 0; k < 6; k++) u += rand();
      return u;
    };
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 10 ** (-65 / 20) * Math.SQRT2 * gauss();
    for (let i = pre; i < pre + h; i++) x[i] += 10 ** (-46 / 20) * Math.SQRT2 * gauss() * Math.min(1, (i - pre) / ms(10));
    for (let i = pre + h; i < pre + h + v; i++) x[i] += 0.2 * Math.sin((2 * Math.PI * 150 * i) / SR) * Math.min(1, (i - pre - h) / ms(10));
    const flags = new Uint8Array(n / BLOCK);
    for (let b = 0; b < flags.length; b++) flags[b] = b * BLOCK + BLOCK - 1 >= pre + h + ms(40) && b * BLOCK + BLOCK - 1 < pre + h + v + ms(100) ? 1 : 0;
    for (const intoMs of [20, 50, 80]) {
      const raise = pre + ms(300) + ms(intoMs); // output time when the head is intoMs into the 'h'
      const { out, tl } = simulate({ audio: x, flags, target: (b) => (b * BLOCK >= raise ? ms(400) : ms(300)) });
      assert.equal(tl.lagSamples, ms(400), `seed ${seed}, ${intoMs} ms: the hold never happened`);
      // The 'h' and the vowel after it come out verbatim and whole: no silence inside.
      const [at] = locate(out, x, [{ on: pre, off: pre + h + v }]);
      assert.ok(at >= 0, `seed ${seed}: raised ${intoMs} ms into the 'h', which is split or cut`);
    }
  }
});

test("jumpTo is clamped to the history and writePos; non-numbers are ignored", () => {
  const tl = new OriginalTimeline({ historyMs: 1000 });
  const blk = new Float32Array(BLOCK).fill(0.1);
  const out = new Float32Array(BLOCK);
  for (let b = 0; b < 1000; b++) {
    tl.write(blk, true);
    tl.read(out, 0);
  }
  tl.jumpTo(-1e9);
  assert.equal(tl.lagSamples, ms(1000));
  tl.jumpTo(tl.writePos + 1e6);
  assert.equal(tl.lagSamples, 0);
  tl.jumpTo(tl.writePos - 5000.4);
  assert.equal(tl.lagSamples, 5000);
  for (const bad of [NaN, null, undefined, "100", Infinity]) {
    tl.jumpTo(bad);
    assert.equal(tl.lagSamples, 5000, String(bad));
  }
  // A target beyond the history is held at the history.
  const t2 = new OriginalTimeline({ historyMs: 100 });
  for (let b = 0; b < 200; b++) {
    t2.write(blk, false);
    t2.read(out, ms(5000));
  }
  assert.equal(t2.lagSamples, ms(100));
});

test("robust: NaN input, reads without writes, writes without reads", () => {
  const tl = new OriginalTimeline();
  const out = new Float32Array(BLOCK);
  const bad = new Float32Array(BLOCK).fill(0.2);
  bad[5] = NaN;
  bad[6] = Infinity;
  bad[7] = -Infinity;
  tl.write(bad, true);
  tl.read(out, 0);
  assert.ok(out.every(Number.isFinite));
  assert.equal(out[5], 0);
  // Reads with nothing new: a smooth fall to silence, then waiting.
  tl.read(out, 0);
  assert.ok(out.every(Number.isFinite));
  assert.ok(Math.abs(out[0] - 0.2) <= 0.2 / FADE + 1e-6, `first sample ${out[0]}`);
  assert.equal(maxStep(out) <= 0.2 / FADE + 1e-6, true);
  tl.read(out, NaN); // the fall lasts fadeMs (240 samples), then silence
  assert.ok(out.subarray(FADE - BLOCK).every((v) => v === 0));
  tl.read(out, 0);
  assert.ok(out.every((v) => v === 0));
  // Content again: a fade-in, not a jump.
  const steady = new Float32Array(BLOCK).fill(0.2);
  tl.write(steady, true);
  tl.read(out, 0);
  assert.ok(out[0] < 0.01 && maxStep(out) < 0.01, `fade-in ${out[0]} ${maxStep(out)}`);
  // Five seconds of writes with no reads: the reader restarts inside the history.
  for (let b = 0; b < ms(5000) / BLOCK; b++) tl.write(steady, true);
  assert.ok(tl.lagSamples <= ms(3500), `lag ${tl.lagSamples}`); // history + the ring's slack
  tl.read(out, 0);
  assert.ok(out.every(Number.isFinite) && maxStep(out) < 0.01);
  tl.write(new Float32Array(0), true);
  tl.read(new Float32Array(0), 0);
});

test("two replays in a row (a second fault after catching up): no speech dropped either time", () => {
  const { audio, utts } = take({ seed: 9, seconds: 30 });
  const flags = blockFlags(utts, audio.length);
  const jbs = [3, 10].map((k) => Math.floor((Math.floor((utts[k].on + utts[k].off) / 2) + ms(750)) / BLOCK) - 1);
  const Js = [];
  const { tl, out, lags } = simulate({
    audio,
    flags,
    step: (b, t) => {
      if (!jbs.includes(b)) return;
      assert.equal(t.lagSamples, BLOCK, "caught up before the next fault");
      Js.push(t.writePos - ms(750));
      t.jumpTo(Js[Js.length - 1]);
    },
  });
  assert.equal(lags[lags.length - 1], 0);
  for (const [n, J] of Js.entries()) {
    const until = n === 0 ? Js[1] - ms(750) : tl.writePos;
    const spans = spansFrom(utts, J + FADE, until);
    const anchor = replayAnchor(utts, J, jbs[n]);
    checkSpeechAndPauses({ out, audio, flags, spans, from: jbs[n] * BLOCK, attackMs: 40, anchor });
  }
  assert.ok(maxStep(out) <= 2 * maxStep(audio));
});

/** A 200 Hz tone of amplitude `amp`, n samples. */
function toneOf(n, amp = 0.5, hz = 200) {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR);
  return x;
}

test("a first read after content piled up joins mid-signal with a fade-in", () => {
  const x = toneOf(20 * BLOCK);
  const tl = new OriginalTimeline();
  for (let b = 0; b < 10; b++) tl.write(x.subarray(b * BLOCK, (b + 1) * BLOCK), true);
  const out = new Float32Array(10 * BLOCK);
  for (let b = 10; b < 20; b++) {
    tl.write(x.subarray(b * BLOCK, (b + 1) * BLOCK), true);
    tl.read(out.subarray((b - 10) * BLOCK, (b - 9) * BLOCK), 0);
  }
  assert.equal(tl.lagSamples, 0, "at the target lag");
  assert.ok(Math.abs(out[0]) < 0.01, `starts from silence: ${out[0]}`);
  assert.ok(maxStep(out) <= 2 * maxStep(x));
  for (let i = FADE; i < out.length; i++) assert.equal(out[i], x[i + 10 * BLOCK]);
});

test("a word starting right where a hold stops comes out whole, after the silence", () => {
  // 400 ms of quiet noise (a pause), then a loud tone (a word, flagged at once), then noise again.
  const n = ms(3000) - (ms(3000) % BLOCK);
  const x = addNoise(new Float32Array(n), -60, 3);
  const wordOn = Math.ceil(ms(400) / BLOCK) * BLOCK;
  const wordOff = wordOn + ms(1000) - (ms(1000) % BLOCK);
  const tone = toneOf(n, 0.3);
  for (let i = wordOn; i < wordOff; i++) x[i] += tone[i];
  const flags = new Uint8Array(n / BLOCK);
  for (let b = 0; b < flags.length; b++) flags[b] = b * BLOCK >= wordOn && b * BLOCK < wordOff ? 1 : 0;
  const L = ms(200);
  const holdBlock = wordOn / BLOCK - 1; // the target grows in the last pause block before the word
  const { tl, out } = simulate({ audio: x, flags, target: (b) => (b >= holdBlock ? L : 0) });
  assert.equal(tl.lagSamples, L);
  // The hold stopped at the start of that block (the live edge): everything from there on is L later, untouched.
  const [at] = locate(out, x, [{ on: holdBlock * BLOCK, off: wordOff }]);
  assert.equal(at, holdBlock * BLOCK + L, "the pause end and the word, verbatim and whole, after the silence");
  for (let i = holdBlock * BLOCK + FADE; i < at; i++) assert.equal(out[i], 0, `silence at ${i}`);
  assert.ok(maxStep(out) <= 2 * maxStep(x), `step ${maxStep(out)}`);
});

test("rapid jumps with tiny blocks, reads without writes, writes without reads: finite, bounded, no clicks", () => {
  const x = toneOf(ms(4000));
  const limit = 2 * maxStep(x);
  const tl = new OriginalTimeline({ historyMs: 1000 });
  const small = 16;
  const out = new Float32Array(small);
  let prev = 0;
  let peak = 0;
  const check = (label) => {
    for (let i = 0; i < out.length; i++) {
      assert.ok(Number.isFinite(out[i]), label);
      assert.ok(Math.abs(out[i] - prev) <= limit, `${label}: step ${Math.abs(out[i] - prev)}`);
      prev = out[i];
      peak = Math.max(peak, Math.abs(out[i]));
    }
  };
  let w = 0;
  const write = () => {
    tl.write(x.subarray(w, w + small), true);
    w += small;
  };
  for (let b = 0; b < 2000; b++) {
    write();
    if (b >= 1000 && b < 1040) tl.jumpTo(tl.writePos - 2000 - 37 * (b % 7)); // a jump every 16 samples
    tl.read(out, 0);
    check(`block ${b}`);
  }
  // Fades running out of content: a jump, then reads without writes.
  tl.jumpTo(tl.writePos - 50);
  for (let k = 0; k < 40; k++) {
    tl.read(out, 0);
    check(`dry read ${k}`);
  }
  // Writes without reads while a jump still fades: the reader restarts inside the history.
  for (let k = 0; k < 20; k++) {
    write();
    tl.read(out, 0);
    check(`playing again ${k}`);
  }
  write();
  tl.jumpTo(tl.writePos - 3000);
  tl.read(out, 0); // the old position is still fading out (224 samples to go) when the flood starts
  check("before the flood");
  for (let k = 0; k < 6000 && w + small <= x.length; k++) write();
  for (let k = 0; k < 40; k++) {
    tl.read(out, 0);
    check(`after the flood ${k}`);
  }
  assert.ok(peak <= 0.5 * Math.SQRT2 + 1e-6, `peak ${peak}`);
});

test("random operations (seeded): finite, bounded, click-free output and a sane lag", () => {
  const amp = 0.5;
  const w = (2 * Math.PI * 150) / SR;
  for (let seed = 1; seed <= 8; seed++) {
    const rand = rng(seed);
    const tl = new OriginalTimeline({ historyMs: 1000 });
    let n = 0;
    let prev = null;
    let speech = true;
    let target = 0;
    for (let op = 0; op < 1500; op++) {
      const r = rand();
      if (r < 0.03) speech = !speech;
      if (r > 0.97) target = Math.floor(rand() * 60000);
      if (r > 0.5 && r < 0.52) tl.jumpTo(tl.writePos - Math.floor(rand() * 70000) + 1000);
      const size = () => (rand() < 0.1 ? 1 + Math.floor(rand() * 4) : 1 + Math.floor(rand() * 300));
      if (rand() < 0.9) {
        const blk = new Float32Array(size());
        for (let i = 0; i < blk.length; i++) blk[i] = amp * Math.sin(w * (n + i));
        n += blk.length;
        tl.write(blk, speech);
      }
      if (rand() < 0.92) {
        const out = new Float32Array(size());
        tl.read(out, target);
        for (const v of out) {
          assert.ok(Number.isFinite(v) && Math.abs(v) <= amp * Math.SQRT2 + 1e-6, `seed ${seed} op ${op}: ${v}`);
          if (prev !== null) assert.ok(Math.abs(v - prev) <= 2 * amp * w, `seed ${seed} op ${op}: click ${v - prev}`);
          prev = v;
        }
      }
      assert.ok(tl.lagSamples >= 0 && tl.lagSamples <= ms(1500), `seed ${seed} op ${op}: lag ${tl.lagSamples}`);
    }
  }
});
