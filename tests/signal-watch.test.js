import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EnvelopeStream, LevelWindow, TONE_HZ, ToneCheck, ZeroRuns } from "../src/core/signal-watch.js";
import { envelopeDb } from "../src/core/delay-estimate.js";
import {
  addNoise,
  addSpike,
  dropFrames,
  gainStep,
  insertZeros,
  rng,
  synthSpeech,
  tone,
  whiteNoise,
  zeroFill,
} from "./helpers/synth.js";

const SR = 48000;
const B = 512;

/** Push `x` in blocks of `size` samples, as a worklet does. */
function pushAll(analyser, x, size = 128) {
  for (let i = 0; i < x.length; i += size) analyser.push(x.subarray(i, Math.min(x.length, i + size)));
}

/** The test tone as VB-CABLE carries it: −12 dBFS, −90 dBFS of noise, 16-bit samples. */
function cableTone(seconds, seed = 1) {
  const x = tone({ seconds });
  return realistic(x, seed);
}

function realistic(x, seed = 1) {
  const noise = whiteNoise(x.length, seed, -90);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = Math.round((x[i] + noise[i]) * 32767) / 32767;
  return out;
}

/** Run a ToneCheck over `x` and return it with every event it reported. */
function check(x, { size = 128, options = {} } = {}) {
  const t = new ToneCheck(options);
  const events = [];
  for (let i = 0; i < x.length; i += size) {
    t.push(x.subarray(i, Math.min(x.length, i + size)));
    if (i % (SR * 10) < size) events.push(...t.takeEvents());
  }
  events.push(...t.takeEvents());
  return { t, events };
}

