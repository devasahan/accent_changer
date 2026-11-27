import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LIMITS,
  analyzeSpeech,
  classifyZeroRuns,
  clockFromEvents,
  delayVerdict,
  formatClock,
  frameClock,
  gateSummary,
  longVerdict,
  micClock,
  micHoleCount,
  noiseGateOf,
  phaseTimeline,
  renderPauses,
  restartVerdict,
  sampleLag,
  stopAfterHide,
} from "../src/core/cable-check.js";
import { EnvelopeStream, ToneCheck, ZeroRuns } from "../src/core/signal-watch.js";
import { rng, synthSpeech, tone, whiteNoise } from "./helpers/synth.js";

const SR = 48000;
const near = (actual, expected, tol, what) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} is not within ${tol} of ${expected}`);

test("formatClock", () => {
  assert.equal(formatClock(75), "1:15");
  assert.equal(formatClock(3725), "1:02:05");
  assert.equal(formatClock(0), "0:00");
  assert.equal(formatClock(59.9), "0:59");
  assert.equal(formatClock(-3), "0:00");
  assert.equal(formatClock(null), "0:00");
});

test("LIMITS", () => {
  assert.ok(Object.isFrozen(LIMITS));
  assert.equal(LIMITS.TICKS_PER_30_MIN, 6);
  assert.equal(LIMITS.MIN_PHASE_SEC, 1500);
  assert.equal(LIMITS.EXTEND_MAX_SEC, 2100);
});

// ---------- the delay ----------

/** An analyzeRun()-shaped success. */
const run = (delayMs, extra = {}) => ({ ok: true, delayMs, delayScore: 0.8, levelDiffDb: -0.4, ...extra });

test("delayVerdict: the estimate adds the capture latency and the fresh node's buffer", () => {
  let v = delayVerdict(run(60), { captureLatencyMs: 20 });
  assert.equal(v.verdict, "good");
  assert.equal(v.estimateMs, 90);
  assert.equal(v.text, "Delay through VB-CABLE: about 90 ms (± 10). Good.");
  assert.deepEqual(v.notes, []);
  v = delayVerdict(run(60));
  assert.equal(v.estimateMs, 80, "no capture latency known: 10 ms is assumed");
  v = delayVerdict(run(60.04), { captureLatencyMs: 12.3 });
  assert.equal(v.estimateMs, 82.3, "one decimal");
});

test("delayVerdict: good up to 110, borderline up to 130, then slow", () => {
  const at = (estimate) => delayVerdict(run(estimate - 30), { captureLatencyMs: 20 });
  assert.equal(at(110).verdict, "good");
  assert.equal(at(110.1).verdict, "borderline");
  assert.equal(at(110.1).text, "Delay through VB-CABLE: about 110 ms (± 10). Close to the limit: send me the results.");
  assert.equal(at(130).verdict, "borderline");
  assert.equal(at(130.1).verdict, "slow");
  assert.equal(at(150).text, "Delay through VB-CABLE: about 150 ms (± 10). Too slow.");
});

test("delayVerdict: unclear, silent microphone, silent cable", () => {
  let v = delayVerdict(run(60, { delayScore: 0.29 }));
  assert.equal(v.verdict, "unclear");
  assert.equal(v.estimateMs, null);
  assert.equal(v.text, "Could not measure clearly (match 0.29). Speak a bit louder, closer to the microphone, and try again.");
  v = delayVerdict({ ok: false, reason: "the recording is silent" });
  assert.equal(v.verdict, "silent-mic");
  assert.equal(v.text, "Your microphone stayed silent: say “pa-ta-ka” during the 12 seconds.");
  v = delayVerdict({ ok: false, reason: "no converted audio came back" });
  assert.equal(v.verdict, "silent-cable");
  assert.equal(v.text, "“CABLE Output” stayed silent: your voice isn't reaching VB-CABLE.");
  assert.equal(delayVerdict(null).verdict, "unclear");
  assert.equal(delayVerdict({ ok: false, reason: "something else" }).verdict, "unclear");
  assert.equal(delayVerdict(run(60, { delayScore: 0.3 })).verdict, "good", "a match of exactly 0.3 is enough");
});

test("delayVerdict: notes for a quiet cable and for a microphone buffer that grew", () => {
  let v = delayVerdict(run(60, { levelDiffDb: -6.24 }));
  assert.deepEqual(v.notes, [
    "The voice arrives 6.2 dB quieter in CABLE Output. In Windows sound settings (Windows key + R, type mmsys.cpl, Enter): Communications tab → “Do nothing”; Playback → CABLE Input and Recording → CABLE Output → Properties → Levels → 100.",
  ]);
  assert.deepEqual(delayVerdict(run(60, { levelDiffDb: -2.9 })).notes, []);
  v = delayVerdict(run(60), { micFifoMs: 25 });
  assert.deepEqual(v.notes, [
    "25 ms of this delay built up in the microphone's buffer since the app started (its clock runs faster than VB-CABLE's).",
  ]);
  assert.deepEqual(delayVerdict(run(60), { micFifoMs: 19 }).notes, []);
  assert.deepEqual(delayVerdict(run(60), { micFifoMs: null }).notes, []);
});

// ---------- sampleLag ----------

/** `x` shifted so that out[n] = x[n − lag] (zeros where that falls outside). */
function shifted(x, lag) {
  const out = new Float32Array(x.length);
  for (let n = 0; n < x.length; n++) {
    const m = n - lag;
    out[n] = m >= 0 && m < x.length ? x[m] : 0;
  }
  return out;
}

test("sampleLag finds the exact lag between two copies of the same room noise", () => {
  const ref = whiteNoise(SR, 11, -60);
  let r = sampleLag(ref, shifted(ref, 1234));
  assert.equal(r.lagFrames, 1234);
  near(r.lagMs, 1234 / 48, 1e-9, "lagMs");
  assert.ok(r.score > 0.99, `score ${r.score}`);
  r = sampleLag(ref, shifted(ref, -300));
  assert.equal(r.lagFrames, -300);
  r = sampleLag(ref, ref);
  assert.equal(r.lagFrames, 0);
});

test("sampleLag: null for digital silence, unrelated signals, or arrays too short", () => {
  assert.equal(sampleLag(new Float32Array(SR), new Float32Array(SR)), null);
  assert.equal(sampleLag(whiteNoise(SR, 1, -60), whiteNoise(SR, 2, -60)), null);
  const short = whiteNoise(960 + 5760 + 4800 - 1, 3, -60);
  assert.equal(sampleLag(short, short), null);
  const enough = whiteNoise(960 + 5760 + 4800, 3, -60);
  assert.equal(sampleLag(enough, enough).lagFrames, 0);
});

test("sampleLag on 1 s arrays takes less than 200 ms", () => {
  const ref = whiteNoise(SR, 5, -60);
  const sig = shifted(ref, 2400);
  // CPU time of this process, the best of three: other processes on a busy machine do not count.
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    const before = process.cpuUsage();
    const r = sampleLag(ref, sig);
    const used = process.cpuUsage(before);
    best = Math.min(best, (used.user + used.system) / 1000);
    assert.equal(r.lagFrames, 2400);
  }
  assert.ok(best < 200, `${best.toFixed(0)} ms`);
});

// ---------- zero runs ----------

test("micHoleCount: 8 to 11 ms runs only", () => {
  const runs = [384, 480, 528, 383, 529, 4800, 48].map((frames, k) => ({ startFrame: k * 10000, frames }));
  assert.equal(micHoleCount(runs), 3);
  assert.equal(micHoleCount([]), 0);
  assert.equal(micHoleCount(null), 0);
  assert.equal(micHoleCount([{ startFrame: 0, frames: 80 }], { sampleRate: 8000 }), 1, "10 ms at 8 kHz");
});

test("classifyZeroRuns: the microphone's own silence explains CABLE Output's; the rest are drop-outs", () => {
  const ms = (x) => (x * SR) / 1000;
  const ref = [
    { startFrame: ms(1000), frames: ms(10) },
    { startFrame: ms(5000), frames: ms(300) },
  ];
  const sig = [
    { startFrame: ms(1040), frames: ms(10) }, // the mic's hole, 40 ms later
    { startFrame: ms(3000), frames: ms(10) }, // nothing on the mic: a drop-out
    { startFrame: ms(5045), frames: ms(303) }, // the mic's silence, 3 ms longer
    { startFrame: ms(9000), frames: ms(10) }, // too late after any mic run
  ];
  const r = classifyZeroRuns(ref, sig);
  assert.deepEqual(r.explained, [sig[0], sig[2]]);
  assert.deepEqual(r.dropouts, [sig[1], sig[3]]);
  assert.deepEqual(r.micHoles, [ref[0]]);
  assert.deepEqual(r.micSilent, [ref[1]]);
  const late = classifyZeroRuns([{ startFrame: 0, frames: 480 }], [{ startFrame: ms(301), frames: 480 }]);
  assert.equal(late.dropouts.length, 1, "more than 300 ms after the mic's run");
  const longer = classifyZeroRuns([{ startFrame: 0, frames: 480 }], [{ startFrame: 480, frames: 480 + ms(6) }]);
  assert.equal(longer.dropouts.length, 1, "6 ms longer than the mic's run");
  assert.deepEqual(classifyZeroRuns(null, undefined), { dropouts: [], micHoles: [], micSilent: [], explained: [] });
});

test("classifyZeroRuns: a mic run at the same frame, or exactly 5 ms shorter, explains CABLE Output's", () => {
  const ms = (x) => (x * SR) / 1000;
  assert.equal(classifyZeroRuns([{ startFrame: 1000, frames: 480 }], [{ startFrame: 1000, frames: 480 }]).explained.length, 1, "lag 0");
  const slack = classifyZeroRuns([{ startFrame: 0, frames: 480 }], [{ startFrame: ms(40), frames: 480 + ms(5) }]);
  assert.equal(slack.explained.length, 1, "5 ms longer");
  const over = classifyZeroRuns([{ startFrame: 0, frames: 480 }], [{ startFrame: ms(40), frames: 480 + ms(5) + 1 }]);
  assert.equal(over.dropouts.length, 1, "one frame more");
});

// ---------- the microphone's clock ----------

/** Readings every 120 s for 60 min of lag(t) plus seeded uniform ± 10 ms. */
function readings(lagAt, seed, { micGen = 1, every = 120, minutes = 60 } = {}) {
  const rand = rng(seed);
  const out = [];
  for (let t = 0; t <= minutes * 60; t += every) out.push({ atSec: t, lagMs: lagAt(t) + (rand() * 2 - 1) * 10, micGen });
  return out;
}

/**
 * The passthrough's buffer as H1 has it, less a fresh source's own 10 ms: d0 ms when its source was made (ageSec
 * before the first reading), then ppm/1000 ms more per second up to `top`, then a 10 ms drop each time it gets
 * there (a saw-tooth just below top). A 60 ms buffer: it rises only 30 to 50 ms before it drops.
 */
const h1 = (ppm, { d0 = 10, top = 55, ageSec = 0 } = {}) => (t) => {
  const x = d0 + (ppm / 1000) * (t + ageSec);
  return (x <= top ? x : top - 10 + ((x - top) % 10)) - 10;
};

test("micClock: a microphone 20 ppm faster fills its buffer, then saturates", () => {
  const r = micClock(readings((t) => Math.min(60, 10 + 0.02 * t), 101), { holes: 0, durationSec: 3600 });
  assert.equal(r.direction, "faster");
  // 25 ms above its start at about 1250 s; each reading has ± 10 ms.
  assert.ok(r.saturatedAtSec >= 750 && r.saturatedAtSec <= 1750, `saturatedAtSec ${r.saturatedAtSec}`);
  near(r.ppm, 20, 8, "ppm");
  assert.equal(r.ppmIsLowerBound, false);
  assert.ok(r.dropsPer30Min <= 6, `dropsPer30Min ${r.dropsPer30Min}`);
  near(r.dropsPer30Min, r.ppm * 0.18, 1e-9, "dropsPer30Min");
  assert.equal(r.holesPer30Min, 0);
  assert.equal(r.ticksPer30Min, r.dropsPer30Min);
  assert.equal(r.readings.length, 31);
  assert.deepEqual(Object.keys(r.readings[0]), ["atSec", "lagMs"]);
});

test("micClock: 80 ppm faster is too many drops", () => {
  const r = micClock(readings((t) => Math.min(55, 10 + 0.08 * t), 102), { durationSec: 3600 });
  assert.equal(r.direction, "faster");
  assert.ok(r.ppm >= 45, `ppm ${r.ppm}`);
  assert.ok(r.dropsPer30Min > 6, `dropsPer30Min ${r.dropsPer30Min}`);
});

test("micClock: a buffer full within minutes gives a lower bound", () => {
  const r = micClock(readings((t) => Math.min(50, 10 + 0.2 * t), 103), { durationSec: 3600 });
  assert.ok(r.saturatedAtSec <= 480, `saturatedAtSec ${r.saturatedAtSec}`);
  assert.equal(r.ppmIsLowerBound, true);
  assert.ok(r.ppm >= 80, `ppm ${r.ppm}`);
  assert.equal(r.direction, "faster");
});

test("micClock: a slower microphone shows by its holes", () => {
  const r = micClock(readings(() => 20, 104), { holes: 12, durationSec: 3600 });
  assert.equal(r.direction, "slower");
  near(r.ppm, -33.3, 0.1, "ppm");
  assert.equal(r.ppmIsLowerBound, false);
  assert.equal(r.holesPer30Min, 6);
  assert.equal(r.dropsPer30Min, 0);
  assert.equal(r.ticksPer30Min, 6);
  assert.equal(r.saturatedAtSec, null);
});

test("micClock: the same clock, no holes", () => {
  const r = micClock(readings(() => 20, 105), { holes: 0, durationSec: 3600 });
  assert.ok(Math.abs(r.ppm) < 5, `ppm ${r.ppm}`);
  assert.equal(r.direction, "same");
  assert.ok(r.ticksPer30Min < 1);
});

test("micClock: only the longest run of one microphone source is used", () => {
  const first = readings((t) => 10 + 0.02 * t, 106, { micGen: 1, minutes: 20 }); // 11 readings
  const second = readings(() => 15, 107, { micGen: 2, minutes: 30 }).map((s) => ({ ...s, atSec: s.atSec + 1300 })); // 16 readings
  const r = micClock([...first, ...second], { durationSec: 3100 });
  assert.equal(r.readings.length, 16);
  assert.equal(r.readings[0].atSec, 1300);
  assert.ok(Math.abs(r.ppm) < 5, `ppm ${r.ppm}: the flat second run, not the rising first one`);
});

test("micClock: the buffer counts as full once readings stay 25 ms above its start; one high reading does not", () => {
  const at = (lags) => lags.map((lagMs, k) => ({ atSec: k * 120, lagMs, micGen: 1 }));
  const flat = [10, 10, 10, 10, 10, 10];
  assert.equal(micClock(at([...flat, 50, 10, 10, 10, 10]), { durationSec: 1320 }).saturatedAtSec, null, "one reading 40 ms up");
  assert.equal(micClock(at([...flat, 34.9, 34.9, 34.9, 34.9, 34.9]), { durationSec: 1320 }).saturatedAtSec, null, "24.9 ms up");
  assert.equal(micClock(at([...flat, 35, 35, 35, 35, 35]), { durationSec: 1320 }).saturatedAtSec, 720, "25 ms up");
  assert.equal(micClock(at([...flat, 35, 10, 35, 35, 35]), { durationSec: 1320 }).saturatedAtSec, 720, "from the first high reading");
});

test("micClock: a slope needs 4 readings over 600 s or more", () => {
  const flat = (times) => times.map((atSec) => ({ atSec, lagMs: 20, micGen: 1 }));
  assert.equal(micClock(flat([0, 120, 240, 360, 480]), { durationSec: 600 }).ppm, null, "5 readings over 480 s");
  assert.equal(micClock(flat([0, 300, 600]), { durationSec: 600 }).ppm, null, "3 readings over 600 s");
  const enough = micClock(flat([0, 200, 400, 600]), { durationSec: 600 });
  assert.equal(enough.ppm, 0);
  assert.equal(enough.direction, "same");
});

test("micClock: the lower bound counts from the first reading of the microphone source in use", () => {
  // A rebuild made a new microphone source at about 1300 s; its buffer was full 240 s later.
  const first = [2, 122, 242].map((atSec) => ({ atSec, lagMs: 12, micGen: 1 }));
  const second = [10, 10, 50, 50, 50, 50, 50].map((lagMs, k) => ({ atSec: 1300 + k * 120, lagMs, micGen: 2 }));
  const r = micClock([...first, ...second], { durationSec: 2100 });
  assert.equal(r.saturatedAtSec, 1540);
  assert.equal(r.ppmIsLowerBound, true);
  near(r.ppm, (25 / 240) * 1000, 1e-9, "25 ms in 240 s, not in 1540 s");
});

test("micClock (H1): a microphone 50 ppm faster fails, whatever its buffer held when its source was made", () => {
  // 9 drops per 30 minutes. Its buffer rises 35 to 45 ms before it drops: never 40 ms above a base that already rose.
  for (const d0 of [0, 10, 20]) {
    for (const seed of [201, 202, 203]) {
      const r = micClock(readings(h1(50, { d0 }), seed, { minutes: 65 }), { holes: 0, durationSec: 3900 });
      assert.equal(r.direction, "faster", `d0 ${d0} seed ${seed}: ${JSON.stringify({ ...r, readings: undefined })}`);
      assert.ok(r.ticksPer30Min > 6, `d0 ${d0} seed ${seed}: ticksPer30Min ${r.ticksPer30Min}`);
    }
  }
});

test("micClock (H1): a microphone 400 ppm faster, its buffer full within two minutes, fails with a lower bound", () => {
  for (const seed of [211, 212, 213]) {
    const r = micClock(readings(h1(400), seed, { minutes: 65 }), { holes: 0, durationSec: 3900 });
    assert.equal(r.direction, "faster", `seed ${seed}`);
    assert.equal(r.ppmIsLowerBound, true, `seed ${seed}`);
    assert.ok(r.saturatedAtSec <= 240 && r.ticksPer30Min > 6, `seed ${seed}: ${r.saturatedAtSec} ${r.ticksPer30Min}`);
  }
});

test("micClock (H1): a buffer that had filled before the readings began is not measured, never “the same clock”", () => {
  // 50 ppm faster, its source made 20 minutes before the check: full and dropping from the first reading.
  const faster = micClock(readings(h1(50, { ageSec: 1200 }), 221, { minutes: 65 }), { holes: 0, durationSec: 3900 });
  // The same clock, its buffer filled while rendering paused (setSinkId at the start): just as full, just as flat.
  const paused = micClock(readings(h1(0, { d0: 52 }), 222, { minutes: 65 }), { holes: 0, durationSec: 3900 });
  for (const r of [faster, paused]) {
    assert.equal(r.fullAtStart, true);
    assert.equal(r.saturatedAtSec, null);
    assert.equal(r.ppm, null);
    assert.equal(r.slopePpm, null);
    assert.equal(r.direction, null);
  }
  // Holes still tell a slower clock.
  const slower = micClock(readings(() => 42, 223), { holes: 12, durationSec: 3600 });
  assert.equal(slower.fullAtStart, true);
  assert.equal(slower.direction, "slower");
  near(slower.ppm, -33.3, 0.1, "ppm from the holes");
});

test("micClock (H1): the same clock, its buffer empty at the start, never counts as full", () => {
  for (let seed = 231; seed <= 240; seed++) {
    for (const d0 of [0, 10, 20]) {
      const r = micClock(readings(h1(0, { d0 }), seed, { minutes: 65 }), { holes: 0, durationSec: 3900 });
      assert.equal(r.saturatedAtSec, null, `seed ${seed} d0 ${d0}`);
      assert.equal(r.fullAtStart, false, `seed ${seed} d0 ${d0}`);
      assert.equal(r.direction, "same", `seed ${seed} d0 ${d0}: ppm ${r.ppm}`);
      assert.ok(r.ticksPer30Min < 1, `seed ${seed} d0 ${d0}: ${r.ticksPer30Min}`);
    }
  }
});

test("micClock: three readings say nothing", () => {
  const r = micClock(readings(() => 20, 108, { minutes: 4 }), { holes: 0, durationSec: 240 });
  assert.equal(r.readings.length, 3);
  assert.equal(r.ppm, null);
  assert.equal(r.direction, null);
  assert.equal(r.ticksPer30Min, 0);
  assert.equal(micClock([], { durationSec: 0 }).direction, null);
  assert.equal(micClock(null).ppm, null);
});

test("micClock: the buffer's slope is kept when the holes take over ppm and direction", () => {
  // Flat over 60 minutes, with 12 holes: "slower" by the holes, and the slope that said "not faster" kept.
  const r = micClock(readings(() => 20, 104), { holes: 12, durationSec: 3600 });
  assert.equal(r.direction, "slower");
  near(r.ppm, -33.3, 0.1, "ppm from the holes");
  assert.ok(Math.abs(r.slopePpm) < 5, `slopePpm ${r.slopePpm}`);
  assert.equal(r.slopeIsLowerBound, false);
  // A lower bound stays one.
  const bound = micClock(readings((t) => Math.min(100, 10 + 0.2 * t), 103), { holes: 2, durationSec: 3600 });
  assert.equal(bound.direction, "faster");
  assert.equal(bound.slopePpm, bound.ppm);
  assert.equal(bound.slopeIsLowerBound, true);
  // Too few readings: no slope, whatever the holes say.
  const few = micClock(readings(() => 20, 108, { minutes: 4 }), { holes: 2, durationSec: 240 });
  assert.equal(few.direction, "slower");
  assert.equal(few.slopePpm, null);
  assert.equal(few.slopeIsLowerBound, false);
});

// ---------- time ----------

/** Sync points one per second (48000 frames), produced on time; `tweak(i, p)` changes point i. */
function points(n, tweak = () => {}, { jitterMs = 10, seed = 7 } = {}) {
  const rand = rng(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = { frame: i * SR, producedMs: 5000 + i * 1000 + (rand() * 2 - 1) * jitterMs };
    p.wallMs = p.producedMs + 2 + rand() * 5;
    tweak(i, p);
    out.push(p);
  }
  return out;
}

test("frameClock maps frames to page time between and beyond the sync points", () => {
  const clock = frameClock([
    { frame: 0, producedMs: 1000, wallMs: 1500 },
    { frame: 48000, producedMs: 2000, wallMs: 9000 },
    { frame: 96000, wallMs: 3100 },
  ]);
  assert.equal(clock.toWallMs(0), 1000);
  assert.equal(clock.toWallMs(24000), 1500, "producedMs, not the late wallMs");
  assert.equal(clock.toWallMs(72000), 2550, "a point without producedMs uses wallMs");
  assert.equal(clock.toWallMs(-4800), 900, "48 frames per ms before the first point");
  assert.equal(clock.toWallMs(96000 + 480), 3110, "and after the last");
  assert.equal(frameClock([]).toWallMs(10), null);
});

test("renderPauses: on-time points with jitter → none", () => {
  const r = renderPauses(points(400));
  assert.deepEqual(r.pauses, []);
  assert.equal(r.late.count, 0);
});

test("renderPauses: one point delivered 800 ms late is late, not a pause", () => {
  const r = renderPauses(points(400, (i, p) => i === 200 && (p.wallMs = p.producedMs + 800)));
  assert.deepEqual(r.pauses, []);
  assert.equal(r.late.count, 1);
  near(r.late.maxMs, 800, 1, "maxMs");
});

test("renderPauses: a 20 s main-thread stall, then a once-a-minute window, are no pauses", () => {
  // 20 points arrive together at the end of the stall (lateness 20 s … 1 s), produced on time.
  let r = renderPauses(points(100, (i, p) => i >= 40 && i < 60 && (p.wallMs = 5000 + 60 * 1000)));
  assert.deepEqual(r.pauses, []);
  assert.equal(r.late.count, 20);
  near(r.late.maxMs, 20000, 15, "maxMs");
  // Delivered once a minute for 10 minutes (a deprioritised hidden window).
  r = renderPauses(points(600, (i, p) => (p.wallMs = 5000 + Math.ceil((i + 1) / 60) * 60000)));
  assert.deepEqual(r.pauses, []);
  assert.ok(r.late.count > 500);
});

test("renderPauses: a real pause shifts every later point by its length", () => {
  const r = renderPauses(points(100, (i, p) => i >= 40 && ((p.producedMs += 500), (p.wallMs += 500))));
  assert.equal(r.pauses.length, 1);
  assert.equal(r.pauses[0].index, 40);
  assert.equal(r.pauses[0].atFrame, 40 * SR);
  near(r.pauses[0].ms, 500, 20, "pause length");
  assert.equal(r.late.count, 0);
});

test("renderPauses: one odd stamp (a clock adjustment) and slow drift are no pauses", () => {
  let r = renderPauses(points(100, (i, p) => i === 50 && (p.producedMs += 1000)));
  assert.deepEqual(r.pauses, []);
  // 50 ppm between the audio clock and the system clock: 3900 points.
  r = renderPauses(points(3900, (i, p) => (p.producedMs += i * 1000 * 50e-6), { jitterMs: 3 }));
  assert.deepEqual(r.pauses, []);
  assert.deepEqual(renderPauses([]), { pauses: [], late: { count: 0, maxMs: 0 } });
});

test("renderPauses: at either end of the list one odd stamp is no pause, a real pause is", () => {
  const odd = (k, ms) => (i, p) => i === k && (p.producedMs += ms);
  for (const [k, ms] of [
    [0, -1000],
    [1, 1000],
    [98, 1000],
    [99, 1000],
  ]) {
    assert.deepEqual(renderPauses(points(100, odd(k, ms))).pauses, [], `odd stamp at point ${k}`);
  }
  // A real pause delays the delivery too.
  const paused = (from) => (i, p) => i >= from && ((p.producedMs += 500), (p.wallMs += 500));
  for (const from of [1, 98, 99]) {
    const r = renderPauses(points(100, paused(from)));
    assert.equal(r.pauses.length, 1, `a pause before point ${from}`);
    assert.equal(r.pauses[0].index, from);
    near(r.pauses[0].ms, 500, 20, "pause length");
  }
});

/**
 * Sync points one per second (a summary every 48000 frames, made 3 ms after each second), as measure.js maps
 * them: producedMs = the worklet's Date.now() stamp − (Date.now() − performance.now() read when the message
 * arrives). The system clock steps by `stepMs` at `atMs` on the page's timeline (a time sync), so a summary made
 * before the step and read after it gets a stamp `stepMs` off. `arrive(madeMs)` says when each one arrives.
 */
function steppedClock({ stepMs, atMs = 200500, n = 400, arrive }) {
  const epoch = (perf) => 1.7e12 + perf + (perf >= atMs ? stepMs : 0);
  return Array.from({ length: n }, (_, i) => {
    const made = 1000 * (i + 1) + 3;
    const wallMs = arrive(made);
    return { frame: SR * (i + 1), producedMs: epoch(made) - (epoch(wallMs) - wallMs), wallMs };
  });
}
const oddStamps = (pts) => pts.filter((p, i) => Math.abs(p.producedMs - (1000 * (i + 1) + 3)) > 1).length;

test("renderPauses: a clock step while messages are seconds late moves several stamps, and is no pause", () => {
  for (const lateMs of [800, 1500, 2500, 6000]) {
    for (const stepMs of [-1000, 1000, -5000]) {
      // Messages `lateMs` late from 190 s to 210 s (a hidden window), on time otherwise.
      const pts = steppedClock({ stepMs, arrive: (made) => made + (made > 190000 && made < 210000 ? lateMs : 20) });
      assert.ok(oddStamps(pts) >= Math.floor(lateMs / 1000), `${oddStamps(pts)} odd stamps`);
      assert.deepEqual(renderPauses(pts).pauses, [], `${lateMs} ms late, the clock ${stepMs} ms`);
    }
  }
  // Late only while the stamps were on their way: the main thread stalled from 197.5 s to just after the step,
  // so three summaries arrive together, stamped 5 s late, while their neighbours arrived on time.
  const burst = steppedClock({ stepMs: -5000, arrive: (made) => (made > 197500 && made < 200500 ? 200600 : made + 20) });
  assert.equal(oddStamps(burst), 3);
  assert.deepEqual(renderPauses(burst).pauses, []);
});

test("renderPauses: a real pause is still found while messages are seconds late around it", () => {
  // The context stopped for 500 ms before point 200; messages 5 s late from point 190 to 214.
  const late = (i, p) => {
    if (i >= 200) p.producedMs += 500;
    p.wallMs = p.producedMs + (i >= 190 && i < 215 ? 5000 : 5);
  };
  let r = renderPauses(points(400, late));
  assert.equal(r.pauses.length, 1);
  assert.equal(r.pauses[0].index, 200);
  near(r.pauses[0].ms, 500, 20, "pause length");
  // And one in the last seconds of the list, delivered on time: the delivery steps too.
  r = renderPauses(points(100, (i, p) => i >= 97 && ((p.producedMs += 700), (p.wallMs += 700))));
  assert.deepEqual(r.pauses.map((x) => x.index), [97]);
});

test("phaseTimeline: visible, minimized polls, a Hide ended early by a visible poll, Edge's visibility marks", () => {
  const t = phaseTimeline([
    { atMs: 1000, visible: true, minimized: false, focused: true },
    { atMs: 5000, visible: true, minimized: true, focused: false },
    { atMs: 9000, visible: true, minimized: false },
    { atMs: 10000, hiddenByApp: true, untilMs: 30000 },
    { atMs: 15000, visible: false, minimized: false },
    { atMs: 20000, note: "default-output-changed" },
    { atMs: 25000, visible: true, minimized: false }, // the user brought it back early
    { atMs: 40000, visibility: "hidden" },
    { atMs: 45000, visibility: "visible" },
  ]);
  assert.equal(t.phaseAt(500), "unknown");
  assert.equal(t.phaseAt(1000), "visible");
  assert.equal(t.phaseAt(6000), "minimized");
  assert.equal(t.phaseAt(9500), "visible");
  assert.equal(t.phaseAt(10000), "hidden");
  assert.equal(t.phaseAt(12000), "hidden", "the Hide is active before any poll says so");
  assert.equal(t.phaseAt(24999), "hidden");
  assert.equal(t.phaseAt(25000), "visible", "a visible poll ends the Hide early");
  assert.equal(t.phaseAt(41000), "hidden", "Edge: a visibility mark");
  assert.equal(t.phaseAt(46000), "visible");
  const s = t.spans(0, 50000);
  assert.deepEqual(s, { visibleSec: 4 + 1 + 15 + 5, minimizedSec: 4, hiddenSec: 15 + 5, unknownSec: 1 });
  const sum = s.visibleSec + s.minimizedSec + s.hiddenSec + s.unknownSec;
  assert.equal(sum, 50, "the spans add up to the interval");
  assert.deepEqual(t.spans(12000, 13500), { visibleSec: 0, minimizedSec: 0, hiddenSec: 1.5, unknownSec: 0 });
  assert.deepEqual(t.spans(5, 5), { visibleSec: 0, minimizedSec: 0, hiddenSec: 0, unknownSec: 0 });
});

test("phaseTimeline: a Hide runs until untilMs; polls that say hidden keep it hidden", () => {
  const t = phaseTimeline([
    { atMs: 0, visible: true, minimized: false },
    { atMs: 1000, hiddenByApp: true, untilMs: 61000 },
    { atMs: 2000, visible: false, minimized: false },
    { atMs: 70000, visible: true, minimized: false },
  ]);
  assert.equal(t.phaseAt(60999), "hidden");
  assert.equal(t.phaseAt(65000), "hidden", "the last poll still says not visible");
  assert.equal(t.phaseAt(70000), "visible");
  assert.deepEqual(t.spans(0, 80000), { visibleSec: 11, minimizedSec: 0, hiddenSec: 69, unknownSec: 0 });
  assert.equal(phaseTimeline([]).phaseAt(5), "unknown");
  assert.deepEqual(phaseTimeline(null).spans(0, 1000), { visibleSec: 0, minimizedSec: 0, hiddenSec: 0, unknownSec: 1 });
});

test("stopAfterHide: never before the planned end, 2 min after the Hide, capped", () => {
  assert.equal(stopAfterHide({ plannedEndSec: 3900, hideEndSec: 3720 }), 3900);
  assert.equal(stopAfterHide({ plannedEndSec: 3900, hideEndSec: 3900 }), 4020);
  assert.equal(stopAfterHide({ plannedEndSec: 3900, hideEndSec: 6000 }), 3900 + 2100);
  assert.equal(stopAfterHide({ plannedEndSec: 15, hideEndSec: 8, tailSec: 120, maxEndSec: 1000 }), 128);
  assert.equal(stopAfterHide({ plannedEndSec: 3900, hideEndSec: 3900, maxEndSec: 3960 }), 3960, "maxEndSec caps it");
});

test("stopAfterHide: without a usable hide end there is no extension, and never NaN", () => {
  assert.equal(stopAfterHide({ plannedEndSec: 3900 }), 3900);
  for (const hideEndSec of [NaN, null, Infinity, "3900"]) assert.equal(stopAfterHide({ plannedEndSec: 3900, hideEndSec }), 3900, String(hideEndSec));
  assert.equal(stopAfterHide({ plannedEndSec: 3900, hideEndSec: 3900, tailSec: NaN }), 3900);
  assert.equal(stopAfterHide({ plannedEndSec: 3900, hideEndSec: 3900, maxEndSec: NaN }), 4020);
  assert.equal(stopAfterHide({ hideEndSec: 3900 }), null, "nothing planned");
  assert.equal(stopAfterHide(), null);
});

// ---------- mic mode ----------

const CHUNK = 12 * SR;

/** Five 12 s takes of synthetic speech with a −70 dBFS noise floor, played in a loop. */
const TAKES = Array.from({ length: 5 }, (_, k) => {
  const s = synthSpeech({ seconds: 12, seed: k + 1, leadSec: 0.3, tailSec: 0.5 });
  const noise = whiteNoise(s.samples.length, 50 + k, -70);
  const samples = s.samples.map((v, i) => v + noise[i]);
  return { samples, utterances: s.utterances };
});
/** Copy the looped takes from sample `from` (may be negative) into `out`. */
function copySpeech(out, from) {
  let done = 0;
  while (done < out.length) {
    const n = from + done;
    const k = Math.floor(n / CHUNK);
    const offset = n - k * CHUNK;
    const take = TAKES[((k % 5) + 5) % 5].samples;
    const count = Math.min(out.length - done, CHUNK - offset);
    out.set(take.subarray(offset, offset + count), done);
    done += count;
  }
}

/**
 * Envelopes and zero runs of the microphone (ref) and CABLE Output (sig) for
 * a mic-mode check: sig is the speech `lagMs` later, 10 ms later still at
 * every step (steps fall on 100 ms blocks), `extraMs` later still from
 * `fromSec` to `toSec` for each of `shifts` ([fromSec, toSec, extraMs]), with
 * `holes` ([atSec, ms] in CABLE Output's time) of zeros.
 */
function micRun({ seconds, lagMs = 40, stepEverySec = 0, holes = [], shifts = [] }) {
  const total = seconds * SR;
  const env = () => new EnvelopeStream({ capacity: (total / 240) | 0 });
  const refEnv = env();
  const sigEnv = env();
  const refZero = new ZeroRuns({ maxRuns: 1000 });
  const sigZero = new ZeroRuns({ maxRuns: 1000 });
  const ref = new Float32Array(4800);
  const sig = new Float32Array(4800);
  const cuts = holes.map(([at, ms]) => [Math.round(at * SR), Math.round(at * SR + (ms * SR) / 1000)]);
  for (let start = 0; start < total; start += 4800) {
    let lag = Math.round((lagMs * SR) / 1000) + (stepEverySec ? 480 * Math.floor(start / (stepEverySec * SR)) : 0);
    for (const [from, to, extraMs] of shifts) if (start >= from * SR && start < to * SR) lag += Math.round((extraMs * SR) / 1000);
    copySpeech(ref, start);
    copySpeech(sig, start - lag);
    for (const [a, b] of cuts) if (a < start + 4800 && b > start) sig.fill(0, Math.max(0, a - start), Math.min(4800, b - start));
    refEnv.push(ref);
    sigEnv.push(sig);
    refZero.push(ref);
    sigZero.push(sig);
  }
  return { refDb: refEnv.take(), sigDb: sigEnv.take(), refRuns: refZero.takeRuns(), sigRuns: sigZero.takeRuns() };
}

test("analyzeSpeech: 10 min with +10 ms steps every 60 s has no gaps", () => {
  const r = analyzeSpeech(micRun({ seconds: 600, stepEverySec: 60 }));
  assert.deepEqual(r.gaps, []);
  assert.deepEqual(r.dropouts, []);
  assert.ok(r.lagMs >= 40 && r.lagMs <= 140, `lagMs ${r.lagMs}`);
  assert.ok(r.lagScore > 0.5, `lagScore ${r.lagScore}`);
  assert.ok(r.speechSec > 200, `speechSec ${r.speechSec}`);
  assert.equal(r.micHoles, 0);
  assert.equal(r.micSilentSec, 0);
});

/** A point in the middle of a long utterance of the first take (seconds from the start). */
const inSpeech = (() => {
  const u = TAKES[0].utterances.find((x) => x.end - x.start > 1);
  return u.start + 0.3;
})();
/** A point in the middle of a pause of the first take. */
const inPause = (() => {
  const us = TAKES[0].utterances;
  const i = us.findIndex((u, k) => k + 1 < us.length && us[k + 1].start - u.end > 0.6);
  return (us[i].end + us[i + 1].start) / 2;
})();

test("analyzeSpeech: a 300 ms hole in speech is one gap, where it was", () => {
  const at = 60 + inSpeech + 0.04; // the fifth loop of the takes, in CABLE Output's time (40 ms later)
  const r = analyzeSpeech(micRun({ seconds: 120, holes: [[at, 300]] }));
  assert.equal(r.gaps.length, 1, JSON.stringify(r.gaps));
  // ± 20 ms: here the hole cuts a syllable 20 ms after it began, and findGaps counts that short start (under 30 ms) as part of the hole.
  near(r.gaps[0].atSec, at - 0.04, 0.0201, "the gap, in the microphone's time");
  assert.equal(r.dropouts.length, 1, "the zero run too");
  near(r.dropouts[0].ms, 300, 0.1, "dropout length");
  near(r.lagMs, 40, 2, "lagMs");
});

test("analyzeSpeech: a hole in a pause is no gap, but a drop-out", () => {
  const at = 60 + inPause - 0.15 + 0.04;
  const r = analyzeSpeech(micRun({ seconds: 120, holes: [[at, 300]] }));
  assert.deepEqual(r.gaps, []);
  assert.equal(r.dropouts.length, 1);
  assert.equal(r.dropouts[0].startFrame, Math.round(at * SR));
  near(r.dropouts[0].ms, 300, 0.1, "dropout length");
});

test("analyzeSpeech: no speech → only the zero runs; the microphone's own silence is told apart", () => {
  const quiet = whiteNoise(SR * 4, 3, -70);
  const env = new EnvelopeStream({ capacity: 1000 });
  env.push(quiet);
  const db = env.take();
  const refRuns = [{ startFrame: SR, frames: SR / 2 }];
  const sigRuns = [
    { startFrame: SR + 2400, frames: SR / 2 },
    { startFrame: 3 * SR, frames: 480 },
  ];
  const r = analyzeSpeech({ refDb: db, sigDb: db, refRuns, sigRuns });
  assert.equal(r.lagMs, null);
  assert.equal(r.lagScore, null);
  assert.deepEqual(r.gaps, []);
  assert.equal(r.speechSec, 0);
  assert.deepEqual(r.dropouts, [{ startFrame: 3 * SR, frames: 480, ms: 10 }]);
  assert.equal(r.micSilentSec, 0.5);
  assert.equal(r.micHoles, 0);
  assert.deepEqual(r.micPauses, [{ startFrame: SR, frames: SR / 2, ms: 500 }]);
});

test("analyzeSpeech: the microphone's own zero runs of 100 ms or more are its pauses", () => {
  const db = new Float32Array(800).fill(-70);
  const refRuns = [
    { startFrame: 0, frames: 4799 },
    { startFrame: SR, frames: 4800 },
    { startFrame: 2 * SR, frames: 480 },
  ];
  const r = analyzeSpeech({ refDb: db, sigDb: db, refRuns, sigRuns: [] });
  assert.deepEqual(r.micPauses, [{ startFrame: SR, frames: 4800, ms: 100 }]);
});

test("analyzeSpeech: an utterance 600 ms late, beyond its own lag search, is a 600 ms gap", () => {
  // Its own lag lies at the edge of the ± 300 ms search: not trusted, so the steady lag says when it was due.
  const u = TAKES[0].utterances[2];
  const r = analyzeSpeech(micRun({ seconds: 120, shifts: [[60 + u.start - 0.35, 60 + u.end + 0.35, 600]] }));
  assert.equal(r.gaps.length, 1, JSON.stringify(r.gaps));
  near(r.gaps[0].atSec, 60 + u.start, 0.02, "where it was due");
  near(r.gaps[0].holeMs, 600, 20, "as long as it was late");
});

test("analyzeSpeech: says when CABLE Output carried only digital silence", () => {
  const silent = new Float32Array(2000).fill(-120);
  const room = new Float32Array(2000).fill(-70);
  assert.equal(analyzeSpeech({ refDb: room, sigDb: silent }).cableSilent, true);
  assert.equal(analyzeSpeech({ refDb: silent, sigDb: silent }).cableSilent, true, "a muted microphone too");
  const something = silent.slice();
  something[1500] = -95;
  assert.equal(analyzeSpeech({ refDb: room, sigDb: something }).cableSilent, false, "anything above −100 dB");
  assert.equal(analyzeSpeech({ refDb: room, sigDb: new Float32Array(0) }).cableSilent, false, "nothing recorded: not known");
  assert.equal(analyzeSpeech(micRun({ seconds: 30 })).cableSilent, false);
});

// ---------- the tone's clock ----------

test("clockFromEvents: regular skips give the offset; few events give the rate", () => {
  const skips = Array.from({ length: 6 }, (_, k) => ({ kind: "skip", atSec: 100 + 300 * k }));
  let r = clockFromEvents(skips, 1800);
  near(r.ppm, 33.3, 0.1, "ppm");
  assert.equal(r.direction, "faster");
  near(r.ticksPer30Min, 6, 1e-9, "ticksPer30Min");
  const holes = Array.from({ length: 4 }, (_, k) => ({ kind: "hole", atFrame: (50 + 600 * k) * SR }));
  r = clockFromEvents(holes, 3600);
  near(r.ppm, -16.67, 0.01, "ppm from holes");
  assert.equal(r.direction, "slower");
  assert.equal(r.steady, true);
  // One or two events are counted, but they are no measured offset: any glitch can make one.
  r = clockFromEvents([{ kind: "skip", atSec: 10 }], 1800);
  assert.deepEqual(r, { ppm: null, direction: null, ticksPer30Min: 1, steady: false });
  r = clockFromEvents([{ kind: "hole", atSec: 10 }, { kind: "hole", atSec: 900 }], 1800);
  assert.deepEqual(r, { ppm: null, direction: null, ticksPer30Min: 2, steady: false });
  r = clockFromEvents([{ kind: "click", atSec: 10 }, { kind: "level", atSec: 20 }], 900);
  assert.equal(r.ticksPer30Min, 2);
  assert.equal(r.direction, null);
  assert.deepEqual(clockFromEvents([], 1800), { ppm: null, direction: null, ticksPer30Min: 0, steady: false });
  assert.deepEqual(clockFromEvents([], 0), { ppm: null, direction: null, ticksPer30Min: null, steady: false });
});

test("clockFromEvents: a burst or a cluster of events is counted, but says nothing about the clocks", () => {
  const at = (kind, times) => times.map((atSec) => ({ kind, atSec }));
  const rate3 = (3 * 1800) / 3900;
  // Three holes within one second (a CPU spike) in a 65-minute check: 1.4 per 30 minutes, not 4000.
  assert.deepEqual(clockFromEvents(at("hole", [1200, 1200.4, 1200.9]), 3900), { ppm: null, direction: null, ticksPer30Min: rate3, steady: false });
  // Three skips 40 s apart in the middle, then none: steady drift would have gone on.
  assert.deepEqual(clockFromEvents(at("skip", [1000, 1040, 1080]), 3900), { ppm: null, direction: null, ticksPer30Min: rate3, steady: false });
  assert.deepEqual(clockFromEvents(at("skip", [300, 340, 380]), 3900), { ppm: null, direction: null, ticksPer30Min: rate3, steady: false });
  // Four holes: three 40 s apart early on, one at the end.
  assert.equal(clockFromEvents(at("hole", [100, 140, 180, 3870]), 3900).ppm, null);
  // Three skips 40 s apart in the last two minutes: a clock offset would have shown long before.
  assert.equal(clockFromEvents(at("skip", [3780, 3820, 3860]), 3900).ppm, null);
  // Ten holes half a second apart at the start of a 12 s check: no clock drifts 20000 ppm.
  const glitchy = clockFromEvents(at("hole", Array.from({ length: 10 }, (_, k) => 5 + 0.5 * k)), 12);
  assert.deepEqual(glitchy, { ppm: null, direction: null, ticksPer30Min: 1500, steady: false });
});

test("clockFromEvents: steady drift that began once the buffer filled gives its rate from then on", () => {
  // 40 ppm faster: the first drop after 1000 s, then one every 250 s, in a 30-minute check.
  const r = clockFromEvents([1000, 1250, 1500, 1750].map((atSec) => ({ kind: "skip", atSec })), 1800);
  near(r.ppm, 40, 1e-9, "ppm");
  assert.equal(r.direction, "faster");
  near(r.ticksPer30Min, 7.2, 1e-9, "per 30 minutes once it began, not 4 in 30 minutes");
});

// ---------- the long check ----------

/** A clean 65-minute tone check: 31 min minimized, 29 min hidden. */
const clean = (overrides = {}) => ({
  mode: "tone",
  durationSec: 3900,
  phases: { visibleSec: 300, minimizedSec: 1860, hiddenSec: 1740, unknownSec: 0 },
  counts: { holes: 0, skips: 1, clicks: 0, dropouts: 0, gaps: 0, levels: 0, steps: 0 },
  events: [{ kind: "skip", atSec: 1500, phase: "minimized" }],
  tone: { lockDb: -12.0, minStableDb: -12.0 },
  outages: [],
  recoveries: 0,
  micPath: micClock(readings(() => 20, 105), { holes: 1, durationSec: 3900 }),
  micZeroFraction: 0,
  late: { count: 0, maxMs: 0 },
  levelChanges: [],
  refRuns: [],
  ...overrides,
});

test("longVerdict: a clean check passes, with its lines", () => {
  const v = longVerdict(clean());
  assert.equal(v.verdict, "pass");
  assert.deepEqual(v.reasons, []);
  // One skip and one hole: counted, but no measured offset (one click can be any glitch).
  assert.equal(v.tonePath.direction, null);
  near(v.tonePath.ticksPer30Min, 1800 / 3900, 1e-9, "one skip in 65 min");
  assert.equal(v.tonePath.ppm, null);
  assert.deepEqual(v.lines, [
    "65 min recorded: 31 min minimized, 29 min hidden, 5 min open.",
    "Gaps: none.",
    "Clicks from the meeting's side of the sound: 1 (about 0.5 per 30 minutes).",
    "Clicks from your microphone's side: about 0.5 per 30 minutes (one short hole: too few to tell its clock).",
    "Volume: steady at −12.0 dB.",
  ]);
  assert.deepEqual(v.micPath, clean().micPath, "the microphone's road as given");
});

test("longVerdict: a gap in the tone fails", () => {
  const v = longVerdict(
    clean({
      counts: { holes: 0, skips: 0, clicks: 0, dropouts: 0, gaps: 1, levels: 0, steps: 0 },
      events: [{ kind: "gap", atSec: 750, holeMs: 300, phase: "hidden" }],
    }),
  );
  assert.equal(v.verdict, "fail");
  assert.deepEqual(v.reasons, ["The sound stopped once (the longest for 300 ms at 12:30 while hidden)."]);
  assert.equal(v.lines[1], "Gaps: 1 (the longest 300 ms at 12:30 while hidden).");
});

test("longVerdict: an outage (a recovery) fails twice over", () => {
  const v = longVerdict(clean({ outages: [{ phase: "minimized", ms: 1400, cause: "render-error", atSec: 1200 }], recoveries: 1 }));
  assert.equal(v.verdict, "fail");
  assert.deepEqual(v.reasons, [
    "The sound stopped once (the longest for 1400 ms at 20:00 while minimized).",
    "The app had to bring your voice back once.",
  ]);
});

test("longVerdict: a rendering pause fails", () => {
  const v = longVerdict(clean({ outages: [{ phase: "hidden", ms: 500, cause: "render-paused" }] }));
  assert.equal(v.verdict, "fail");
  assert.deepEqual(v.reasons, ["The sound stopped once (the longest for 500 ms while hidden)."]);
});

test("longVerdict: late deliveries alone pass, with a line", () => {
  const v = longVerdict(clean({ late: { count: 2, maxMs: 1234 } }));
  assert.equal(v.verdict, "pass");
  assert.equal(v.lines.at(-1), "The app's window was slow to update twice, at most 1.2 s; the sound was not affected.");
});

test("longVerdict: 7 clicks per 30 minutes on the tone's road fail", () => {
  const events = Array.from({ length: 7 }, (_, k) => ({ kind: "skip", atSec: 100 + (1800 / 7) * k }));
  const v = longVerdict(clean({ durationSec: 1900, events, counts: { holes: 0, skips: 7, clicks: 0, dropouts: 0, gaps: 0 } }));
  assert.equal(v.verdict, "fail");
  assert.deepEqual(v.reasons, ["Too many clicks from the meeting's side: about 7.0 per 30 minutes (6 at most)."]);
  near(v.tonePath.ppm, 38.9, 0.1, "tone road ppm");
});

test("longVerdict: 7 clicks per 30 minutes on the microphone's road fail", () => {
  const micPath = { ...clean().micPath, ppm: 38.9, direction: "faster", dropsPer30Min: 7, holesPer30Min: 0, ticksPer30Min: 7, holes: 0 };
  const v = longVerdict(clean({ micPath }));
  assert.equal(v.verdict, "fail");
  assert.deepEqual(v.reasons, ["Too many clicks from your microphone's side: about 7.0 per 30 minutes (6 at most)."]);
  assert.equal(v.lines[3], "Clicks from your microphone's side: about 7.0 per 30 minutes (its clock runs faster than VB-CABLE's).");
});

test("longVerdict: with a noise gate 'capture paused' is skipped, and the holes seen count as a lower bound, never a pass", () => {
  const holes = 14;
  const micPath = micClock(readings(() => 20, 105), { holes, durationSec: 3900 });
  assert.ok(micPath.ticksPer30Min > 6, "the holes alone fail");
  const refRuns = [{ startFrame: 600 * SR, frames: 150 * 48 }];
  let v = longVerdict(clean({ micPath, refRuns, micZeroFraction: 0.05 }));
  // The buffer's slope was measured over 60 minutes (flat): the clock is not faster. A slower one's holes hide in
  // the gate's silence, so the 14 seen are only some of them: they fail, and say "at least".
  assert.deepEqual(v.reasons, ["Too many clicks from your microphone's side: at least 6.5 per 30 minutes (6 at most)."]);
  assert.ok(
    v.lines.includes(
      "Your microphone sends digital silence in pauses (a noise gate?), so pauses and short drop-outs in the microphone itself could not be checked.",
    ),
  );
  assert.ok(
    v.lines.includes(
      "Clicks from your microphone's side: at least 6.5 per 30 minutes (its clock is not faster than VB-CABLE's; its noise gate hides the clicks a slower clock makes, so there may be more).",
    ),
    v.lines.join(" | "),
  );
  assert.ok(!v.lines.some((l) => l.includes("too short")), "60 minutes of readings are not too short");
  // 3 holes seen (1.4 per 30 minutes) are no measurement: the road was not measured, and the line says so.
  v = longVerdict(clean({ micPath: micClock(readings(() => 20, 105), { holes: 3, durationSec: 3900 }), refRuns, micZeroFraction: 0.05 }));
  assert.equal(v.verdict, "pass", JSON.stringify(v.reasons));
  assert.ok(
    v.lines.includes(
      "Clicks from your microphone's side: not measured, at least 1.4 per 30 minutes (its clock is not faster than VB-CABLE's; its noise gate hides the clicks a slower clock makes).",
    ),
    v.lines.join(" | "),
  );
  // None seen: not measured either, never "about 0.0".
  v = longVerdict(clean({ micPath: micClock(readings(() => 20, 105), { holes: 0, durationSec: 3900 }), refRuns, micZeroFraction: 0.05 }));
  assert.equal(v.verdict, "pass", JSON.stringify(v.reasons));
  assert.ok(
    v.lines.includes(
      "Clicks from your microphone's side: not measured (its clock is not faster than VB-CABLE's; its noise gate hides the clicks a slower clock makes).",
    ),
    v.lines.join(" | "),
  );
  assert.ok(!v.lines.some((l) => l.includes("about 0.0 per 30 minutes")), v.lines.join(" | "));
  // Without the noise gate both rules apply.
  v = longVerdict(clean({ micPath, refRuns, micZeroFraction: 0.001 }));
  assert.deepEqual(v.reasons, [
    "Too many clicks from your microphone's side: about 6.5 per 30 minutes (6 at most).",
    "Your microphone sent only digital silence once (the longest for 150 ms at 10:00): it was muted, or Windows paused it.",
  ]);
});

test("longVerdict: a tone 2 dB too quiet needs a setting changed; 0.8 dB is fine", () => {
  let v = longVerdict(clean({ tone: { lockDb: -14, minStableDb: -14 } }));
  assert.equal(v.verdict, "fix-setting");
  assert.deepEqual(v.reasons, [
    "The meeting hears the sound 2.0 dB quieter than it should. In Windows sound settings (Windows key + R, type mmsys.cpl, Enter): Communications tab → “Do nothing”; Playback → CABLE Input and Recording → CABLE Output → Properties → Levels → 100. In the meeting app, turn off its automatic microphone volume. Then tell me before you run the hour-long check again (Session B step 7.5).",
  ]);
  // Exact places, no meeting app named (the check runs in Meet), and which re-run is meant.
  assert.ok(!/Zoom|run the check again/.test(v.reasons[0]), v.reasons[0]);
  v = longVerdict(clean({ tone: { lockDb: -12.8, minStableDb: -12.8 } }));
  assert.equal(v.verdict, "pass");
  // The limit is −13 dBFS: −13.2 needs the setting, −13.0 is fine.
  v = longVerdict(clean({ tone: { lockDb: -12, minStableDb: -13.2 } }));
  assert.equal(v.verdict, "fix-setting");
  assert.ok(v.reasons[0].startsWith("The meeting hears the sound 1.2 dB quieter"), v.reasons[0]);
  assert.equal(longVerdict(clean({ tone: { lockDb: -12, minStableDb: -13 } })).verdict, "pass");
});

test("longVerdict: Windows turning the voice down during the check needs a setting changed", () => {
  const v = longVerdict(clean({ levelChanges: [{ atSec: 330, fromDb: -12, toDb: -26 }] }));
  assert.equal(v.verdict, "fix-setting");
  assert.deepEqual(v.reasons, [
    "Windows turned the sound down by 14.0 dB at 5:30, probably when the meeting started. In Windows sound settings (Windows key + R, type mmsys.cpl, Enter): Communications tab → “Do nothing” → OK. Then tell me before you run the hour-long check again (Session B step 7.5).",
  ]);
  // Taken from the tone's level events when no list is given.
  const fromEvents = longVerdict(
    clean({ levelChanges: undefined, events: [{ kind: "level", atFrame: 330 * SR, fromDb: -12, toDb: -16 }], tone: { lockDb: -12, minStableDb: -16 } }),
  );
  assert.equal(fromEvents.verdict, "fix-setting");
  assert.equal(fromEvents.reasons.length, 2, "too quiet, and turned down");
  assert.equal(fromEvents.lines.find((l) => l.startsWith("Volume")), "Volume: −12.0 dB at the start, −16.0 dB at the lowest.");
  // A small change is fine.
  assert.equal(longVerdict(clean({ levelChanges: [{ atSec: 330, fromDb: -12, toDb: -14.5 }] })).verdict, "pass");
});

test("longVerdict: a fail outranks a setting; no tone found is no-signal", () => {
  const both = longVerdict(clean({ tone: { lockDb: -14, minStableDb: -14 }, recoveries: 1 }));
  assert.equal(both.verdict, "fail");
  assert.deepEqual(both.reasons, ["The app had to bring your voice back once."]);
  const none = longVerdict(clean({ tone: { lockDb: null, minStableDb: null } }));
  assert.equal(none.verdict, "no-signal");
  assert.deepEqual(none.reasons, ["The test tone never reached “CABLE Output”."]);
});

test("longVerdict: a check that measured nothing has no tone road, and its lines say so", () => {
  const zero = { holes: 0, skips: 0, clicks: 0, dropouts: 0, gaps: 0, levels: 0, steps: 0 };
  const v = longVerdict(clean({ tone: { lockDb: null, minStableDb: null }, counts: zero, events: [] }));
  assert.equal(v.verdict, "no-signal");
  assert.equal(v.tonePath, null);
  assert.equal(v.lines[1], "Gaps and clicks: not checked, because the test tone never reached “CABLE Output”.");
  assert.ok(!v.lines.some((l) => l.startsWith("Clicks from the meeting's side") || l.startsWith("Gaps: none")), v.lines.join(" | "));
  assert.deepEqual(v.micPath, clean().micPath, "the microphone's road does not need the tone");
  const mic = longVerdict(micClean({ speech: { ...micClean().speech, lagMs: null, lagScore: null } }));
  assert.equal(mic.verdict, "no-signal");
  assert.ok(mic.lines.includes("Gaps: not checked, because your voice never reached “CABLE Output”."), mic.lines.join(" | "));
  assert.ok(mic.lines.includes("Speech heard: 3 min, but none of it in CABLE Output."), mic.lines.join(" | "));
});

/** longVerdict's input with exactly the fields §3.4 lists. */
const SPEC_FIELDS = ["counts", "durationSec", "events", "late", "levelChanges", "micPath", "micZeroFraction", "mode", "outages", "phases", "recoveries", "speech", "tone"];

test("longVerdict: the microphone itself stopping fails, from the spec's inputs in mic mode", () => {
  // Windows paused the microphone for 300 ms (or it was muted); CABLE Output repeats its silence 50 ms later.
  const speech = analyzeSpeech({
    refDb: new Float32Array(0),
    sigDb: new Float32Array(0),
    refRuns: [{ startFrame: 100 * SR, frames: 0.3 * SR }],
    sigRuns: [{ startFrame: 100 * SR + 2400, frames: 0.3 * SR }],
  });
  const input = {
    mode: "mic",
    durationSec: 300,
    phases: { visibleSec: 300, minimizedSec: 0, hiddenSec: 0, unknownSec: 0 },
    counts: null,
    events: [],
    tone: null,
    speech,
    outages: [],
    recoveries: 0,
    micPath: null,
    micZeroFraction: 0.0001,
    late: { count: 0, maxMs: 0 },
    levelChanges: [],
  };
  assert.deepEqual(Object.keys(input).sort(), SPEC_FIELDS);
  const v = longVerdict(input);
  assert.equal(v.verdict, "fail");
  assert.deepEqual(v.reasons, ["Your microphone sent only digital silence once (the longest for 300 ms at 1:40): it was muted, or Windows paused it."]);
  // A speech result without micPauses: its micSilentSec (runs of 200 ms or more) still tells.
  const { micPauses, ...older } = speech;
  assert.equal(micPauses.length, 1);
  assert.deepEqual(longVerdict({ ...input, speech: older }).reasons, [
    "Your microphone sent only digital silence for 300 ms in all: it was muted, or Windows paused it.",
  ]);
});

test("longVerdict: in tone mode the microphone's zero runs (refRuns) tell; without them a line says it was not checked", () => {
  const paused = [{ startFrame: 2000 * SR, frames: 1.5 * SR }];
  let v = longVerdict(clean({ refRuns: paused }));
  assert.equal(v.verdict, "fail");
  assert.deepEqual(v.reasons, ["Your microphone sent only digital silence once (the longest for 1500 ms at 33:20): it was muted, or Windows paused it."]);
  assert.deepEqual(
    longVerdict(clean({ refRuns: [{ startFrame: 2000 * SR, frames: 4799 }] })).reasons,
    ["The microphone itself dropped out once for 20 to 100 ms (the longest 99 ms at 33:20)."],
    "under 100 ms: a drop-out, not a stop",
  );
  assert.deepEqual(
    longVerdict(clean({ refRuns: [{ startFrame: 2000 * SR, frames: 4800 }] })).reasons,
    ["Your microphone sent only digital silence once (the longest for 100 ms at 33:20): it was muted, or Windows paused it."],
    "exactly 100 ms",
  );
  v = longVerdict(clean({ refRuns: undefined }));
  assert.equal(v.verdict, "pass");
  assert.ok(v.lines.includes("Whether the microphone itself stopped was not checked (no record of its silences)."), v.lines.join(" | "));
  assert.ok(!longVerdict(clean()).lines.some((l) => l.startsWith("Whether the microphone")), "checked: nothing to say");
});

test("longVerdict: the microphone's own drop-outs of 20 to 100 ms fail in both modes, unless it has a noise gate", () => {
  const run = (sec, frames, extra = {}) => ({ startFrame: sec * SR, frames, ...extra });
  // Tone mode. 20 ms (960 frames) is a drop-out; just under it is not (the 8–11 ms ones are holes: clicks).
  assert.equal(longVerdict(clean({ refRuns: [run(900, 959)] })).verdict, "pass", "under 20 ms");
  let v = longVerdict(
    clean({ refRuns: [run(900, 960), run(1300, 2400, { atSec: 1300.2, phase: "minimized" }), run(2500, 1920, { atSec: 2500, phase: "hidden" })] }),
  );
  assert.equal(v.verdict, "fail");
  assert.deepEqual(v.reasons, ["The microphone itself dropped out 3 times for 20 to 100 ms (the longest 50 ms at 21:40 while minimized)."]);
  // Next to a stop, both count.
  v = longVerdict(clean({ refRuns: [run(900, 960), run(2000, 1.5 * SR)] }));
  assert.deepEqual(v.reasons, [
    "Your microphone sent only digital silence once (the longest for 1500 ms at 33:20): it was muted, or Windows paused it.",
    "The microphone itself dropped out once for 20 to 100 ms (the longest 20 ms at 15:00).",
  ]);
  // A microphone with a noise gate sends digital silence in pauses: its short silences say nothing.
  v = longVerdict(clean({ refRuns: [run(900, 2400)], micZeroFraction: 0.02 }));
  assert.equal(v.verdict, "pass", JSON.stringify(v.reasons));

  // Mic mode: three 50 ms drop-outs that CABLE Output repeats 40 ms later. They are the microphone's (explained),
  // so CABLE Output has no drop-out of its own, but the meeting heard them all the same.
  const refRuns = [run(60, 2400), run(150, 2400), run(240, 2400)];
  const sigRuns = refRuns.map((r) => ({ startFrame: r.startFrame + 40 * 48, frames: r.frames }));
  const runs = analyzeSpeech({ refDb: new Float32Array(0), sigDb: new Float32Array(0), refRuns, sigRuns });
  assert.deepEqual(runs.dropouts, [], "CABLE Output's runs are the microphone's");
  const speech = { ...micClean().speech, dropouts: runs.dropouts, micHoles: runs.micHoles, micPauses: runs.micPauses };
  v = longVerdict(micClean({ speech, refRuns }));
  assert.equal(v.verdict, "fail");
  assert.deepEqual(v.reasons, ["The microphone itself dropped out 3 times for 20 to 100 ms (the longest 50 ms at 1:00)."]);
  assert.ok(v.lines.includes("Drop-outs in CABLE Output: none."), v.lines.join(" | "));
  // Without refRuns the speech analysis still tells the stops, but not the drop-outs: a line says so.
  v = longVerdict(micClean({ speech, refRuns: undefined }));
  assert.equal(v.verdict, "pass");
  assert.ok(
    v.lines.includes("Whether the microphone itself dropped out for 20 to 100 ms was not checked (no record of its short silences)."),
    v.lines.join(" | "),
  );
});

test("longVerdict: the noise gate starts at 1 % of digital silence", () => {
  const refRuns = [{ startFrame: 600 * SR, frames: 150 * 48 }];
  assert.equal(longVerdict(clean({ refRuns, micZeroFraction: 0.0099 })).verdict, "fail", "0.99 %: no noise gate");
  assert.equal(longVerdict(clean({ refRuns, micZeroFraction: 0.01 })).verdict, "pass", "1 %: a noise gate");
});

test("noiseGateOf: the short silences make a noise gate; runs of 2 s or more are left out", () => {
  const total = 3900 * SR;
  const run = (sec, frames) => ({ startFrame: sec * SR, frames });
  // One run of 60 s in 65 minutes (1.5 %) is the microphone stopping, not a gate; so is one of 30 minutes.
  assert.equal(noiseGateOf(60 / 3900, [run(2500, 60 * SR)], total), false);
  assert.equal(noiseGateOf(1800 / 3900, [run(2000, 1800 * SR)], total), false);
  // The limit is 2 s: with 38 s of short runs (0.97 %), a run of exactly 2 s is left out, one a frame shorter counts.
  assert.equal(noiseGateOf((38 + 2) / 3900, [run(100, 2 * SR)], total), false, "exactly 2 s: left out");
  assert.equal(noiseGateOf((38 + (2 * SR - 1) / SR) / 3900, [run(100, 2 * SR - 1)], total), true, "just under 2 s: a gate's");
  // Short ones above 1 % make a gate, whatever long runs come with them.
  assert.equal(noiseGateOf((40 + 600) / 3900, [run(100, 600 * SR)], total), true);
  // Many silences make a gate however long each was (a gate shuts at every pause); a few never do.
  const many = (n) => Array.from({ length: n }, (_, k) => run(100 + 150 * k, 30 * SR));
  assert.equal(noiseGateOf((20 * 30) / 3900, many(20), total), true, "20 silences of 30 s");
  assert.equal(noiseGateOf((19 * 30) / 3900, many(19), total), false, "19 silences of 30 s");
  assert.equal(noiseGateOf((19 * 30 + 0.1) / 3900, [...many(19), run(3500, 0.1 * SR)], total), true, "the 20th: exactly 100 ms");
  assert.equal(noiseGateOf((19 * 30 + 0.1) / 3900, [...many(19), run(3500, 0.1 * SR - 1)], total), false, "shorter is no silence");
  // Under 1 % of digital silence is never a gate, however many short silences make it up.
  const stalls = Array.from({ length: 30 }, (_, k) => run(100 + 60 * k, 0.2 * SR));
  assert.equal(noiseGateOf(6 / 3900, stalls, total), false, "30 stalls of 200 ms");
  // Without the runs (an older caller) the total decides, as before; without a fraction there is no gate.
  assert.equal(noiseGateOf(0.02, undefined, total), true);
  assert.equal(noiseGateOf(null, many(30), total), false);
});

test("longVerdict: one long silence is the microphone stopping, however long, never a noise gate", () => {
  // 60 s of digital silence while hidden in a 65-minute tone check: 1.5 % of it, all in one run.
  const hidden = { startFrame: 2500 * SR, frames: 60 * SR, atSec: 2500, phase: "hidden" };
  let v = longVerdict(clean({ refRuns: [hidden], micZeroFraction: 60 / 3900 }));
  assert.equal(v.verdict, "fail");
  assert.deepEqual(v.reasons, [
    "Your microphone sent only digital silence once (the longest for 60.0 s at 41:40 while hidden): it was muted, or Windows paused it.",
  ]);
  assert.ok(!v.lines.some((l) => l.includes("noise gate")), v.lines.join(" | "));
  assert.deepEqual(v.micSilence, { checked: true, gate: false });
  // The whole hidden half: 46 % of the check in one run.
  v = longVerdict(clean({ refRuns: [{ ...hidden, frames: 1800 * SR }], micZeroFraction: 1800 / 3900 }));
  assert.equal(v.verdict, "fail");
  assert.ok(v.reasons[0].startsWith("Your microphone sent only digital silence once (the longest for 30 min"), v.reasons[0]);
  // Two mutes of 20 s and 5 s while open: both count; the longest is named.
  const mutes = [
    { startFrame: 200 * SR, frames: 20 * SR, atSec: 200, phase: "visible" },
    { startFrame: 3800 * SR, frames: 5 * SR, atSec: 3800, phase: "visible" },
  ];
  v = longVerdict(clean({ refRuns: mutes, micZeroFraction: 25 / 3900 }));
  assert.deepEqual(v.reasons, [
    "Your microphone sent only digital silence twice (the longest for 20.0 s at 3:20 while open): it was muted, or Windows paused it.",
  ]);
});

test("longVerdict: a noise gate's many short silences are not judged, and the result says so", () => {
  // 200 silences of 0.5 s spread over 65 minutes: 100 s, 2.6 % of the check.
  const gate = Array.from({ length: 200 }, (_, k) => ({ startFrame: (60 + 19 * k) * SR, frames: 0.5 * SR }));
  let v = longVerdict(clean({ refRuns: gate, micZeroFraction: 100 / 3900 }));
  assert.equal(v.verdict, "pass", JSON.stringify(v.reasons));
  assert.deepEqual(v.micSilence, { checked: false, gate: true });
  assert.ok(v.lines.some((l) => l.startsWith("Your microphone sends digital silence in pauses (a noise gate?)")), v.lines.join(" | "));
  // A long silence on top of a gate's is not judged either: the gate's short ones alone are over 1 %.
  v = longVerdict(clean({ refRuns: [...gate, { startFrame: 2500 * SR, frames: 60 * SR }], micZeroFraction: 160 / 3900 }));
  assert.equal(v.verdict, "pass");
  assert.equal(v.micSilence.gate, true);
  // A gate in a quiet room, shut for 10 s at a time between sounds: few short silences, but many silences.
  const quiet = Array.from({ length: 25 }, (_, k) => ({ startFrame: (100 + 150 * k) * SR, frames: 10 * SR }));
  v = longVerdict(clean({ refRuns: quiet, micZeroFraction: 250 / 3900 }));
  assert.equal(v.verdict, "pass", JSON.stringify(v.reasons));
  assert.equal(v.micSilence.gate, true);
  // Without a record of the microphone's silences nothing was judged either.
  assert.deepEqual(longVerdict(clean({ refRuns: undefined })).micSilence, { checked: false, gate: false });
});

test("longVerdict, mic mode: a capture pause of 3, 4 or 20 s in a 5-minute check with your voice fails", () => {
  for (const sec of [3, 4, 20]) {
    const refRuns = [{ startFrame: 150 * SR, frames: sec * SR }];
    const { micPauses } = analyzeSpeech({ refDb: new Float32Array(0), sigDb: new Float32Array(0), refRuns, sigRuns: [] });
    const speech = { ...micClean().speech, micPauses };
    // From refRuns, as the check gives them, and from the speech analysis's micPauses alone.
    const fromRuns = longVerdict(micClean({ speech, refRuns, micZeroFraction: sec / 300 }));
    const fromPauses = longVerdict(micClean({ speech, refRuns: undefined, micZeroFraction: sec / 300 }));
    for (const v of [fromRuns, fromPauses]) {
      assert.equal(v.verdict, "fail", `${sec} s`);
      assert.deepEqual(v.reasons, [
        `Your microphone sent only digital silence once (the longest for ${sec < 10 ? `${sec * 1000} ms` : `${sec}.0 s`} at 2:30): it was muted, or Windows paused it.`,
      ]);
      assert.equal(v.micSilence.gate, false, `${sec} s is ${((sec / 300) * 100).toFixed(1)} % but one run`);
    }
  }
});

test("longVerdict: exactly 6 clicks per 30 minutes on either road pass", () => {
  // 13 skips 300 s apart in 65 minutes: 6.0 per 30 minutes (33 ppm).
  const events = Array.from({ length: 13 }, (_, k) => ({ kind: "skip", atSec: 150 + 300 * k }));
  let v = longVerdict(clean({ events, counts: { holes: 0, skips: 13, clicks: 0, dropouts: 0, gaps: 0 } }));
  assert.equal(v.tonePath.ticksPer30Min, 6);
  assert.equal(v.verdict, "pass", JSON.stringify(v.reasons));
  // 13 holes of the microphone in 65 minutes: 6.0 per 30 minutes.
  const micPath = micClock(readings(() => 20, 105), { holes: 13, durationSec: 3900 });
  assert.equal(micPath.ticksPer30Min, 6);
  v = longVerdict(clean({ micPath }));
  assert.equal(v.verdict, "pass", JSON.stringify(v.reasons));
});

test("longVerdict: a burst of three holes in a second is 1.4 clicks per 30 minutes, not a clock offset", () => {
  const events = [1200, 1200.4, 1200.9].map((atSec) => ({ kind: "hole", atSec, holeMs: 10, phase: "minimized" }));
  const v = longVerdict(clean({ events, counts: { holes: 3, skips: 0, clicks: 0, dropouts: 0, gaps: 0 } }));
  assert.equal(v.verdict, "pass", JSON.stringify(v.reasons));
  assert.deepEqual(v.tonePath, { ticksPer30Min: (3 * 1800) / 3900, ppm: null, direction: null });
  assert.equal(v.lines[2], "Clicks from the meeting's side of the sound: 3 (about 1.4 per 30 minutes).");
});

test("longVerdict: Windows turning the voice down by exactly 3 dB needs a setting changed", () => {
  assert.equal(longVerdict(clean({ levelChanges: [{ atSec: 330, fromDb: -12, toDb: -15 }] })).verdict, "fix-setting");
  assert.equal(longVerdict(clean({ levelChanges: [{ atSec: 330, fromDb: -12, toDb: -14.9 }] })).verdict, "pass");
});

test("longVerdict: a gap of minutes reads in minutes", () => {
  const v = longVerdict(
    clean({
      counts: { holes: 0, skips: 0, clicks: 0, dropouts: 0, gaps: 1, levels: 0, steps: 0 },
      events: [{ kind: "gap", atFrame: 25 * 60 * SR, holeMs: 300000, phase: "hidden" }],
    }),
  );
  assert.deepEqual(v.reasons, ["The sound stopped once (the longest for 5 min at 25:00 while hidden)."]);
  const s = longVerdict(clean({ outages: [{ phase: "minimized", ms: 12500, cause: "render-error", atSec: 60 }] }));
  assert.equal(s.lines[1], "Gaps: 1 (the longest 12.5 s at 1:00 while minimized).");
});

test("longVerdict: tone drop-outs and the tick count from the counts", () => {
  const v = longVerdict(
    clean({
      counts: { holes: 9, skips: 0, clicks: 0, dropouts: 1, gaps: 0 },
      events: [{ kind: "dropout", atSec: 40, holeMs: 40 }],
    }),
  );
  assert.equal(v.verdict, "fail");
  assert.deepEqual(v.reasons, ["The sound dropped out once for 20 to 100 ms (the longest 40 ms)."]);
  assert.equal(v.tonePath.ticksPer30Min, (9 * 1800) / 3900, "nine holes counted though their events are not in the list");
  const many = longVerdict(clean({ counts: { holes: 14, skips: 0, clicks: 0, dropouts: 0, gaps: 0 }, events: [] }));
  assert.deepEqual(many.reasons, ["Too many clicks from the meeting's side: about 6.5 per 30 minutes (6 at most)."]);
});

/** A clean mic-mode check of 5 minutes. */
const micClean = (overrides = {}) => ({
  mode: "mic",
  durationSec: 300,
  phases: { visibleSec: 20, minimizedSec: 280, hiddenSec: 0, unknownSec: 0 },
  speech: { lagMs: 52, lagScore: 0.9, gaps: [], speechSec: 170, dropouts: [], micHoles: 0, micSilentSec: 0 },
  outages: [],
  recoveries: 0,
  micPath: micClock(readings(() => 20, 109, { minutes: 4 }), { holes: 0, durationSec: 300 }),
  micZeroFraction: 0,
  late: { count: 0, maxMs: 0 },
  refRuns: [],
  ...overrides,
});

test("longVerdict, mic mode: pass, missing words, drop-outs, voice never arrived", () => {
  let v = longVerdict(micClean());
  assert.equal(v.verdict, "pass");
  assert.equal(v.tonePath, null);
  assert.deepEqual(v.lines, [
    "5 min recorded: 5 min minimized, 0 min hidden, 0 min open.",
    "Gaps: none.",
    "The microphone's clock could not be measured (the check was too short).",
    "Speech heard: 3 min; your voice reached CABLE Output about 52 ms later.",
    "Drop-outs in CABLE Output: none.",
  ]);
  v = longVerdict(
    micClean({
      speech: {
        ...micClean().speech,
        gaps: [{ atSec: 61.2, holeMs: 300 }],
        dropouts: [
          { startFrame: 0, frames: 480, ms: 10 },
          { startFrame: 61 * SR, frames: 14400, ms: 300 },
        ],
      },
    }),
  );
  assert.equal(v.verdict, "fail");
  assert.deepEqual(v.reasons, [
    "Words went missing once (the longest 300 ms).",
    "CABLE Output dropped out once (the longest for 300 ms).",
  ]);
  v = longVerdict(
    micClean({ speech: { ...micClean().speech, dropouts: Array.from({ length: 2 }, (_, k) => ({ startFrame: k * SR, frames: 480, ms: 10 })) } }),
  );
  assert.deepEqual(v.reasons, ["Too many short drop-outs in CABLE Output: about 12.0 per 30 minutes (6 at most)."]);
  v = longVerdict(micClean({ speech: { ...micClean().speech, lagMs: null, lagScore: null } }));
  assert.equal(v.verdict, "no-signal");
  assert.deepEqual(v.reasons, ["Your voice never reached “CABLE Output”."]);
  v = longVerdict(micClean({ speech: { ...micClean().speech, lagMs: null, lagScore: null, speechSec: 0 } }));
  assert.equal(v.verdict, "no-signal", "no speech: only the zero runs were checked, which is no pass");
  assert.deepEqual(v.reasons, [
    "No speech was heard, so the check could not tell whether words went missing: run it again and read aloud the whole time.",
  ]);
  assert.ok(v.lines.includes("No speech was heard, so only the silence was checked."));
});

test("longVerdict, mic mode: a check with your voice that heard too little speech measured nothing; what it found still fails", () => {
  // 5 minutes: at least 30 s of speech (10 %), and never under 10 s.
  const heard = (speechSec, extra = {}) => longVerdict(micClean({ speech: { ...micClean().speech, speechSec }, ...extra }));
  assert.equal(heard(30).verdict, "pass");
  assert.equal(heard(29.9).verdict, "no-signal");
  let v = heard(20);
  assert.equal(v.verdict, "no-signal");
  assert.deepEqual(v.reasons, [
    "Too little speech was heard (20 s in 5 min), so the check could not tell whether words went missing: run it again and read aloud the whole time.",
  ]);
  // A 1-minute check needs 10 s.
  assert.equal(longVerdict(micClean({ durationSec: 60, speech: { ...micClean().speech, speechSec: 10 } })).verdict, "pass");
  assert.equal(longVerdict(micClean({ durationSec: 60, speech: { ...micClean().speech, speechSec: 9.9 } })).verdict, "no-signal");
  // A capture pause or an outage still fails it: that is evidence, speech or not.
  v = heard(0, { refRuns: [{ startFrame: 100 * SR, frames: 3 * SR }] });
  assert.equal(v.verdict, "fail");
  assert.ok(v.reasons[0].startsWith("Your microphone sent only digital silence once"), v.reasons[0]);
  v = heard(5, { outages: [{ atSec: 100, phase: "minimized", ms: 400, cause: "render-error" }], recoveries: 1 });
  assert.equal(v.verdict, "fail");
  // The gaps row counts it for nothing, as any check that measured nothing.
  const tone = structuredClone(COMPLETE.checks.long[0]);
  const quiet = { mode: "mic", recordedSec: 300, phases: { minimizedSec: 300, hiddenSec: 0 }, ...heard(0), speech: { gaps: [], dropouts: [] } };
  assert.equal(gateSummary({ checks: { long: [tone, quiet] } })[5].status, "pass");
});

test("longVerdict: at most 10 lines, and safe with nothing", () => {
  const v = longVerdict(clean({ late: { count: 5, maxMs: 3000 }, micZeroFraction: 0.5 }));
  assert.ok(v.lines.length <= 10);
  const empty = longVerdict(undefined);
  assert.equal(empty.verdict, "no-signal");
  assert.ok(empty.lines.length >= 1);
});

test("longVerdict: a gap that has no event (still going on when the check ended) fails from the counts alone", () => {
  const v = longVerdict(clean({ counts: { holes: 0, skips: 0, clicks: 0, dropouts: 0, gaps: 1, levels: 0, steps: 0 }, events: [] }));
  assert.equal(v.verdict, "fail");
  assert.deepEqual(v.reasons, ["The sound stopped once."]);
  assert.equal(v.lines[1], "Gaps: 1.");
});

/** A tone check as the cablewatch worklet sends it: counts and events once a second, nothing after its last one. */
function worklet(seconds, sampleAt) {
  const t = new ToneCheck();
  const events = [];
  let counts = null;
  const buf = new Float32Array(128);
  for (let n = 0; n < seconds * SR; n += 128) {
    for (let i = 0; i < 128; i++) buf[i] = sampleAt(n + i);
    t.push(buf);
    if ((n + 128) % SR === 0) {
      events.push(...t.takeEvents());
      counts = t.counts;
    }
  }
  return {
    mode: "tone",
    durationSec: seconds,
    phases: { visibleSec: 0, minimizedSec: seconds, hiddenSec: 0, unknownSec: 0 },
    counts,
    events: events.map((e) => ({ ...e, atSec: e.atFrame / SR, phase: "minimized" })),
    tone: { lockDb: t.lockDb, minStableDb: t.minStableDb },
    speech: null,
    outages: [],
    recoveries: 0,
    micPath: null,
    micZeroFraction: 0,
    late: { count: 0, maxMs: 0 },
    levelChanges: [],
  };
}

test("longVerdict from a worklet's last summary, with no finish(): a tone lost or drowned out at the end fails", () => {
  const period = tone({ seconds: 512 / SR });
  // The tone stops reaching CABLE Output at 50 s of 60, for good: the gap never ends, so it has no event.
  let input = worklet(60, (n) => (n < 50 * SR ? period[n % 512] : 0));
  assert.deepEqual(Object.keys(input).sort(), SPEC_FIELDS);
  let v = longVerdict(input);
  assert.equal(v.verdict, "fail");
  assert.deepEqual(v.reasons, ["The sound stopped once."]);
  // Another app plays into the cable for the last 10 s: the tone is there, drowned out.
  const noise = whiteNoise(SR, 5, -20);
  input = worklet(60, (n) => period[n % 512] + (n >= 50 * SR ? noise[n % SR] : 0));
  v = longVerdict(input);
  assert.equal(v.verdict, "fail");
  assert.ok(v.reasons[0].startsWith("Other sound was mixed into the test tone once."), v.reasons[0]);
});

test("longVerdict: other sound mixed into the test tone fails, from its events or its count", () => {
  const counts = { holes: 0, skips: 0, clicks: 0, dropouts: 0, gaps: 0, levels: 0, steps: 0, noises: 1 };
  const advice = " Nothing but this app may play into “CABLE Input”: in Zoom, Teams or Meet, the speaker must be your headset.";
  let v = longVerdict(clean({ counts, events: [{ kind: "noise", atFrame: 1500 * SR, frames: 300 * SR, holeMs: 300000, phase: "hidden" }] }));
  assert.equal(v.verdict, "fail");
  assert.deepEqual(v.reasons, [`Other sound was mixed into the test tone once (the longest for 5 min at 25:00 while hidden).${advice}`]);
  assert.equal(v.lines[1], "Gaps: none.", "the tone was there all along");
  assert.equal(v.lines[2], "Other sound in the test tone: 1 (the longest for 5 min at 25:00 while hidden).");
  assert.equal(v.tonePath.ticksPer30Min, 0, "not a click");
  // Counted only (the event did not fit the list): still a fail.
  v = longVerdict(clean({ counts, events: [] }));
  assert.deepEqual(v.reasons, [`Other sound was mixed into the test tone once.${advice}`]);
  // Events only (counts without the field).
  v = longVerdict(clean({ events: [{ kind: "noise", atSec: 60, holeMs: 250 }, { kind: "noise", atSec: 90, holeMs: 120 }] }));
  assert.ok(v.reasons[0].startsWith("Other sound was mixed into the test tone twice (the longest for 250 ms at 1:00)."), v.reasons[0]);
});

test("longVerdict, mic mode: CABLE Output that carried only digital silence is no-signal", () => {
  const silentDb = new Float32Array(60 * 200).fill(-120);
  const whole = [{ startFrame: 0, frames: 60 * SR }];
  // A muted microphone: both sides one long zero run.
  let v = longVerdict(
    micClean({ durationSec: 60, micZeroFraction: 1, speech: analyzeSpeech({ refDb: silentDb, sigDb: silentDb, refRuns: whole, sigRuns: whole }) }),
  );
  assert.equal(v.verdict, "no-signal");
  assert.deepEqual(v.reasons, ["Nothing reached “CABLE Output”: it carried only digital silence."]);
  assert.ok(v.lines.includes("Gaps: not checked, because nothing reached “CABLE Output”."), v.lines.join(" | "));
  assert.ok(v.lines.includes("No speech was heard on the microphone."), v.lines.join(" | "));
  assert.ok(v.lines.includes("CABLE Output carried only digital silence."), v.lines.join(" | "));
  // Room noise on the microphone, nobody spoke, and CABLE Output's silence still open when the check ended.
  const env = new EnvelopeStream({ capacity: 60 * 200 + 10 });
  env.push(whiteNoise(60 * SR, 9, -62));
  const speech = analyzeSpeech({ refDb: env.take(), sigDb: silentDb, refRuns: [], sigRuns: [] });
  assert.equal(speech.speechSec, 0);
  v = longVerdict(micClean({ durationSec: 60, speech }));
  assert.equal(v.verdict, "no-signal");
  assert.deepEqual(v.reasons, ["Nothing reached “CABLE Output”: it carried only digital silence."]);
  // A voice that never arrived keeps its own reason.
  v = longVerdict(micClean({ speech: { ...micClean().speech, lagMs: null, lagScore: null, cableSilent: true } }));
  assert.deepEqual(v.reasons, ["Your voice never reached “CABLE Output”."]);
});

test("longVerdict: with a noise gate the microphone's road is too short to measure only with too few readings and no hole; holes seen always count", () => {
  const per30Text = (x) => (Math.round(x * 10) / 10).toFixed(1);
  // 4 minutes of readings and no hole: no slope, nothing seen.
  let v = longVerdict(clean({ micPath: micClock(readings(() => 20, 110, { minutes: 4 }), { holes: 0, durationSec: 300 }), micZeroFraction: 0.05 }));
  assert.ok(v.lines.includes("The microphone's clock could not be measured (the check was too short)."), v.lines.join(" | "));
  assert.equal(v.verdict, "pass", JSON.stringify(v.reasons));
  // 3 holes in 5 minutes: no slope, but the holes seen are 18 per 30 minutes at least, as without a gate.
  const few = micClock(readings(() => 20, 110, { minutes: 4 }), { holes: 3, durationSec: 300 });
  v = longVerdict(clean({ micPath: few, micZeroFraction: 0.05 }));
  assert.deepEqual(v.reasons, ["Too many clicks from your microphone's side: at least 18.0 per 30 minutes (6 at most)."]);
  assert.ok(
    v.lines.includes(
      "Clicks from your microphone's side: at least 18.0 per 30 minutes (the check was too short to measure its clock; its noise gate hides the clicks a slower clock makes, so there may be more).",
    ),
    v.lines.join(" | "),
  );
  // One hole in 30 minutes and no slope: not measured, at least 1.0.
  v = longVerdict(clean({ micPath: micClock(readings(() => 20, 110, { minutes: 4 }), { holes: 1, durationSec: 1800 }), micZeroFraction: 0.05 }));
  assert.equal(v.verdict, "pass", JSON.stringify(v.reasons));
  assert.ok(
    v.lines.includes(
      "Clicks from your microphone's side: not measured, at least 1.0 per 30 minutes (the check was too short to measure its clock; its noise gate hides the clicks a slower clock makes).",
    ),
    v.lines.join(" | "),
  );
  // 20 ppm faster with 14 holes: a faster clock makes no holes, so the road is measured: the drops from the slope
  // (3.6 per 30 minutes) plus the holes seen (7.0), as micClock adds them without a gate.
  const faster = micClock(readings((t) => Math.min(60, 10 + 0.02 * t), 101), { holes: 14, durationSec: 3600 });
  assert.ok(faster.ticksPer30Min > 6 && faster.dropsPer30Min <= 6, JSON.stringify(faster));
  v = longVerdict(clean({ micPath: faster, micZeroFraction: 0.05 }));
  const sum = per30Text(faster.slopePpm * 0.18 + 7);
  assert.deepEqual(v.reasons, [`Too many clicks from your microphone's side: about ${sum} per 30 minutes (6 at most).`]);
  const line = v.lines.find((l) => l.startsWith("Clicks from your microphone's side"));
  assert.equal(line, `Clicks from your microphone's side: about ${sum} per 30 minutes (its clock runs faster than VB-CABLE's).`);
  // The same without holes passes on the slope's drops.
  v = longVerdict(clean({ micPath: { ...faster, holes: 0, holesPer30Min: 0 }, micZeroFraction: 0.05 }));
  assert.equal(v.verdict, "pass", JSON.stringify(v.reasons));
  assert.ok(v.lines.includes(`Clicks from your microphone's side: about ${per30Text(faster.slopePpm * 0.18)} per 30 minutes (its clock runs faster than VB-CABLE's).`), v.lines.join(" | "));
  // 80 ppm faster: the slope alone fails it.
  const fast = micClock(readings((t) => Math.min(80, 10 + 0.08 * t), 102), { durationSec: 3600 });
  v = longVerdict(clean({ micPath: fast, micZeroFraction: 0.05 }));
  assert.equal(v.verdict, "fail");
  assert.ok(v.reasons[0].startsWith("Too many clicks from your microphone's side"), v.reasons[0]);
  // A lower bound says so.
  const bound = micClock(readings((t) => Math.min(100, 10 + 0.2 * t), 103), { durationSec: 3600 });
  v = longVerdict(clean({ micPath: bound, micZeroFraction: 0.05 }));
  assert.ok(v.lines.some((l) => l.startsWith(`Clicks from your microphone's side: at least ${per30Text(bound.slopePpm * 0.18)} per 30 minutes (its clock runs faster`)), v.lines.join(" | "));
});

