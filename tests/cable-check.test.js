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
  phaseTimeline,
  renderPauses,
  restartVerdict,
  sampleLag,
  stopAfterHide,
} from "../src/core/cable-check.js";
import { EnvelopeStream, ZeroRuns } from "../src/core/signal-watch.js";
import { rng, synthSpeech, whiteNoise } from "./helpers/synth.js";

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
});

test("delayVerdict: notes for a quiet cable and for a microphone buffer that grew", () => {
  let v = delayVerdict(run(60, { levelDiffDb: -6.24 }));
  assert.deepEqual(v.notes, [
    "The voice arrives 6.2 dB quieter in CABLE Output: check that CABLE Input and CABLE Output are at 100 % in Windows sound settings, and that Communications is set to “Do nothing”.",
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

// ---------- the microphone's clock ----------

/** Readings every 120 s for 60 min of lag(t) plus seeded uniform ± 10 ms. */
function readings(lagAt, seed, { micGen = 1, every = 120, minutes = 60 } = {}) {
  const rand = rng(seed);
  const out = [];
  for (let t = 0; t <= minutes * 60; t += every) out.push({ atSec: t, lagMs: lagAt(t) + (rand() * 2 - 1) * 10, micGen });
  return out;
}

test("micClock: a microphone 20 ppm faster fills its buffer, then saturates", () => {
  const r = micClock(readings((t) => Math.min(60, 10 + 0.02 * t), 101), { holes: 0, durationSec: 3600 });
  assert.equal(r.direction, "faster");
  assert.ok(r.saturatedAtSec >= 1200 && r.saturatedAtSec <= 3000, `saturatedAtSec ${r.saturatedAtSec}`);
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
  const r = micClock(readings((t) => Math.min(80, 10 + 0.08 * t), 102), { durationSec: 3600 });
  assert.equal(r.direction, "faster");
  assert.ok(r.ppm >= 45, `ppm ${r.ppm}`);
  assert.ok(r.dropsPer30Min > 6, `dropsPer30Min ${r.dropsPer30Min}`);
});

test("micClock: a buffer full within minutes gives a lower bound", () => {
  const r = micClock(readings((t) => Math.min(100, 10 + 0.2 * t), 103), { durationSec: 3600 });
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

test("micClock: three readings say nothing", () => {
  const r = micClock(readings(() => 20, 108, { minutes: 4 }), { holes: 0, durationSec: 240 });
  assert.equal(r.readings.length, 3);
  assert.equal(r.ppm, null);
  assert.equal(r.direction, null);
  assert.equal(r.ticksPer30Min, 0);
  assert.equal(micClock([], { durationSec: 0 }).direction, null);
  assert.equal(micClock(null).ppm, null);
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
 * every step (steps fall on 100 ms blocks), with `holes` ([atSec, ms] in
 * CABLE Output's time) of zeros.
 */
function micRun({ seconds, lagMs = 40, stepEverySec = 0, holes = [] }) {
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
    const lag = Math.round((lagMs * SR) / 1000) + (stepEverySec ? 480 * Math.floor(start / (stepEverySec * SR)) : 0);
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
  r = clockFromEvents([{ kind: "skip", atSec: 10 }], 1800);
  assert.equal(r.ticksPer30Min, 1);
  near(r.ppm, 5.56, 0.01, "ppm from one event");
  assert.equal(r.direction, "faster");
  r = clockFromEvents([{ kind: "click", atSec: 10 }, { kind: "level", atSec: 20 }], 900);
  assert.equal(r.ticksPer30Min, 2);
  assert.equal(r.direction, null);
  assert.deepEqual(clockFromEvents([], 1800), { ppm: 0, direction: null, ticksPer30Min: 0 });
  assert.deepEqual(clockFromEvents([], 0), { ppm: null, direction: null, ticksPer30Min: null });
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
  assert.equal(v.tonePath.direction, "faster");
  near(v.tonePath.ticksPer30Min, 1800 / 3900, 1e-9, "one skip in 65 min");
  near(v.tonePath.ppm, 1e4 / 3900, 1e-9, "one 10 ms skip in 3900 s");
  assert.deepEqual(v.lines, [
    "65 min recorded: 31 min minimized, 29 min hidden, 5 min open.",
    "Gaps: none.",
    "Clicks from the meeting's side of the sound: 1 (about 0.5 per 30 minutes; Windows' default playback device and VB-CABLE differ by about 3 ppm).",
    "Clicks from your microphone's side: about 0.5 per 30 minutes (its clock runs 3 ppm slower than VB-CABLE's).",
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
  assert.equal(v.lines[3], "Clicks from your microphone's side: about 7.0 per 30 minutes (its clock runs 39 ppm faster than VB-CABLE's).");
});

test("longVerdict: a microphone with a noise gate skips the hole rules and says so", () => {
  const holes = 14;
  const micPath = micClock(readings(() => 20, 105), { holes, durationSec: 3900 });
  assert.ok(micPath.ticksPer30Min > 6, "the holes alone would fail");
  const refRuns = [{ startFrame: 600 * SR, frames: 150 * 48 }];
  let v = longVerdict(clean({ micPath, refRuns, micZeroFraction: 0.05 }));
  assert.equal(v.verdict, "pass", JSON.stringify(v.reasons));
  assert.ok(
    v.lines.includes(
      "Your microphone sends digital silence in pauses (a noise gate?), so pauses and short drop-outs in the microphone itself could not be checked.",
    ),
  );
  assert.ok(v.lines.includes("The microphone's clock could not be measured (the check was too short)."));
  // Without the noise gate both rules apply.
  v = longVerdict(clean({ micPath, refRuns, micZeroFraction: 0.001 }));
  assert.deepEqual(v.reasons, [
    "Too many clicks from your microphone's side: about 6.5 per 30 minutes (6 at most).",
    "The microphone itself stopped once (the longest for 150 ms): Windows paused it.",
  ]);
});

test("longVerdict: a tone 2 dB too quiet needs a setting changed; 0.8 dB is fine", () => {
  let v = longVerdict(clean({ tone: { lockDb: -14, minStableDb: -14 } }));
  assert.equal(v.verdict, "fix-setting");
  assert.deepEqual(v.reasons, [
    "The meeting hears your voice 2.0 dB quieter than it should: in Windows sound settings set Communications to “Do nothing”, set CABLE Input and CABLE Output to 100 %, and in Zoom untick “Automatically adjust microphone volume”. Then run the check again.",
  ]);
  v = longVerdict(clean({ tone: { lockDb: -12.8, minStableDb: -12.8 } }));
  assert.equal(v.verdict, "pass");
});

test("longVerdict: Windows turning the voice down during the check needs a setting changed", () => {
  const v = longVerdict(clean({ levelChanges: [{ atSec: 330, fromDb: -12, toDb: -26 }] }));
  assert.equal(v.verdict, "fix-setting");
  assert.deepEqual(v.reasons, [
    "Windows turned the voice down by 14.0 dB at 5:30, probably when the meeting started: in Windows sound settings set Communications to “Do nothing”. Then run the check again.",
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
  assert.equal(v.verdict, "pass", "no speech: only the zero runs are checked");
  assert.ok(v.lines.includes("No speech was heard, so only the silence was checked."));
});

test("longVerdict: at most 10 lines, and safe with nothing", () => {
  const v = longVerdict(clean({ late: { count: 5, maxMs: 3000 }, micZeroFraction: 0.5 }));
  assert.ok(v.lines.length <= 10);
  const empty = longVerdict(undefined);
  assert.equal(empty.verdict, "no-signal");
  assert.ok(empty.lines.length >= 1);
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
  assert.equal(slow.text, "fail (back after 3.0 s; the app's own part took 1200 ms: 300 ms of waiting, then 900 ms to rebuild)");
  const unknown = restartVerdict({ outageMs: 2500, lostAtMs: 0, serviceBackAtMs: null, appMs: null, waitMs: null });
  assert.equal(unknown.verdict, "fail");
  assert.equal(unknown.text, "fail (back after 2.5 s; the app could not tell when Windows Audio was running again)");
  assert.equal(restartVerdict(null).verdict, "fail");
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
      "No clock-crossing clicks",
      "Windows Audio restart: back within 2 s",
      "Connect only",
    ],
  );
  assert.deepEqual(statuses(rows), ["pass", "pass", "pass", "todo", "pass", "pass", "pass", "pass", "pass"]);
  assert.equal(rows[4].text, "The highest of 3 measurements: about 93 ms (± 10). Through the audio element (not counted): 140 ms.");
  assert.ok(rows[5].text.includes("31 min minimized and 29 min hidden"));
  assert.ok(rows[5].text.endsWith("Meet call still open at the end: your note (step 7.5)."));
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

test("cable-check.js is pure: no clock, timer, console or DOM", () => {
  const code = readFileSync(new URL("../src/core/cable-check.js", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.doesNotMatch(code, /Date\.now|performance\.|new Date|setTimeout|setInterval|requestAnimationFrame|console\.|document\.|window\.|navigator\.|globalThis/);
});