const near = (actual, expected, tol, what) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} is not within ${tol} of ${expected}`);

test("TONE_HZ is exactly 11 cycles per 512 samples at 48 kHz", () => {
  assert.equal(TONE_HZ, 1031.25);
  assert.equal((TONE_HZ * 512) / SR, 11);
});

// ---------- LevelWindow ----------

test("LevelWindow: a −12 dBFS sine reads −15.01 dB RMS and −12.0 dB peak", () => {
  const w = new LevelWindow();
  assert.equal(w.rmsDb, -120);
  assert.equal(w.peakDb, -120);
  const x = tone({ seconds: 1, hz: 1000 });
  assert.equal(w.push(x.subarray(0, 4799)), false, "no window completes before 4800 samples");
  assert.equal(w.push(x.subarray(4799, 4800)), true, "the 4800th sample completes one");
  near(w.rmsDb, -15.01, 0.05, "rms");
  near(w.peakDb, -12.0, 0.05, "peak");
  pushAll(w, x.subarray(4800));
  near(w.rmsDb, -15.01, 0.05, "rms later");
});

test("LevelWindow: silence and NaN floor at −120 dB; windows of any length", () => {
  const w = new LevelWindow({ frames: 480 });
  assert.equal(w.push(new Float32Array(480)), true);
  assert.equal(w.rmsDb, -120);
  assert.equal(w.peakDb, -120);
  const bad = new Float32Array(480).fill(NaN);
  w.push(bad);
  assert.equal(w.rmsDb, -120, "NaN counts as silence, not as a poisoned sum");
  const loud = new Float32Array(480).fill(0.5);
  w.push(loud);
  near(w.rmsDb, -6.02, 0.01, "constant 0.5");
  near(w.peakDb, -6.02, 0.01, "peak 0.5");
});

// ---------- ZeroRuns ----------

/** Noise with zero runs of the given lengths at the given starts. */
function withRuns(n, runs, seed = 4) {
  const x = whiteNoise(n, seed, -50);
  for (let i = 0; i < n; i++) if (x[i] === 0) x[i] = 1e-3; // no accidental zeros in the noise
  for (const [at, len] of runs) x.fill(0, at, at + len);
  return x;
}

test("ZeroRuns: a run of 47 is not reported, 48 is, across block boundaries", () => {
  const x = withRuns(4000, [
    [100, 47],
    [250, 48], // crosses the boundary at 256
    [1000, 300], // crosses 1024
  ]);
  const z = new ZeroRuns();
  pushAll(z, x, 128);
  assert.deepEqual(z.takeRuns(), [
    { startFrame: 250, frames: 48 },
    { startFrame: 1000, frames: 300 },
  ]);
  assert.deepEqual(z.takeRuns(), [], "a take empties the list");
  assert.equal(z.frame, 4000);
  assert.equal(z.zeroFrames, 348, "the frames of the reported runs");
});

test("ZeroRuns: a run still open is reported only once it ends", () => {
  const z = new ZeroRuns();
  const noise = withRuns(500, []);
  z.push(noise);
  z.push(new Float32Array(100));
  assert.deepEqual(z.takeRuns(), []);
  assert.equal(z.openFrames, 100);
  assert.equal(z.zeroFrames, 100, "an open run counts once it is long enough");
  z.push(new Float32Array(30));
  assert.equal(z.openFrames, 130);
  z.push(noise.subarray(0, 10));
  assert.equal(z.openFrames, 0);
  assert.deepEqual(z.takeRuns(), [{ startFrame: 500, frames: 130 }]);
  assert.equal(z.zeroFrames, 130);
  z.push(new Float32Array(20));
  assert.equal(z.openFrames, 20);
  assert.equal(z.zeroFrames, 130, "an open run shorter than minFrames is not counted yet");
});

test("ZeroRuns: single zero samples of a quiet 16-bit microphone are not counted", () => {
  // Noise at about 3 LSB RMS, quantised to 16 bits: about one sample in eight is exactly 0.
  const x = whiteNoise(48000, 9, -80).map((v) => Math.round(v * 32767) / 32767);
  let zeros = 0;
  for (const v of x) zeros += v === 0 ? 1 : 0;
  assert.ok(zeros > 2000, `the noise has many single zeros (${zeros})`);
  const z = new ZeroRuns();
  pushAll(z, x);
  assert.equal(z.zeroFrames, 0);
  assert.deepEqual(z.takeRuns(), []);
});

test("ZeroRuns: at most maxRuns kept between takes, the rest counted as dropped", () => {
  const runs = Array.from({ length: 10 }, (_, k) => [100 + k * 200, 60]);
  const z = new ZeroRuns({ maxRuns: 4 });
  pushAll(z, withRuns(3000, runs));
  const taken = z.takeRuns();
  assert.equal(taken.length, 4);
  assert.deepEqual(taken[0], { startFrame: 100, frames: 60 });
  assert.equal(z.dropped, 6);
  assert.equal(z.zeroFrames, 600, "dropped runs still count as zero frames");
});

test("ZeroRuns: the level and the minimum length can be set", () => {
  const z = new ZeroRuns({ level: 1e-3, minFrames: 10 });
  const x = new Float32Array(100).fill(0.5);
  x.fill(5e-4, 20, 32);
  z.push(x);
  assert.deepEqual(z.takeRuns(), [{ startFrame: 20, frames: 12 }]);
});

// ---------- EnvelopeStream ----------

/** A 3 s signal with speech, noise and stretches of digital silence. */
function mixedSignal(seed) {
  const x = addNoise(synthSpeech({ seconds: 3, seed, leadSec: 0.2, tailSec: 0.2 }).samples, -60, seed);
  const rand = rng(seed);
  for (let k = 0; k < 4; k++) {
    const at = Math.floor(rand() * (x.length - 5000));
    x.fill(0, at, at + Math.floor(rand() * 4000));
  }
  return x;
}

test("EnvelopeStream equals envelopeDb (5 ms hop, 10 ms window) in blocks of 64, 128 and 441", () => {
  for (const [seed, size] of [
    [1, 64],
    [2, 128],
    [3, 441],
  ]) {
    const x = mixedSignal(seed);
    const want = envelopeDb(x, SR, { hopMs: 5, winMs: 10 }).db;
    const env = new EnvelopeStream();
    assert.equal(env.hopMs, 5);
    const got = [];
    let expectFrame0 = 0;
    for (let i = 0; i < x.length; i += size) {
      env.push(x.subarray(i, Math.min(x.length, i + size)));
      if ((i / size) % 7 === 0) {
        assert.equal(env.frame0, expectFrame0, "frame0 is the index of the next frame take() returns");
        const part = env.take();
        expectFrame0 += part.length;
        got.push(...part);
      }
    }
    got.push(...env.take());
    assert.equal(got.length, want.length, `seed ${seed}: frame count`);
    let worst = 0;
    for (let f = 0; f < want.length; f++) worst = Math.max(worst, Math.abs(got[f] - want[f]));
    assert.ok(worst <= 1e-4, `seed ${seed}, blocks of ${size}: worst difference ${worst} dB`);
    assert.equal(env.dropped, 0);
  }
});

test("EnvelopeStream keeps the newest frames when take() comes late, and counts the rest", () => {
  const x = mixedSignal(5);
  const want = envelopeDb(x, SR, { hopMs: 5, winMs: 10 }).db;
  const env = new EnvelopeStream({ capacity: 100 });
  pushAll(env, x);
  const dropped = want.length - 100;
  assert.equal(env.dropped, dropped);
  assert.equal(env.frame0, dropped);
  const got = env.take();
  assert.equal(got.length, 100);
  for (let i = 0; i < 100; i++) near(got[i], want[dropped + i], 1e-4, `frame ${dropped + i}`);
  assert.equal(env.frame0, want.length);
});

test("EnvelopeStream: the window must be a whole number of hops", () => {
  assert.throws(() => new EnvelopeStream({ hopMs: 5, winMs: 7 }), RangeError);
  assert.throws(() => new EnvelopeStream({ hopMs: 10, winMs: 5 }), RangeError);
  const env = new EnvelopeStream({ hopMs: 2, winMs: 10 });
  assert.equal(env.hopMs, 2);
});

// ---------- ToneCheck ----------

test("ToneCheck 1: a clean 120 s tone gives no events, its level and no drift", () => {
  const { t, events } = check(cableTone(120));
  assert.deepEqual(events, []);
  assert.deepEqual(t.counts, { holes: 0, skips: 0, clicks: 0, dropouts: 0, gaps: 0, levels: 0, steps: 0 });
  assert.equal(t.ticks, 0);
  assert.equal(t.locked, true);
  near(t.levelDb, -12, 0.1, "levelDb");
  near(t.lockDb, -12, 0.1, "lockDb");
  near(t.minStableDb, -12, 0.1, "minStableDb");
  assert.ok(Math.abs(t.phaseDriftPpm) < 1, `phaseDriftPpm ${t.phaseDriftPpm}`);
  assert.equal(t.frame, 120 * SR);
});

test("ToneCheck 2: three 480-frame drops are three skips of +112.5°, where they happened", () => {
  let x = cableTone(120, 2);
  const at = [];
  for (const sec of [10.3, 47.9, 81.2]) {
    at.push(Math.round(sec * SR));
    x = dropFrames(x, at[at.length - 1], 480);
  }
  const { t, events } = check(x);
  assert.equal(t.counts.skips, 3);
  assert.equal(t.ticks, 3);
  assert.equal(events.length, 3);
  events.forEach((e, k) => {
    assert.equal(e.kind, "skip");
    assert.ok(Math.abs(e.atFrame - at[k]) <= 1056, `skip ${k} at ${e.atFrame}, drop at ${at[k]}`);
    near(e.phaseStepDeg, 112.5, 5, `skip ${k} phase step`);
  });
});

test("ToneCheck 3: three 480-zero inserts are three holes of 10 ms", () => {
  let x = cableTone(120, 3);
  for (const sec of [10.3, 47.9, 81.2]) x = insertZeros(x, Math.round(sec * SR), 480);
  const { t, events } = check(x);
  assert.equal(t.counts.holes, 3);
  assert.equal(t.ticks, 3);
  assert.deepEqual(
    events.map((e) => e.kind),
    ["hole", "hole", "hole"],
  );
  for (const e of events) near(e.holeMs, 10, 0.5, "holeMs");
});

test("ToneCheck 4: a drop on a block edge, and 3 after or 2 before it, is one skip", () => {
  for (const offset of [0, 3, -2]) {
    const x = dropFrames(cableTone(30, 4), 2000 * B + offset, 480);
    const { t, events } = check(x, { size: 441 });
    assert.equal(t.counts.skips, 1, `offset ${offset}`);
    assert.equal(events.length, 1, `offset ${offset}: ${JSON.stringify(events)}`);
    near(events[0].phaseStepDeg, 112.5, 5, `offset ${offset}`);
  }
});

test("ToneCheck 5: 300 ms of zeros is one gap; 40 ms is one dropout; neither is a tick", () => {
  let { t, events } = check(zeroFill(cableTone(30, 5), 10 * SR, 0.3 * SR));
  assert.equal(t.counts.gaps, 1);
  assert.equal(t.ticks, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "gap");
  near(events[0].holeMs, 300, 1, "gap length");
  near(events[0].atFrame, 10 * SR, 512, "gap start");
  ({ t, events } = check(zeroFill(cableTone(30, 6), 10 * SR, 0.04 * SR)));
  assert.equal(t.counts.dropouts, 1);
  assert.equal(t.ticks, 0);
  assert.equal(events[0].kind, "dropout");
  near(events[0].holeMs, 40, 0.5, "dropout length");
});

test("ToneCheck 5b: a lost tone (no zeros) for 300 ms is a gap too", () => {
  const x = cableTone(30, 7);
  const noise = whiteNoise(0.3 * SR, 8, -70);
  x.set(noise, 10 * SR); // the tone replaced by noise, nothing exactly zero
  const { t, events } = check(x);
  assert.equal(t.counts.gaps, 1, JSON.stringify(events));
  near(events[0].holeMs, 300, 25, "event length");
});

test("ToneCheck 6: a −14 dB ducking ramp is one level event and no tick; an abrupt −2 dB is a step", () => {
  let x = realistic(gainStep(tone({ seconds: 30 }), 10 * SR, -14, SR), 9);
  let { t, events } = check(x);
  assert.equal(t.ticks, 0);
  assert.equal(t.counts.steps, 0);
  assert.equal(t.counts.levels, 1);
  const level = events.find((e) => e.kind === "level");
  near(level.fromDb, -12, 0.5, "fromDb");
  near(level.toDb, -26, 0.5, "toDb");
  near(level.atFrame, 10 * SR, 0.3 * SR, "the change began near the ramp's start");
  near(t.minStableDb, -26, 0.5, "minStableDb");
  near(t.lockDb, -12, 0.1, "lockDb stays");
  near(t.levelDb, -26, 0.2, "levelDb follows");

  // 10 s is half-way through block 937.
  x = realistic(gainStep(tone({ seconds: 30 }), 10 * SR, -2), 10);
  ({ t, events } = check(x));
  assert.equal(t.ticks, 0);
  assert.equal(t.counts.steps, 1);
  assert.equal(t.counts.levels, 1);
  near(events.find((e) => e.kind === "step").stepDb, -2, 0.1, "stepDb");
  near(events.find((e) => e.kind === "level").toDb, -14, 0.2, "toDb");

  // Exactly on a block edge both blocks are clean tone: only the level event tells.
  x = realistic(gainStep(tone({ seconds: 30 }), 938 * B, -2), 10);
  ({ t } = check(x));
  assert.equal(t.ticks, 0);
  assert.equal(t.counts.steps, 0);
  assert.equal(t.counts.levels, 1);
});

test("ToneCheck 6b: a level that comes back before it settles is no level event", () => {
  const x = realistic(gainStep(gainStep(tone({ seconds: 30 }), 10 * SR, -3, 0.2 * SR), 10.3 * SR, 3, 0.2 * SR), 11);
  const { t } = check(x);
  assert.equal(t.counts.levels, 0);
  assert.equal(t.ticks, 0);
  near(t.minStableDb, -12, 0.1, "minStableDb");
});

test("ToneCheck 6c: a tone that drops 26 dB at once and stays there is a step and a new level, not a gap", () => {
  for (const at of [10 * SR, 938 * B]) {
    const x = realistic(gainStep(tone({ seconds: 30 }), at, -26), 20);
    const { t, events } = check(x);
    assert.equal(t.counts.gaps, 0, `at ${at}: ${JSON.stringify(events)}`);
    assert.equal(t.ticks, 0);
    assert.equal(t.counts.steps, 1);
    assert.equal(t.counts.levels, 1);
    near(events.find((e) => e.kind === "step").stepDb, -26, 0.2, "stepDb");
    near(events.find((e) => e.kind === "step").atFrame, at, 512, "step time");
    near(t.levelDb, -38, 0.2, "levelDb follows the new level");
    near(t.minStableDb, -38, 0.3, "minStableDb");
  }
  // A 300 ms dip of 30 dB and back: two steps, no gap, no tick.
  const dip = realistic(gainStep(gainStep(tone({ seconds: 30 }), 10 * SR, -30), 10.3 * SR, 30), 21);
  const { t } = check(dip);
  assert.equal(t.counts.gaps, 0);
  assert.equal(t.ticks, 0);
  assert.equal(t.counts.steps, 2);
  near(t.levelDb, -12, 0.1, "back at −12");
});

test("ToneCheck 7: a +0.2 single-sample spike is one click", () => {
  const { t, events } = check(addSpike(cableTone(30, 12), 10 * SR + 77, 0.2));
  assert.equal(t.counts.clicks, 1);
  assert.equal(t.ticks, 1);
  assert.equal(events[0].kind, "click");
  near(events[0].atFrame, 10 * SR, 512, "click time");
});

test("ToneCheck 8: two drops 62 ms apart are two skips; a drop while priming is nothing", () => {
  let x = dropFrames(cableTone(30, 13), 10 * SR, 480);
  x = dropFrames(x, 10 * SR + 3000, 480);
  let { t } = check(x);
  assert.equal(t.counts.skips, 2);
  ({ t } = check(dropFrames(cableTone(30, 14), Math.round(0.3 * SR), 480)));
  assert.equal(t.ticks, 0);
  assert.deepEqual(t.takeEvents(), []);
});

test("ToneCheck 9: silence, then the tone: locked only after it starts, nothing before; reset() primes again", () => {
  const x = new Float32Array(32 * SR);
  x.set(cableTone(30, 15), 2 * SR);
  const t = new ToneCheck();
  t.push(x.subarray(0, 2 * SR));
  assert.equal(t.locked, false);
  assert.equal(t.levelDb, null);
  assert.equal(t.lockDb, null);
  assert.equal(t.minStableDb, null);
  pushAll(t, x.subarray(2 * SR, 3 * SR));
  assert.equal(t.locked, true);
  pushAll(t, x.subarray(3 * SR));
  assert.deepEqual(t.takeEvents(), []);
  near(t.lockDb, -12, 0.1, "lockDb");

  // After reset() a drop within 0.5 s is not reported; one later is.
  const y = cableTone(10, 16);
  const after = dropFrames(dropFrames(y, Math.round(0.3 * SR), 480), Math.round(5 * SR), 480);
  t.reset();
  assert.equal(t.locked, false);
  pushAll(t, after);
  assert.equal(t.locked, true);
  const events = t.takeEvents();
  assert.equal(events.length, 1, JSON.stringify(events));
  assert.equal(events[0].kind, "skip");
  assert.ok(events[0].atFrame > 32 * SR + 4 * SR, "the later drop, on the global frame count");
  assert.equal(t.counts.skips, 1);
});

test("ToneCheck 10: 600 s pushed in 128-sample blocks takes less than 1.5 s", () => {
  const block = tone({ seconds: B / SR }); // one period: the tone repeats every 512 samples
  const t = new ToneCheck();
  const before = process.cpuUsage(); // CPU time of this process: other processes on a busy machine do not count
  const total = (600 * SR) / B;
  for (let k = 0; k < total; k++) {
    for (let i = 0; i < B; i += 128) t.push(block.subarray(i, i + 128));
  }
  const used = process.cpuUsage(before);
  const ms = (used.user + used.system) / 1000;
  assert.ok(ms < 1500, `${ms.toFixed(0)} ms`);
  assert.equal(t.frame, 600 * SR);
  assert.equal(t.ticks, 0);
  near(t.levelDb, -12, 0.01, "levelDb");
});

test("ToneCheck: at most maxEvents per take, while the counts keep counting", () => {
  let x = cableTone(30, 17);
  for (let k = 0; k < 8; k++) x = insertZeros(x, (5 + 2 * k) * SR, 480);
  const t = new ToneCheck({ maxEvents: 3 });
  pushAll(t, x);
  assert.equal(t.takeEvents().length, 3);
  assert.equal(t.counts.holes, 8);
  assert.equal(t.ticks, 8);
});

test("ToneCheck: NaN samples count as zeros, never as a poisoned level", () => {
  const x = cableTone(20, 18);
  x.fill(NaN, 10 * SR, 10 * SR + 480);
  const { t, events } = check(x);
  assert.equal(t.counts.holes, 1, JSON.stringify(events));
  near(t.levelDb, -12, 0.1, "levelDb");
});

test("ToneCheck: a tone at a frequency offset shows its drift in ppm and no events", () => {
  const ppm = 100;
  const x = realistic(tone({ seconds: 20, hz: TONE_HZ * (1 + ppm * 1e-6) }), 19);
  const { t, events } = check(x);
  assert.deepEqual(events, []);
  near(t.phaseDriftPpm, ppm, 5, "phaseDriftPpm");
});

test("ToneCheck: speech or noise is not taken for the tone", () => {
  const speech = addNoise(synthSpeech({ seconds: 10, seed: 3 }).samples, -60, 3);
  const t = new ToneCheck();
  pushAll(t, speech);
  assert.equal(t.locked, false);
  assert.deepEqual(t.takeEvents(), []);
});

test("signal-watch.js is pure: no clock, timer, console or DOM", () => {
  const code = readFileSync(new URL("../src/core/signal-watch.js", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.doesNotMatch(code, /Date\.now|performance\.|new Date|setTimeout|setInterval|requestAnimationFrame|console\.|document\.|window\.|navigator\.|globalThis/);
  assert.doesNotMatch(code, /^\s*import\b/m, "it is loaded inside AudioWorklets: no imports");
});