test("longVerdict, mic mode: 6 short drop-outs per 30 minutes pass, 7 fail", () => {
  const short = (n) => Array.from({ length: n }, (_, k) => ({ startFrame: (10 + 60 * k) * SR, frames: 480, ms: 10 }));
  const at = (n) => longVerdict(micClean({ durationSec: 1800, speech: { ...micClean().speech, speechSec: 900, dropouts: short(n) } }));
  assert.equal(at(6).verdict, "pass", JSON.stringify(at(6).reasons));
  assert.deepEqual(at(7).reasons, ["Too many short drop-outs in CABLE Output: about 7.0 per 30 minutes (6 at most)."]);
});

// ---------- Windows Audio restart ----------

test("restartVerdict", () => {
  assert.deepEqual(restartVerdict({ outageMs: 1780, lostAtMs: 0, serviceBackAtMs: 1510, appMs: 270, waitMs: 250 }), {
    verdict: "pass",
    text: "pass",
  });
  assert.deepEqual(restartVerdict({ outageMs: 2980, lostAtMs: 0, serviceBackAtMs: 2710, appMs: 270, waitMs: 250 }), {
    verdict: "pass",
    text: "pass (Windows itself took about 2.7 s)",
  });
  assert.deepEqual(restartVerdict({ outageMs: 2980, serviceBackAfterMs: 2710, appMs: 270, waitMs: 250 }).text, "pass (Windows itself took about 2.7 s)", "a results entry");
  const slow = restartVerdict({ outageMs: 3000, lostAtMs: 100, serviceBackAtMs: 1900, appMs: 900, waitMs: 300 });
  assert.equal(slow.verdict, "fail");
  assert.equal(slow.text, "fail (back after 3.0 s; the app's own part took 1200 ms: it waited 300 ms before trying again, then took 900 ms to bring the voice back)");
  const unknown = restartVerdict({ outageMs: 2500, lostAtMs: 0, serviceBackAtMs: null, appMs: null, waitMs: null });
  assert.equal(unknown.verdict, "fail");
  assert.equal(unknown.text, "fail (back after 2.5 s; the app could not tell when Windows Audio was running again)");
  assert.equal(restartVerdict(null).verdict, "fail");
});

test("restartVerdict: back in exactly 2 s passes; the app's part of exactly 1 s passes", () => {
  assert.deepEqual(restartVerdict({ outageMs: 2000, lostAtMs: 0, serviceBackAtMs: null, appMs: null, waitMs: null }), { verdict: "pass", text: "pass" });
  assert.deepEqual(restartVerdict({ outageMs: 3000, lostAtMs: 0, serviceBackAtMs: 2000, appMs: 700, waitMs: 300 }), {
    verdict: "pass",
    text: "pass (Windows itself took about 2.0 s)",
  });
  assert.equal(restartVerdict({ outageMs: 3000, lostAtMs: 0, serviceBackAtMs: 2000, appMs: 701, waitMs: 300 }).verdict, "fail");
});

// ---------- the Gate 1 checklist ----------

const delayRun = (estimateMs, routePreference = "auto", extra = {}) => ({
  ok: true,
  estimateMs,
  passthroughMs: estimateMs - 20,
  micFifoMs: 8,
  verdict: estimateMs <= 110 ? "good" : estimateMs <= 130 ? "borderline" : "slow",
  routePreference,
  ...extra,
});

const COMPLETE = {
  page: { origin: "http://tauri.localhost", secureContext: true },
  voice: {
    state: "running",
    mic: { settings: { allOff: true }, openedInMs: 420, unlockMs: null },
    output: { method: "context", routeChanges: [] },
    devices: { defaultOutputIsMicSibling: true },
    recoveries: [
      { cause: "render-error", outageMs: 300, micToo: false },
      { cause: "mic-ended", outageMs: 2980, serviceBackAfterMs: 2710, appMs: 270, waitMs: 250, micToo: true },
    ],
  },
  checks: {
    delay: [delayRun(64), delayRun(92.5), delayRun(71), delayRun(140, "element"), { ok: false, verdict: "unclear", estimateMs: null }],
    long: [
      {
        mode: "tone",
        recordedSec: 3960,
        phases: { visibleSec: 360, minimizedSec: 1860, hiddenSec: 1740 },
        verdict: "pass",
        reasons: [],
        tone: { counts: { gaps: 0, dropouts: 0 } },
        outages: [],
        renderPauses: [],
        recoveries: 0,
        tonePath: { ticksPer30Min: 2.5, ppm: 14, direction: "faster" },
        micPath: { ticksPer30Min: 1.2, dropsPer30Min: 1.2, ppm: 6.7, holes: 0, direction: "faster", noiseGate: false },
      },
      { mode: "mic", recordedSec: 300, phases: { minimizedSec: 300, hiddenSec: 0 }, speech: { gaps: [], dropouts: [] } },
    ],
  },
  sanas: { ok: true, initMs: 800 },
};

const statuses = (rows) => rows.map((r) => r.status);

test("gateSummary: a complete Session B", () => {
  const rows = gateSummary(COMPLETE);
  assert.deepEqual(
    rows.map((r) => r.row),
    [
      "Secure page",
      "Microphone: no prompt, processing off",
      "Voice into CABLE Input",
      "Zoom's Test Mic hears you",
      "Delay at most 120 ms",
      "No gaps while minimized and hidden",
      "No regular clicks",
      "Windows Audio restart: back within 2 s",
      "Connect only",
    ],
  );
  // The microphone row stays a note: whether anything asked at the 1st and 3rd start is in the user's notes.
  assert.deepEqual(statuses(rows), ["pass", "note", "pass", "todo", "pass", "pass", "pass", "pass", "pass"]);
  assert.equal(rows[4].text, "The highest of 3 measurements: about 93 ms (± 10). Through the audio element (not counted): 140 ms.");
  assert.ok(rows[5].text.includes("31 min minimized and 29 min hidden"));
  assert.ok(rows[5].text.endsWith("Meet call still open at the end: your note (Session B step 7.5)."));
  assert.equal(rows[7].text, "Back after 3.0 s: pass (Windows itself took about 2.7 s).");
  assert.ok(rows[6].text.includes("about 2.5 per 30 min") && rows[6].text.includes("about 1.2 per 30 min"));
  for (const r of rows) assert.ok(!/undefined|NaN|null/.test(r.text), r.text);
});

test("gateSummary: nothing collected yet is all todo", () => {
  const rows = gateSummary({});
  assert.deepEqual(statuses(rows), Array(9).fill("todo"));
  assert.deepEqual(statuses(gateSummary(undefined)), Array(9).fill("todo"));
  for (const r of rows) assert.ok(r.text.length > 10 && !/undefined|NaN/.test(r.text), r.text);
});

test("gateSummary: the delay row takes the highest estimate on the normal route", () => {
  const at = (...runs) => gateSummary({ checks: { delay: runs } })[4];
  assert.equal(at(delayRun(64), delayRun(118), delayRun(71)).status, "note");
  assert.ok(at(delayRun(64), delayRun(118)).text.startsWith("The highest of 2 measurements: about 118 ms (± 10)."));
  assert.equal(at(delayRun(131)).status, "fail");
  assert.equal(at(delayRun(131)).text, "One measurement: about 131 ms (± 10). Too slow.");
  assert.equal(at(delayRun(150, "element")).status, "todo", "element runs are not counted");
  assert.ok(at(delayRun(80, "auto", { micFifoMs: 31 })).text.includes("31 ms of it built up in the microphone's buffer."));
});

test("gateSummary: the route, the restart and the long check can fail or need a note", () => {
  let rows = gateSummary({ voice: { state: "sink-refused" } });
  assert.equal(rows[2].status, "fail");
  rows = gateSummary({ voice: { output: { method: "element-after-permission", routeChanges: [] } } });
  assert.equal(rows[2].status, "pass");
  assert.ok(rows[2].text.includes("may add delay or clicks"));
  rows = gateSummary({ voice: { output: { method: "context", routeChanges: [{ from: "context", to: "element" }] } } });
  assert.equal(rows[2].status, "note");
  rows = gateSummary({ voice: { recoveries: [{ outageMs: 3000, serviceBackAfterMs: 1800, appMs: 900, waitMs: 300, micToo: true }] } });
  assert.equal(rows[7].status, "fail");
  rows = gateSummary({ voice: { mic: { settings: { allOff: false } } } });
  assert.equal(rows[1].status, "fail");
  rows = gateSummary({ voice: { mic: { settings: { allOff: true }, unlockMs: 2400, openedInMs: 300 } } });
  assert.equal(rows[1].status, "note");
  assert.ok(rows[1].text.includes("2.4 s to open"));
  rows = gateSummary({ page: { secureContext: false }, sanas: { ok: false } });
  assert.equal(rows[0].status, "fail");
  assert.equal(rows[8].status, "fail");

  const long = structuredClone(COMPLETE.checks.long);
  long[0].tone.counts.gaps = 1;
  rows = gateSummary({ checks: { long } });
  assert.equal(rows[5].status, "fail");
  assert.ok(rows[5].text.includes("1 gap"));
  long[0].tone.counts.gaps = 0;
  long[1].speech.gaps = [{ atSec: 3, holeMs: 200 }];
  assert.equal(gateSummary({ checks: { long } })[5].status, "fail", "the check with the voice counts too");
  long[1].speech.gaps = [];
  long[0].verdict = "fix-setting";
  long[0].reasons = ["The meeting hears your voice 2.0 dB quieter than it should."];
  rows = gateSummary({ checks: { long } });
  assert.equal(rows[5].status, "note");
  assert.ok(rows[5].text.includes("2.0 dB quieter"));
  long[0].phases.hiddenSec = 600;
  rows = gateSummary({ checks: { long } });
  assert.equal(rows[5].status, "todo");
  assert.ok(rows[5].text.includes("The last one had 31 min minimized and 10 min hidden."));
  long[0].tonePath.ticksPer30Min = 7.5;
  assert.equal(gateSummary({ checks: { long } })[6].status, "fail");
  long[0].tonePath.ticksPer30Min = 2;
  long[0].micPath = null;
  assert.equal(gateSummary({ checks: { long } })[6].status, "note", "the microphone's road was not measured");
  long[0].recordedSec = 1200;
  assert.equal(gateSummary({ checks: { long } })[6].status, "todo", "shorter than 30 minutes");
});

test("gateSummary: a tone check forced onto the audio element (step 7.6) is listed beside the clicks row, not counted", () => {
  // Step 7 on the normal route: too many clicks on the meeting's side. Step 7.6: 30 minutes through the audio
  // element with the app open, few clicks, and no microphone's side (micBus is not reachable on that route).
  const normal = {
    ...structuredClone(COMPLETE.checks.long[0]),
    verdict: "fail",
    reasons: ["Too many clicks from the meeting's side: about 12.0 per 30 minutes (6 at most)."],
    tonePath: { ticksPer30Min: 12, ppm: -66.7, direction: "slower" },
    route: "context",
    routePreference: "auto",
  };
  const element = {
    mode: "tone",
    recordedSec: 1800,
    phases: { visibleSec: 1800, minimizedSec: 0, hiddenSec: 0, unknownSec: 0 },
    verdict: "pass",
    reasons: [],
    tone: { counts: { gaps: 0, dropouts: 0 } },
    outages: [],
    renderPauses: [],
    recoveries: 0,
    tonePath: { ticksPer30Min: 1, ppm: -5.6, direction: "slower" },
    micPath: null,
    route: "element",
    routePreference: "element",
  };
  const ticks = (...long) => gateSummary({ checks: { long } })[6];
  assert.equal(ticks(normal).status, "fail");
  assert.ok(ticks(normal).text.endsWith("Run the comparison through the audio element (Session B step 7.6)."), ticks(normal).text);
  for (const order of [[normal, element], [element, normal]]) {
    const row = ticks(...order);
    assert.equal(row.status, "fail", "the normal route's clicks still fail the row");
    assert.equal(
      row.text,
      "The meeting's side: about 12.0 per 30 min; your microphone's side: about 1.2 per 30 min (6 at most each). Through the audio element (not counted): about 1.0 per 30 min.",
    );
  }
  // A normal route that passes stays a pass, whatever the comparison found.
  const passing = { ...normal, verdict: "pass", reasons: [], tonePath: { ticksPer30Min: 2.5, ppm: 14, direction: "faster" } };
  const loud = { ...element, verdict: "fail", tonePath: { ticksPer30Min: 9, ppm: 50, direction: "faster" } };
  assert.equal(ticks(passing, loud).status, "pass");
  assert.ok(ticks(passing, loud).text.endsWith("Through the audio element (not counted): about 9.0 per 30 min."));
  // The comparison alone is no check of the normal route; one that measured nothing is not listed.
  assert.equal(ticks(element).status, "todo");
  assert.ok(ticks(element).text.endsWith("(Session B step 7). Through the audio element (not counted): about 1.0 per 30 min."), ticks(element).text);
  assert.ok(!ticks({ ...element, verdict: "no-signal", tonePath: null }).text.includes("audio element"));
  // Results made before routePreference was recorded count as the normal route.
  const { routePreference, ...old } = element; // eslint-disable-line no-unused-vars
  assert.equal(ticks(normal, old).status, "note");
  // The gaps row never takes a comparison either, even one with long enough phases and a gap.
  const phased = { ...element, phases: { visibleSec: 0, minimizedSec: 1800, hiddenSec: 1800 }, tone: { counts: { gaps: 1, dropouts: 0 } } };
  assert.equal(gateSummary({ checks: { long: [normal, phased] } })[5].status, "pass");
  const alone = gateSummary({ checks: { long: [phased] } })[5];
  assert.equal(alone.status, "todo");
  assert.ok(!alone.text.includes("The last one had"), alone.text);
});

/** A 65-minute tone check, as Part D builds its result from longVerdict(input). */
function toneResult(input) {
  const v = longVerdict(input);
  return {
    mode: "tone",
    recordedSec: input.durationSec,
    phases: input.phases,
    verdict: v.verdict,
    reasons: v.reasons,
    lines: v.lines,
    tonePath: v.tonePath,
    micPath: { ...v.micPath, noiseGate: false },
    tone: { levelDb: input.tone.lockDb, lockDb: input.tone.lockDb, minStableDb: input.tone.minStableDb, counts: input.counts },
    outages: [],
    renderPauses: [],
    recoveries: 0,
  };
}

test("gateSummary: a check whose tone never reached CABLE Output counts for no row", () => {
  const zero = { holes: 0, skips: 0, clicks: 0, dropouts: 0, gaps: 0, levels: 0, steps: 0 };
  const nothing = toneResult(clean({ tone: { lockDb: null, minStableDb: null }, counts: zero, events: [] }));
  assert.equal(nothing.verdict, "no-signal");
  let rows = gateSummary({ checks: { long: [nothing] } });
  assert.equal(rows[5].status, "todo");
  assert.ok(rows[5].text.includes("In the last one the test tone never reached “CABLE Output”, so it measured nothing."), rows[5].text);
  assert.equal(rows[6].status, "todo");
  assert.ok(rows[6].text.includes("measured nothing"), rows[6].text);
  // An earlier check that measured counts; the later one that measured nothing does not hide it.
  rows = gateSummary({ checks: { long: [toneResult(clean()), nothing] } });
  assert.equal(rows[5].status, "pass");
  assert.equal(rows[6].status, "pass");
});

test("gateSummary: a microphone that stopped by itself fails the gaps row", () => {
  const stopped = toneResult(clean({ refRuns: [{ startFrame: 2000 * SR, frames: 1.5 * SR }] }));
  assert.equal(stopped.verdict, "fail");
  const rows = gateSummary({ checks: { long: [stopped] } });
  assert.equal(rows[5].status, "fail");
  assert.equal(
    rows[5].text,
    "In 31 min minimized and 29 min hidden: your microphone sent only digital silence (muted, or paused by Windows). Meet call still open at the end: your note (Session B step 7.5).",
  );
  assert.equal(rows[6].status, "pass", "the clicks are fine");
  // In the check with the voice too.
  const voice = { mode: "mic", recordedSec: 300, phases: { minimizedSec: 300, hiddenSec: 0 }, verdict: "fail", reasons: [longVerdict(clean({ refRuns: [{ startFrame: 0, frames: SR }] })).reasons[0]], speech: { gaps: [], dropouts: [] } };
  const both = gateSummary({ checks: { long: [toneResult(clean()), voice] } })[5];
  assert.equal(both.status, "fail");
  assert.ok(both.text.includes("In the check with your voice: your microphone sent only digital silence (muted, or paused by Windows)."), both.text);
});

test("gateSummary: a long capture pause while hidden fails the gaps row; a noise gate makes it a note, never a pass", () => {
  // README step 7 with 60 s of digital silence from the microphone while hidden (1.5 % of the check).
  const paused = { startFrame: 2500 * SR, frames: 60 * SR, atSec: 2500, phase: "hidden" };
  const withMic = (input) => {
    const v = longVerdict(input);
    return { ...toneResult(input), micSilence: v.micSilence, micPath: { ...v.micPath, noiseGate: v.micSilence.gate } };
  };
  let rows = gateSummary({ checks: { long: [withMic(clean({ refRuns: [paused], micZeroFraction: 60 / 3900 }))] } });
  assert.equal(rows[5].status, "fail");
  assert.ok(rows[5].text.includes("your microphone sent only digital silence (muted, or paused by Windows)"), rows[5].text);
  // A noise gate: the check passes, the row is a note that says what could not be checked.
  const gate = Array.from({ length: 200 }, (_, k) => ({ startFrame: (60 + 19 * k) * SR, frames: 0.5 * SR }));
  const gated = withMic(clean({ refRuns: gate, micZeroFraction: 100 / 3900 }));
  assert.equal(gated.verdict, "pass");
  rows = gateSummary({ checks: { long: [gated] } });
  assert.equal(rows[5].status, "note");
  assert.equal(
    rows[5].text,
    "No gaps in 31 min minimized and 29 min hidden. Whether your microphone itself stopped could not be checked: it sends digital silence in pauses (a noise gate?). I decide with the details. Meet call still open at the end: your note (Session B step 7.5).",
  );
  // With what the check saw (measure.js adds the count and the longest silences).
  const seen = { ...gated, micSilence: { ...gated.micSilence, zeroFraction: 0.0256, count: 200, longest: [{ atSec: 2196, phase: "hidden", ms: 500 }] } };
  assert.equal(
    gateSummary({ checks: { long: [seen] } })[5].text,
    "No gaps in 31 min minimized and 29 min hidden. Whether your microphone itself stopped could not be checked: it sent only digital silence 200 times (the longest for 500 ms at 36:36 while hidden): a noise gate, or a microphone that kept stopping. I decide with the details. Meet call still open at the end: your note (Session B step 7.5).",
  );
  // The same from the check with your voice; and a failure still fails.
  const voice = { mode: "mic", recordedSec: 300, phases: { minimizedSec: 300, hiddenSec: 0 }, verdict: "pass", reasons: [], speech: { gaps: [], dropouts: [] } };
  rows = gateSummary({ checks: { long: [toneResult(clean()), { ...voice, micSilence: { checked: false, gate: true } }] } });
  assert.equal(rows[5].status, "note");
  rows = gateSummary({ checks: { long: [{ ...gated, renderPauses: [{ atSec: 1200, phase: "hidden", ms: 500 }] }] } });
  assert.equal(rows[5].status, "fail");
  // With a setting to change as well, the note says both.
  rows = gateSummary({ checks: { long: [withMic(clean({ refRuns: gate, micZeroFraction: 100 / 3900, tone: { lockDb: -14, minStableDb: -14 } }))] } });
  assert.equal(rows[5].status, "note");
  assert.ok(rows[5].text.includes("a setting needs changing") && rows[5].text.includes("could not be checked"), rows[5].text);
  // A result that only says so in micPath (the clicks row's field) is a note too.
  rows = gateSummary({ checks: { long: [{ ...toneResult(clean()), micPath: { ...toneResult(clean()).micPath, noiseGate: true } }] } });
  assert.equal(rows[5].status, "note");
});

test("gateSummary: a microphone that dropped out by itself for 20 to 100 ms fails the gaps row", () => {
  // Two 40 ms drop-outs while hidden: the tone was on the cable, but in normal use the voice carries them.
  const dropped = toneResult(clean({ refRuns: [{ startFrame: 2400 * SR, frames: 1920 }, { startFrame: 2800 * SR, frames: 1920 }] }));
  dropped.micDropouts = { count: 2, longestMs: 40, runs: [] };
  assert.equal(dropped.verdict, "fail");
  let rows = gateSummary({ checks: { long: [dropped] } });
  assert.equal(rows[5].status, "fail");
  assert.equal(
    rows[5].text,
    "In 31 min minimized and 29 min hidden: the microphone itself dropped out twice for 20 to 100 ms. Meet call still open at the end: your note (Session B step 7.5).",
  );
  assert.equal(rows[6].status, "pass", "the clicks are fine");
  // A result without the count still fails, in words without a number.
  delete dropped.micDropouts;
  rows = gateSummary({ checks: { long: [dropped] } });
  assert.equal(
    rows[5].text,
    "In 31 min minimized and 29 min hidden: the microphone itself dropped out for 20 to 100 ms. Meet call still open at the end: your note (Session B step 7.5).",
  );
  // In the check with the voice too.
  const voice = {
    mode: "mic",
    recordedSec: 300,
    phases: { minimizedSec: 300, hiddenSec: 0 },
    verdict: "fail",
    reasons: longVerdict(micClean({ refRuns: [{ startFrame: 60 * SR, frames: 2400 }] })).reasons,
    speech: { gaps: [], dropouts: [] },
    micDropouts: { count: 1, longestMs: 50, runs: [] },
  };
  const both = gateSummary({ checks: { long: [toneResult(clean()), voice] } })[5];
  assert.equal(both.status, "fail");
  assert.ok(both.text.includes("In the check with your voice: the microphone itself dropped out once for 20 to 100 ms."), both.text);
});

test("gateSummary: the microphone row is a note until the user's notes say whether anything asked; a fail stays a fail", () => {
  const rows = (voice) => gateSummary({ voice })[1];
  let row = rows({ mic: { settings: { allOff: true }, openedInMs: 420, unlockMs: 300 } });
  assert.equal(row.status, "note", "processing off and a quick open: still the notes' to say");
  assert.equal(
    row.text,
    "Processing is off. Whether Windows or the app asked anything at the 1st and 3rd start: your notes (Session B step 4); the first start's timings are in the log file.",
  );
  assert.equal(rows({ mic: { settings: { allOff: false } } }).status, "fail");
  assert.equal(rows({}).status, "todo");
});

test("gateSummary: the microphone row judges the launch's first open, whatever reopens came later", () => {
  // The first start opened the microphone in 1.8 s (a prompt?); a reopen after Session B step 9 took 300 ms.
  let row = gateSummary({ voice: { start: { ms: 2500, openedInMs: 1800, unlockMs: 400 }, mic: { settings: { allOff: true }, openedInMs: 300, unlockMs: 400 } } })[1];
  assert.equal(row.status, "note");
  assert.ok(row.text.includes("The microphone took 1.8 s to open at the start: was there a prompt?"), row.text);
  // The other way round: a quick first open and a slow reopen say nothing about a prompt.
  row = gateSummary({ voice: { start: { ms: 900, openedInMs: 250, unlockMs: 200 }, mic: { settings: { allOff: true }, openedInMs: 1900, unlockMs: 200 } } })[1];
  assert.ok(!row.text.includes("to open"), row.text);
  // Results without the first start's times: the microphone's own, as before.
  row = gateSummary({ voice: { start: { ms: 900 }, mic: { settings: { allOff: true }, openedInMs: 1900, unlockMs: null } } })[1];
  assert.ok(row.text.includes("1.9 s to open"), row.text);
});

test("gateSummary: a rendering pause alone fails the gaps row; a slow microphone open is a note", () => {
  const long = structuredClone(COMPLETE.checks.long);
  long[0].renderPauses = [{ atSec: 1200, phase: "hidden", ms: 500 }];
  const row = gateSummary({ checks: { long } })[5];
  assert.equal(row.status, "fail");
  assert.ok(row.text.includes("the app's sound paused once"), row.text);
  const mic = gateSummary({ voice: { mic: { settings: { allOff: true }, unlockMs: null, openedInMs: 2400 } } })[1];
  assert.equal(mic.status, "note");
  assert.ok(mic.text.includes("2.4 s to open"));
});

test("gateSummary: the check with your voice fails the gaps row on its outages, rendering pauses and recoveries", () => {
  const long = structuredClone(COMPLETE.checks.long);
  const voice = (extra) => ({ ...long[1], verdict: "fail", reasons: ["The app had to bring your voice back once."], ...extra });
  long[1] = voice({
    outages: [{ atSec: 120, phase: "visible", ms: 600, cause: "render-error" }],
    renderPauses: [{ atSec: 200, phase: "visible", ms: 450 }],
    recoveries: 1,
  });
  let row = gateSummary({ checks: { long } })[5];
  assert.equal(row.status, "fail");
  assert.equal(
    row.text,
    "No gaps in 31 min minimized and 29 min hidden. In the check with your voice: the app had to bring the sound back once, the app's sound paused once. Meet call still open at the end: your note (Session B step 7.5).",
  );
  for (const extra of [{ outages: [{ atSec: 3, phase: "visible", ms: 300 }] }, { renderPauses: [{ atSec: 3, ms: 300 }] }, { recoveries: 2 }]) {
    long[1] = voice(extra);
    assert.equal(gateSummary({ checks: { long } })[5].status, "fail", JSON.stringify(extra));
  }
  // A check with your voice that measured nothing counts for nothing.
  long[1] = voice({ verdict: "no-signal", reasons: ["Nothing reached “CABLE Output”: it carried only digital silence."], recoveries: 1 });
  row = gateSummary({ checks: { long } })[5];
  assert.equal(row.status, "pass", row.text);
});

test("gateSummary: a voice much quieter in CABLE Output in a delay run is a settings note on the gaps row", () => {
  const checks = (...delay) => ({ checks: { ...structuredClone(COMPLETE.checks), delay } });
  let row = gateSummary(checks(delayRun(64), delayRun(80, "auto", { levelDiffDb: -8 }), delayRun(70, "auto", { levelDiffDb: -5 })))[5];
  assert.equal(row.status, "note");
  assert.equal(
    row.text,
    "No gaps in 31 min minimized and 29 min hidden, but a setting needs changing. In “Measure the delay” the voice arrived 8.0 dB quieter in CABLE Output. In Windows sound settings (Windows key + R, type mmsys.cpl, Enter): Communications tab → “Do nothing”; Playback → CABLE Input and Recording → CABLE Output → Properties → Levels → 100. Meet call still open at the end: your note (Session B step 7.5).",
  );
  // 3 dB is fine; a run forced onto the audio element is not counted, nor is one that did not measure clearly.
  assert.equal(gateSummary(checks(delayRun(80, "auto", { levelDiffDb: -3 })))[5].status, "pass");
  assert.equal(gateSummary(checks(delayRun(80, "element", { levelDiffDb: -8 })))[5].status, "pass");
  assert.equal(gateSummary(checks({ ok: true, verdict: "unclear", estimateMs: null, levelDiffDb: -8 }))[5].status, "pass");
  // With the tone check's own setting: both. A failing row stays a fail.
  const both = checks(delayRun(80, "auto", { levelDiffDb: -8 }));
  both.checks.long[0].verdict = "fix-setting";
  both.checks.long[0].reasons = ["The meeting hears your voice 2.0 dB quieter than it should."];
  row = gateSummary(both)[5];
  assert.equal(row.status, "note");
  assert.ok(row.text.includes("2.0 dB quieter than it should. In “Measure the delay” the voice arrived 8.0 dB quieter"), row.text);
  both.checks.long[0].tone.counts.gaps = 1;
  assert.equal(gateSummary(both)[5].status, "fail");
});

test("gateSummary: other sound mixed into the test tone fails the gaps row", () => {
  const long = structuredClone(COMPLETE.checks.long);
  long[0].tone.counts.noises = 1;
  let row = gateSummary({ checks: { long } })[5];
  assert.equal(row.status, "fail");
  assert.equal(row.text, "In 31 min minimized and 29 min hidden: other sound mixed into the test tone once. Meet call still open at the end: your note (Session B step 7.5).");
  // A result whose counts have no such field: from its events, else from its reasons.
  delete long[0].tone.counts.noises;
  long[0].tone.events = [{ atSec: 1500, phase: "hidden", kind: "noise", ms: 300000 }];
  assert.ok(gateSummary({ checks: { long } })[5].text.includes("other sound mixed into the test tone once"));
  long[0].tone.events = [];
  long[0].verdict = "fail";
  long[0].reasons = longVerdict(clean({ counts: { holes: 0, skips: 0, clicks: 0, dropouts: 0, gaps: 0, noises: 1 }, events: [] })).reasons;
  row = gateSummary({ checks: { long } })[5];
  assert.equal(row.status, "fail");
  assert.ok(row.text.includes("other sound mixed into the test tone."), row.text);
});

test("gateSummary: a long check that ended early for a reason nobody chose fails the gaps row, with that reason", () => {
  const note = "“CABLE Output” stopped recording (did Windows Audio restart?), so the check ended early.";
  const early = { verdict: "fail", reasons: [note], endedEarly: { why: "cable-ended", note } };
  const long = structuredClone(COMPLETE.checks.long);
  // It ended in its last minutes, with enough of each phase and nothing wrong in them: its own verdict fails.
  Object.assign(long[0], early);
  let rows = gateSummary({ checks: { long } });
  assert.equal(rows[5].status, "fail");
  assert.equal(rows[5].text, `${note} No gaps in 31 min minimized and 29 min hidden. Meet call still open at the end: your note (Session B step 7.5).`);
  assert.equal(rows[6].status, "pass", "the clicks in the hour it recorded still count");
  // With a gap as well: both.
  long[0].tone.counts.gaps = 1;
  assert.equal(
    gateSummary({ checks: { long } })[5].text,
    `${note} In 31 min minimized and 29 min hidden: 1 gap. Meet call still open at the end: your note (Session B step 7.5).`,
  );
  long[0].tone.counts.gaps = 0;
  // A check you stopped yourself has no endedEarly: it is judged on what it recorded.
  assert.equal(gateSummary({ checks: { long: [{ ...long[0], verdict: "pass", reasons: [], endedEarly: null }] } })[5].status, "pass");
  // Too little recorded: still to do, and the row says why it ended.
  const short = { ...long[0], phases: { visibleSec: 150, minimizedSec: 1800, hiddenSec: 600 } };
  rows = gateSummary({ checks: { long: [short] } });
  assert.equal(rows[5].status, "todo");
  assert.ok(rows[5].text.includes(`The last one had 30 min minimized and 10 min hidden. ${note}`), rows[5].text);
  // A complete check after it counts.
  assert.equal(gateSummary({ checks: { long: [long[0], structuredClone(COMPLETE.checks.long[0])] } })[5].status, "pass");
  // The check with your voice ended early: it fails the row too.
  const voice = { ...structuredClone(COMPLETE.checks.long[1]), ...early };
  const row = gateSummary({ checks: { long: [structuredClone(COMPLETE.checks.long[0]), voice] } })[5];
  assert.equal(row.status, "fail");
  assert.equal(
    row.text,
    "No gaps in 31 min minimized and 29 min hidden. In the check with your voice: it ended early. Meet call still open at the end: your note (Session B step 7.5).",
  );
});

test("gateSummary: the clicks row counts a check that ended early, and says so", () => {
  const note = "“CABLE Output” stopped recording (did Windows Audio restart?), so the check ended early.";
  const long = structuredClone(COMPLETE.checks.long);
  Object.assign(long[0], { verdict: "fail", reasons: [note], endedEarly: { why: "cable-ended", note }, recordedSec: 3700 });
  const row = gateSummary({ checks: { long } })[6];
  assert.equal(row.status, "pass", row.text);
  assert.ok(row.text.endsWith(" That check ended early: these come from its first 62 min."), row.text);
});

test("gateSummary: in Edge the gaps row is judged on the time the page was not on screen", () => {
  // Edge cannot tell minimized from hidden: README's Edge run minimizes the window, and every minute of it reads
  // as hidden (platform/browser.js answers minimized: null).
  const edgeRun = { ...structuredClone(COMPLETE.checks.long[0]), phases: { visibleSec: 300, minimizedSec: 0, hiddenSec: 3600 } };
  let row = gateSummary({ shell: "browser", checks: { long: [edgeRun] } })[5];
  assert.equal(row.status, "pass", row.text);
  assert.equal(
    row.text,
    "No gaps in 60 min not on screen (Edge can't tell minimized from hidden). Meet call still open at the end: your note (Session B step 7.5).",
  );
  // The same run in the app is not enough: it had no minimized phase.
  row = gateSummary({ shell: "app", checks: { long: [edgeRun] } })[5];
  assert.equal(row.status, "todo");
  // 50 minutes not on screen are needed in Edge, whichever phase they read as; the todo text asks for that.
  const short = { ...edgeRun, phases: { visibleSec: 300, minimizedSec: 600, hiddenSec: 2399 } };
  row = gateSummary({ shell: "browser", checks: { long: [short] } })[5];
  assert.equal(row.status, "todo");
  assert.equal(
    row.text,
    "Run the long check with the Edge window minimized (Session B step 7): it needs 50 min not on screen (Edge can't tell minimized from hidden). The last one was 50 min not on screen. Meet call still open at the end: your note (Session B step 7.5).",
  );
  short.phases.hiddenSec = 2400;
  assert.equal(gateSummary({ shell: "browser", checks: { long: [short] } })[5].status, "pass");
  // A gap fails it as anywhere.
  edgeRun.tone.counts.gaps = 1;
  row = gateSummary({ shell: "browser", checks: { long: [edgeRun] } })[5];
  assert.equal(row.status, "fail");
  assert.ok(row.text.startsWith("In 60 min not on screen (Edge can't tell minimized from hidden): 1 gap."), row.text);
});

test("gateSummary: the gaps row counts every long drop-out of a check with your voice, not only those among its first 50", () => {
  // 50 short drop-outs first (the list keeps only them), then a long one: the check itself failed on it.
  const short = Array.from({ length: 50 }, (_, k) => ({ atSec: 10 + k, phase: "minimized", ms: 9 }));
  const voice = {
    ...structuredClone(COMPLETE.checks.long[1]),
    verdict: "fail",
    reasons: ["CABLE Output dropped out once (the longest for 45 ms)."],
    speech: { gaps: [], dropouts: short, dropoutCount: 51, longDropoutCount: 1 },
  };
  let row = gateSummary({ checks: { long: [structuredClone(COMPLETE.checks.long[0]), voice] } })[5];
  assert.equal(row.status, "fail", row.text);
  assert.ok(row.text.includes("In the check with your voice: 1 drop-out."), row.text);
  // Results made before the count was kept: the list is what there is.
  delete voice.speech.longDropoutCount;
  voice.speech.dropouts = [...short.slice(0, 49), { atSec: 70, phase: "minimized", ms: 45 }];
  row = gateSummary({ checks: { long: [structuredClone(COMPLETE.checks.long[0]), voice] } })[5];
  assert.equal(row.status, "fail", row.text);
});

test("gateSummary: a check with your voice forced onto the audio element is a comparison, not counted in the gaps row", () => {
  const voice = { ...structuredClone(COMPLETE.checks.long[1]), routePreference: "element", speech: { gaps: [{ atSec: 30, holeMs: 300 }], dropouts: [] } };
  const row = gateSummary({ checks: { long: [structuredClone(COMPLETE.checks.long[0]), voice] } })[5];
  assert.equal(row.status, "pass", row.text);
  voice.routePreference = "auto";
  assert.equal(gateSummary({ checks: { long: [structuredClone(COMPLETE.checks.long[0]), voice] } })[5].status, "fail");
});

test("gateSummary: the user's own route switches under Advanced are no note; the app's own route changes are", () => {
  const voice = (routeChanges, extra = {}) => ({ voice: { output: { method: "context", routePreference: "auto", routeChanges, ...extra } } });
  // Session B step 7.6: to the audio element and back, both the user's choice ("route").
  const yours = [
    { at: "t1", from: "context", to: "element", cause: "route" },
    { at: "t2", from: "element", to: "context", cause: "route" },
  ];
  let row = gateSummary(voice(yours))[2];
  assert.equal(row.status, "pass", row.text);
  assert.equal(row.text, "Sent through the app's audio engine. You switched the route twice under Advanced (your comparison run).");
  // The app moved the voice onto the audio element by itself (a recovery): to discuss.
  row = gateSummary(voice([{ at: "t1", from: "context", to: "element", cause: "render-error" }], { method: "element" }))[2];
  assert.equal(row.status, "note");
  assert.equal(
    row.text,
    "Sent through a slower backup route. It works, but this route may add delay or clicks. The app changed the route by itself once during the session: to discuss.",
  );
  // Left on the forced route: the row says so.
  row = gateSummary(voice([yours[0]], { method: "element", routePreference: "element" }))[2];
  assert.equal(row.status, "pass");
  assert.ok(row.text.includes("It is the one you chose under Advanced: set it back to Automatic."), row.text);
});

test("gateSummary: a check that did not run on the route chosen counts for no row", () => {
  // Automatic chosen during an outage on the audio element route: until the voice is back on the app's engine,
  // a check is neither the normal route nor a comparison.
  const notChosen = { routePreference: "auto", routeAsChosen: false };
  let rows = gateSummary({ checks: { delay: [{ ...delayRun(150), ...notChosen }, delayRun(80)] } });
  assert.equal(rows[4].status, "pass", rows[4].text);
  assert.equal(rows[4].text, "One measurement: about 80 ms (± 10).");
  const long = structuredClone(COMPLETE.checks.long);
  Object.assign(long[0], notChosen, { tone: { counts: { gaps: 2, dropouts: 0 } } });
  rows = gateSummary({ checks: { long } });
  assert.equal(rows[5].status, "todo", rows[5].text);
  assert.equal(rows[6].status, "todo", rows[6].text);
  // Forced onto the audio element but run on the engine: not a comparison either.
  rows = gateSummary({ checks: { delay: [{ ...delayRun(140, "element"), routeAsChosen: false }] } });
  assert.ok(!rows[4].text.includes("not counted"), rows[4].text);
});

test("gateSummary: a step number in the checklist is Session B's, and names the place on the page", () => {
  const rows = gateSummary({});
  const texts = rows.map((r) => r.text);
  for (const t of texts) {
    for (const m of t.matchAll(/step (\d+(?:\.\d+)?)/g)) {
      const before = t.slice(0, m.index);
      assert.ok(before.endsWith("Session B ") || / of this page/.test(t.slice(m.index, m.index + 30)), `${m[0]} in: ${t}`);
    }
  }
  assert.equal(rows[4].text, "Press “Measure the delay” in step 3 of this page (Session B step 6).");
  assert.equal(rows[7].text, "Restart Windows Audio (Session B step 9), then wait for a new line under Recoveries in step 2 of this page.");
  assert.equal(rows[8].text, "Press “Connect only” in step 5 of this page (Session B step 10).");
  assert.equal(rows[3].text, "Your note from Session B step 5: did Zoom's Test Mic play your voice back?");
  assert.equal(gateSummary({ sanas: { ok: false } })[8].text, "Sanas did not accept the connection: see step 5 of this page.");
});

test("gateSummary: exactly 25 minutes in each phase, and a tone check of exactly 30 minutes, count", () => {
  const long = structuredClone(COMPLETE.checks.long);
  long[0].phases = { visibleSec: 0, minimizedSec: 1500, hiddenSec: 1500 };
  long[0].recordedSec = 1800;
  let rows = gateSummary({ checks: { long } });
  assert.equal(rows[5].status, "pass", rows[5].text);
  assert.equal(rows[6].status, "pass", rows[6].text);
  long[0].phases.hiddenSec = 1499;
  long[0].recordedSec = 1799;
  rows = gateSummary({ checks: { long } });
  assert.equal(rows[5].status, "todo");
  assert.equal(rows[6].status, "todo");
});

test("gateSummary: with a noise gate the clicks row counts the holes seen as a lower bound, as the check's own verdict does", () => {
  const long = structuredClone(COMPLETE.checks.long);
  const at = (micPath, noiseGate = true) => {
    long[0].micPath = { ...micPath, noiseGate };
    return gateSummary({ checks: { long } })[6];
  };
  const hides = " Your microphone's noise gate hides the clicks a slower clock makes: I decide with the details.";
  // Flat over 65 minutes with 3 holes seen: the clock is not faster, and a slower one's other holes may hide in the
  // gate's silence. 1.4 per 30 minutes is a lower bound: a note, never a pass, and never "about 0.0".
  const flat = micClock(readings(() => 20, 105, { minutes: 65 }), { holes: 3, durationSec: 3900 });
  let row = at(flat);
  assert.equal(row.status, "note");
  assert.equal(row.text, `The meeting's side: about 2.5 per 30 min; your microphone's side: not measured, at least 1.4 per 30 min (6 at most each).${hides}`);
  // Without the gate the same holes are the whole count, and pass.
  row = at(flat, false);
  assert.equal(row.status, "pass");
  assert.ok(row.text.includes("your microphone's side: about 1.4 per 30 min"), row.text);
  // A result that kept only the spec's fields has its slope worked out again from its readings.
  const { slopePpm, slopeIsLowerBound, ...kept } = flat;
  assert.ok(Number.isFinite(slopePpm) && slopeIsLowerBound === false);
  row = at(kept);
  assert.equal(row.status, "note");
  assert.ok(row.text.includes("your microphone's side: not measured, at least 1.4 per 30 min"), row.text);
  // No hole seen: not measured.
  row = at(micClock(readings(() => 20, 105, { minutes: 65 }), { holes: 0, durationSec: 3900 }));
  assert.equal(row.status, "note");
  assert.ok(row.text.includes(`your microphone's side: not measured (6 at most each).${hides}`), row.text);
  // 17 holes seen (7.8 per 30 minutes): too many even as a lower bound.
  row = at(micClock(readings(() => 20, 105, { minutes: 65 }), { holes: 17, durationSec: 3900 }));
  assert.equal(row.status, "fail");
  assert.equal(
    row.text,
    "The meeting's side: about 2.5 per 30 min; your microphone's side: at least 7.8 per 30 min (6 at most each). Run the comparison through the audio element (Session B step 7.6).",
  );
  // Too few readings: not measured, with or without holes (3 in 65 minutes: at least 1.4).
  row = at(micClock(readings(() => 20, 108, { minutes: 4 }), { holes: 0, durationSec: 3900 }));
  assert.equal(row.status, "note");
  assert.ok(row.text.includes("your microphone's side: not measured (6 at most each)."), row.text);
  row = at(micClock(readings(() => 20, 108, { minutes: 4 }), { holes: 3, durationSec: 3900 }));
  assert.equal(row.status, "note");
  assert.ok(row.text.includes("your microphone's side: not measured, at least 1.4 per 30 min"), row.text);
  // Faster: a faster clock makes no holes, so the road is measured: the drops from the slope, plus the holes seen.
  const faster = micClock(readings((t) => Math.min(60, 10 + 0.02 * t), 101), { holes: 0, durationSec: 3900 });
  row = at(faster);
  assert.equal(row.status, "pass", row.text);
  assert.ok(row.text.includes(`your microphone's side: about ${(Math.round(faster.slopePpm * 1.8) / 10).toFixed(1)} per 30 min`), row.text);
  assert.equal(at(micClock(readings((t) => Math.min(60, 10 + 0.02 * t), 101), { holes: 14, durationSec: 3900 })).status, "fail");
  assert.equal(at(micClock(readings((t) => Math.min(80, 10 + 0.08 * t), 102), { holes: 0, durationSec: 3900 })).status, "fail");
});

test("longVerdict and gateSummary: a microphone buffer that had already filled is not measured, never a pass", () => {
  // 50 ppm faster (9 drops per 30 minutes), its buffer full from the first reading: the slope is flat.
  const full = micClock(readings(h1(50, { ageSec: 1200 }), 221, { minutes: 65 }), { holes: 0, durationSec: 3900 });
  const text = "The microphone's clock could not be measured: its buffer had already filled when the check began.";
  const long = structuredClone(COMPLETE.checks.long);
  for (const micZeroFraction of [0.001, 0.05]) {
    const v = longVerdict(clean({ micPath: full, micZeroFraction }));
    assert.ok(v.lines.includes(text), v.lines.join(" | "));
    assert.ok(!v.lines.some((l) => l.startsWith("Clicks from your microphone's side")), v.lines.join(" | "));
    long[0].micPath = { ...full, noiseGate: micZeroFraction >= LIMITS.NOISE_GATE_FRACTION };
    const row = gateSummary({ checks: { long } })[6];
    assert.equal(row.status, "note", row.text);
    assert.ok(row.text.includes("your microphone's side: not measured"), row.text);
  }
});

test("cable-check.js is pure: no clock, timer, console or DOM", () => {
  const code = readFileSync(new URL("../src/core/cable-check.js", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.doesNotMatch(code, /Date\.now|performance\.|new Date|setTimeout|setInterval|requestAnimationFrame|console\.|document\.|window\.|navigator\.|globalThis/);
});
