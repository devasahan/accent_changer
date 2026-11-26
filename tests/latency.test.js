import test from "node:test";
import assert from "node:assert/strict";
import { LatencyTracker } from "../src/core/latency.js";
import { envelopeDb, estimateDelayFromEnvelopes, percentile } from "../src/core/delay-estimate.js";
import { addNoise, delayed, recolour, rng, synthSpeech } from "./helpers/synth.js";

const HOP = 5;
const CHUNK = 50; // frames per push: the mixer sends envelopes about every 250 ms
const LONG_SR = 16000; // the long takes are made at 16 kHz: the same envelopes, 3x cheaper to make

/**
 * What the engine might send back: the take `delayMs` later in a darker,
 * quieter voice whose loudness wobbles against the original by up to ±6 dB
 * (another speaker's syllables), over a faint noise floor.
 */
function converted(samples, sampleRate, delayMs, seed) {
  return engineVoice(delayed(samples, Math.round((delayMs * sampleRate) / 1000)), sampleRate, seed);
}

/**
 * As converted(), with a delay that moves: dAt(sec) gives the delay (ms) of
 * the converted voice arriving at that moment, null while nothing arrives (a
 * stall). A jitter buffer that grows or drains stretches or squeezes the
 * voice by that much.
 */
function convertedVarying(samples, sampleRate, dAt, seed) {
  const y = new Float32Array(samples.length);
  for (let n = 0; n < y.length; n++) {
    const d = dAt(n / sampleRate);
    if (d === null) continue;
    const pos = n - (d * sampleRate) / 1000;
    const i = Math.floor(pos);
    const f = pos - i;
    if (i >= 0 && i + 1 < samples.length) y[n] = samples[i] * (1 - f) + samples[i + 1] * f;
  }
  return engineVoice(y, sampleRate, seed);
}

/** The engine's voice for converted(): darker, -6 dB, ±6 dB wobble every 40 ms, a -60 dB floor. */
function engineVoice(delayedSamples, sampleRate, seed) {
  const x = recolour(delayedSamples, sampleRate, {
    cutoffHz: 1000,
    gainDb: -6,
  });
  const rand = rng(seed);
  const step = Math.round(0.04 * sampleRate);
  let g0 = 1;
  let g1 = 1;
  for (let i = 0; i < x.length; i++) {
    if (i % step === 0) {
      g0 = g1;
      g1 = 10 ** (((rand() * 2 - 1) * 6) / 20);
    }
    x[i] *= g0 + ((g1 - g0) * (i % step)) / step;
  }
  return addNoise(x, -60, seed + 1);
}

const env = (samples, sampleRate, hopMs = HOP) => envelopeDb(samples, sampleRate, { hopMs }).db;

/**
 * Push the envelopes in mixer-sized chunks, calling update() after each.
 * `each(tracker, sec, result)` runs after every chunk (sec = stream time at
 * its end), `before(tracker, sec)` before it (sec = its start).
 */
function feed(tracker, orig, conv, each = () => {}, { chunk = CHUNK, hopMs = HOP, startSec = 0, before = null } = {}) {
  for (let i = 0; i < orig.length; i += chunk) {
    if (before) before(tracker, startSec + (i * hopMs) / 1000);
    tracker.push(orig.subarray(i, i + chunk), conv.subarray(i, i + chunk));
    const r = tracker.update();
    each(tracker, startSec + ((i + Math.min(chunk, orig.length - i)) * hopMs) / 1000, r);
  }
}

// ---------- real signals ----------

test("locks within ±10 ms at the first estimate (3 s), for delays from 0 to 800 ms, then follows locally", () => {
  for (const [seed, sampleRate] of [
    [1, 48000],
    [2, LONG_SR],
  ]) {
    const { samples } = synthSpeech({ sampleRate, seconds: 13, seed });
    const orig = env(addNoise(samples, -65, seed + 10), sampleRate);
    for (const D of [0, 120, 250, 312, 450, 600, 800]) {
      const conv = env(converted(samples, sampleRate, D, seed * 1000 + D), sampleRate);
      const t = new LatencyTracker();
      const results = [];
      feed(t, orig, conv, (tr, sec, r) => {
        if (sec < 3) assert.equal(tr.delayMs, null, `seed ${seed}, ${D} ms: no delay before the first estimate`);
        if (r) results.push({ sec, ...r });
      });
      const label = `seed ${seed}, ${D} ms: ${JSON.stringify(results)}`;
      assert.equal(results.length, 4, label);
      assert.equal(results[0].sec, 3, label);
      assert.equal(results[0].method, "full", label);
      for (const r of results) {
        assert.equal(r.accepted, true, label);
        assert.ok(Math.abs(r.ms - D) <= 10, label);
      }
      assert.deepEqual(
        results.slice(1).map((r) => r.method),
        ["local", "local", "local"],
        label,
      );
      assert.equal(t.locked, true);
      assert.ok(Math.abs(t.delayMs - D) <= 10, label);
      assert.deepEqual(
        t.history.map((h) => h.atSec),
        [3, 6, 9, 12],
      );
    }
  }
});

test("works at another envelope spacing (10 ms hops)", () => {
  const { samples } = synthSpeech({ sampleRate: LONG_SR, seconds: 12, seed: 3 });
  const orig = env(addNoise(samples, -65, 13), LONG_SR, 10);
  const conv = env(converted(samples, LONG_SR, 312, 7), LONG_SR, 10);
  const t = new LatencyTracker({ hopMs: 10 });
  const results = [];
  feed(t, orig, conv, (tr, sec, r) => r && results.push({ sec, ...r }), { chunk: 25, hopMs: 10 });
  assert.equal(results[0].sec, 3);
  assert.ok(results.length >= 3 && results.every((r) => r.accepted && Math.abs(r.ms - 312) <= 10), JSON.stringify(results));
});

test("returns null without speech, and never locks", () => {
  const seconds = 30;
  const n = seconds * LONG_SR;
  const { samples } = synthSpeech({ sampleRate: LONG_SR, seconds, seed: 5 });
  const roomNoise = env(addNoise(new Float32Array(n), -62, 1), LONG_SR);
  const engineFloor = env(addNoise(new Float32Array(n), -80, 2), LONG_SR);
  const speech = env(addNoise(samples, -65, 3), LONG_SR);
  const zeros = env(new Float32Array(n), LONG_SR);
  const comfortNoise = env(addNoise(new Float32Array(n), -50, 4), LONG_SR);
  // A knock on the desk every 4 s, heard on both sides: loud enough to pass the tracker's own
  // sound checks, so the search runs, and finds no speech-like signal.
  const knocks = (db, level, offset) => db.map((v, i) => ((i - offset) % 800 === 0 ? level : v));
  const cases = {
    "a quiet room, nothing back": [roomNoise, engineFloor, 0],
    "speech, digital silence back (the engine sends nothing)": [speech, zeros, 0],
    "speech, steady comfort noise back": [speech, comfortNoise, 0],
    "digital silence both ways": [zeros, zeros, 0],
    "a quiet room, speech back (not the user's)": [roomNoise, speech, 0],
    "desk knocks in a quiet room, both sides": [knocks(roomNoise, -30, 0), knocks(engineFloor, -40, 60), 5],
  };
  for (const [name, [orig, conv, searched]] of Object.entries(cases)) {
    let calls = 0;
    const estimate = (...args) => {
      calls++;
      return estimateDelayFromEnvelopes(...args);
    };
    const t = new LatencyTracker({ estimate });
    feed(t, orig, conv, (tr, sec, r) => assert.equal(r, null, `${name} at ${sec} s`));
    assert.equal(t.delayMs, null, name);
    assert.equal(t.locked, false, name);
    assert.deepEqual(t.history, [], name);
    assert.equal(t.lipSyncTotalMs(), null, name);
    if (searched) assert.ok(calls >= searched, `${name}: the search ran (${calls}) and found nothing`);
    else assert.equal(calls, 0, `${name}: nothing to compare, so no search ran`);
  }
});

/** Envelope of a tile with exactly one frame per hop (padded by one hop), so tiles join without a seam. */
function tileEnvelope(samples, sampleRate) {
  const hop = (sampleRate * HOP) / 1000;
  const padded = new Float32Array(samples.length + hop);
  padded.set(samples);
  return env(padded, sampleRate);
}

/** `db` `frames` frames later, the gap at the start filled with its first frame (the tile's quiet lead-in). */
function later(db, frames) {
  const out = new Float32Array(db.length);
  out.fill(db[0], 0, frames);
  out.set(db.subarray(0, db.length - frames), frames);
  return out;
}

test("follows a delay stepping ±10 ms every few minutes through a 60-minute interview, within ±10 ms, in < 5 s", () => {
  // An interview: answers of 30-60 s (15 s takes of speech) and questions of 10-40 s (the user
  // silent). The delay steps 10 ms up or down at the start of an answer every 2-4 minutes. Every
  // delay is 2 ms past a whole 5 ms frame, so the converted takes are made once, 2 ms late, and
  // then shifted by whole frames.
  const TILE_SEC = 15;
  const QUIET_SEC = 5;
  const tiles = [];
  for (let k = 0; k < 5; k++) {
    const { samples } = synthSpeech({ sampleRate: LONG_SR, seconds: TILE_SEC, seed: 300 + k, leadSec: 0.2, tailSec: 0.8 });
    tiles.push({
      orig: tileEnvelope(addNoise(samples, -65, 400 + k), LONG_SR),
      conv2: tileEnvelope(converted(samples, LONG_SR, 2, 500 + k), LONG_SR),
    });
  }
  const convFor = (k, D) => later(tiles[k].conv2, (D - 2) / HOP);
  const quietOrig = tileEnvelope(addNoise(new Float32Array(QUIET_SEC * LONG_SR), -65, 77), LONG_SR);
  const quietConv = tileEnvelope(addNoise(new Float32Array(QUIET_SEC * LONG_SR), -60, 78), LONG_SR);

  const rand = rng(2026);
  const segments = []; // { k (tile, -1 = question), D, turnStart }
  let sec = 0;
  let D = 312;
  let nextStepSec = 150;
  let lastTile = -1;
  const steps = [];
  while (sec < 3600) {
    if (sec >= nextStepSec) {
      const next = Math.min(402, Math.max(262, D + (rand() < 0.5 ? -10 : 10)));
      steps.push(next - D);
      D = next;
      nextStepSec = sec + 120 + rand() * 120;
    }
    const takes = 2 + Math.floor(rand() * 3);
    for (let i = 0; i < takes && sec < 3600; i++) {
      let k;
      do k = Math.floor(rand() * tiles.length);
      while (k === lastTile);
      lastTile = k;
      segments.push({ k, D, turnStart: i === 0 });
      sec += TILE_SEC;
    }
    const quiet = 2 + Math.floor(rand() * 7);
    for (let i = 0; i < quiet && sec < 3600; i++) {
      segments.push({ k: -1 });
      sec += QUIET_SEC;
    }
  }
  assert.ok(steps.includes(10) && steps.includes(-10) && steps.length >= 12, `steps ${steps}`);

  const searches = { full: 0, local: 0 };
  const estimate = (orig, conv, hopMs, opts) => {
    searches[opts.maxLagMs - opts.minLagMs > 120 ? "full" : "local"]++;
    return estimateDelayFromEnvelopes(orig, conv, hopMs, opts);
  };
  const t = new LatencyTracker({ estimate });
  let now = 0;
  let current = null; // delay of the current (or last) answer
  let previous = null; // delay of the answer before it
  let answerStart = 0;
  // CPU time, not wall-clock time: `npm test` runs the test files side by side, and on a busy
  // machine the same work can take several times as long by the clock.
  const started = process.cpuUsage();
  for (const s of segments) {
    if (s.k >= 0 && s.turnStart) {
      previous = current ?? s.D;
      current = s.D;
      answerStart = now;
    }
    const orig = s.k >= 0 ? tiles[s.k].orig : quietOrig;
    const conv = s.k >= 0 ? convFor(s.k, s.D) : quietConv;
    feed(
      t,
      orig,
      conv,
      (tr, at) => {
        if (at < 3) return;
        assert.notEqual(tr.delayMs, null, `locked by the first estimate (${at} s)`);
        // Right after a step the window still holds speech at the previous delay.
        const err = Math.min(Math.abs(tr.delayMs - current), Math.abs(tr.delayMs - previous));
        assert.ok(err <= 10, `at ${at.toFixed(2)} s: D ${tr.delayMs}, true ${current} (before: ${previous})`);
        if (s.k >= 0 && at - answerStart >= 15.25) {
          // A whole window of this answer and an estimate on it: settled on the true delay.
          assert.ok(Math.abs(tr.delayMs - current) <= 5, `at ${at.toFixed(2)} s: D ${tr.delayMs}, true ${current}`);
        }
      },
      { startSec: now },
    );
    now += orig.length * (HOP / 1000);
  }
  const used = process.cpuUsage(started);
  const cpuMs = (used.user + used.system) / 1000;
  assert.ok(Math.abs(now - 3600) < 15, `simulated ${now} s`);
  assert.ok(searches.full <= 2, `whole-range searches: ${searches.full} (the lock only)`);
  assert.ok(searches.local > 500, `local searches: ${searches.local}`);
  assert.ok(cpuMs < 5000, `tracking the hour used ${cpuMs.toFixed(0)} ms of CPU time`);
  const p95 = percentile(
    t.history.map((h) => h.ms),
    95,
  );
  const L = t.lipSyncTotalMs();
  assert.ok(Number.isInteger(L) && L >= p95 + 30 - 1e-9 && L < p95 + 31, `L ${L}, p95 ${p95}`);
});

/** A take (50 s); the converted voice switches from `d1` to `d2` in the pause before the first sentence after 20 s. */
function jumpTake(seed, d1, d2, { gapSec = 0, seconds = 50 } = {}) {
  const sp = synthSpeech({ sampleRate: LONG_SR, seconds, seed });
  const u = sp.utterances.find((x) => x.start > 20);
  const at = Math.round((u.start - 0.3) * LONG_SR);
  const conv = new Float32Array(sp.samples.length);
  const a = converted(sp.samples, LONG_SR, d1, seed + 100);
  const b = converted(sp.samples, LONG_SR, d2, seed + 200);
  const cut1 = at + Math.round((d1 * LONG_SR) / 1000);
  const cut2 = at + Math.round((d2 * LONG_SR) / 1000);
  conv.set(a.subarray(0, cut1));
  conv.set(b.subarray(cut2), cut2);
  if (gapSec) conv.fill(0, at, at + Math.round(gapSec * LONG_SR)); // the reconnect
  return {
    orig: env(addNoise(sp.samples, -65, seed + 10), LONG_SR),
    conv: env(conv, LONG_SR),
    jumpSec: at / LONG_SR,
  };
}

test("a delay that jumps far is found by whole-range searches; D moves once, straight to it", () => {
  for (const [seed, d1, d2] of [
    [1, 300, 650],
    [3, 280, 420],
    [4, 400, 250],
  ]) {
    const { orig, conv, jumpSec } = jumpTake(seed, d1, d2);
    const t = new LatencyTracker();
    let movedSec = null;
    const after = [];
    feed(t, orig, conv, (tr, sec, r) => {
      if (r && sec > jumpSec) after.push(r);
      if (sec < 3) return;
      const label = `seed ${seed} at ${sec} s: D ${tr.delayMs}`;
      if (movedSec === null && Math.abs(tr.delayMs - d2) <= 10) movedSec = sec;
      if (movedSec === null) assert.ok(Math.abs(tr.delayMs - d1) <= 10, label);
      else assert.ok(Math.abs(tr.delayMs - d2) <= 10, label); // and never back, never in between
    });
    assert.ok(movedSec !== null && movedSec - jumpSec <= 20, `seed ${seed}: moved ${movedSec && movedSec - jumpSec} s after the jump`);
    // The move took three whole-range estimates in a row that agreed on the new delay.
    const k = after.findIndex((r) => r.accepted && Math.abs(r.ms - d2) <= 10);
    const label = `seed ${seed}: ${JSON.stringify(after)}`;
    assert.ok(k >= 2, label);
    assert.deepEqual(
      after.slice(k - 2, k + 1).map((r) => [r.method, r.accepted, Math.abs(r.ms - d2) <= 10]),
      [
        ["full", false, true],
        ["full", false, true],
        ["full", true, true],
      ],
      label,
    );
  }
});

test("relock() after a reconnect takes the new delay at the next estimate and keeps the old one meanwhile", () => {
  for (const [seed, d1, d2] of [
    [4, 300, 650],
    [5, 350, 180],
    [6, 300, 520],
  ]) {
    const { orig, conv, jumpSec } = jumpTake(seed, d1, d2, { gapSec: 1, seconds: 35 });
    const t = new LatencyTracker();
    let relockedSec = null;
    let movedSec = null;
    feed(
      t,
      orig,
      conv,
      (tr, sec) => {
        if (sec < 3) return;
        if (relockedSec === null || movedSec !== null) return;
        if (Math.abs(tr.delayMs - d2) <= 10) movedSec = sec;
        else assert.ok(Math.abs(tr.delayMs - d1) <= 10, `seed ${seed} at ${sec} s: the old D is kept until the new one is found`);
      },
      {
        before: (tr, sec) => {
          if (relockedSec === null && sec >= jumpSec) {
            assert.ok(Math.abs(tr.delayMs - d1) <= 10);
            tr.relock();
            relockedSec = sec;
            assert.equal(tr.locked, false);
            assert.ok(Math.abs(tr.delayMs - d1) <= 10, "D kept");
          }
        },
      },
    );
    assert.ok(movedSec !== null && movedSec - relockedSec <= 3.25, `seed ${seed}: found ${movedSec - relockedSec} s after relock()`);
    assert.ok(Math.abs(t.delayMs - d2) <= 10 && t.locked, `seed ${seed}: D ${t.delayMs}`);
  }
});

test("a converted-voice dropout leaves D alone; after unrelated sound D comes back to the true delay", () => {
  const D = 330;
  for (const seed of [1, 2]) {
    const sp = synthSpeech({ sampleRate: LONG_SR, seconds: 70, seed });
    const orig = env(addNoise(sp.samples, -65, seed + 10), LONG_SR);
    const good = converted(sp.samples, LONG_SR, D, seed + 20);

    // 8 s of nothing back while the user talks: a stall.
    const stalled = Float32Array.from(good);
    stalled.fill(0, 20 * LONG_SR, 28 * LONG_SR);
    const t1 = new LatencyTracker();
    feed(t1, orig, env(stalled, LONG_SR), (tr, sec) => {
      if (sec >= 3) assert.ok(Math.abs(tr.delayMs - D) <= 5, `seed ${seed} stall, ${sec} s: D ${tr.delayMs}`);
    });

    // 25 s of somebody else's voice, then the right one again.
    const other = synthSpeech({ sampleRate: LONG_SR, seconds: 25, seed: seed + 1000, leadSec: 0, tailSec: 0 });
    const garbled = Float32Array.from(good);
    garbled.set(other.samples, 20 * LONG_SR);
    const t2 = new LatencyTracker();
    feed(t2, orig, env(garbled, LONG_SR), (tr, sec) => {
      if (sec >= 3 && (sec < 20 || sec >= 65)) {
        assert.ok(Math.abs(tr.delayMs - D) <= 10, `seed ${seed} unrelated sound, ${sec} s: D ${tr.delayMs}`);
      }
    });
  }
});

test("after a stall, relock() follows the delay while the jitter buffer drains, and locks again only once it has settled", () => {
  // The converted voice stops at 20 s; the app calls relock() when the stall is reported (0.45 s
  // later). The voice comes back 1.5 s after it stopped, 650 ms late, and the jitter buffer
  // drains to 330 ms over 5 s. Taking the first estimate after relock() for good locked D on a
  // passing value (475-630 ms) and the rest of the drain then needed three agreeing whole-range
  // estimates: D was more than 40 ms off for 13-19 s.
  const [STALL, RESUME, DRAIN, FROM, TO] = [20, 21.5, 5, 650, 330];
  const dAt = (sec) => (sec < STALL ? TO : sec < RESUME ? null : sec < RESUME + DRAIN ? FROM - ((sec - RESUME) * (FROM - TO)) / DRAIN : TO);
  const settledSec = RESUME + DRAIN;
  for (const seed of [1, 2, 3, 6]) {
    const { samples } = synthSpeech({ sampleRate: LONG_SR, seconds: 40, seed });
    const orig = env(addNoise(samples, -65, seed + 10), LONG_SR);
    const conv = env(convertedVarying(samples, LONG_SR, dAt, seed + 5), LONG_SR);
    const t = new LatencyTracker();
    let relocked = false;
    let offSec = 0; // after the voice came back: time with D more than 40 ms from the delay it has
    const after = []; // results after relock()
    feed(
      t,
      orig,
      conv,
      (tr, sec, r) => {
        if (!relocked) return;
        if (r) after.push({ sec, ...r, D: tr.delayMs, locked: tr.locked });
        const label = `seed ${seed} at ${sec} s: D ${tr.delayMs} (${tr.locked ? "locked" : "following"})`;
        if (!after.length) assert.ok(Math.abs(tr.delayMs - TO) <= 10, `${label}: the old D is kept until the first estimate`);
        if (tr.locked) assert.ok(Math.abs(tr.delayMs - TO) <= 10, `${label}: never locked on a passing value`);
        if (sec >= settledSec + 6) assert.ok(Math.abs(tr.delayMs - TO) <= 10, `${label}: settled within 6 s of the drain's end, for good`);
        if (sec >= RESUME && Math.abs(tr.delayMs - dAt(sec)) > 40) offSec += (CHUNK * HOP) / 1000;
      },
      {
        before: (tr, sec) => {
          if (!relocked && sec >= STALL + 0.45) {
            tr.relock();
            relocked = true;
          }
        },
      },
    );
    const label = `seed ${seed}: ${JSON.stringify(after.map((x) => [x.sec, x.ms, x.accepted, x.locked]))}`;
    // D followed the drain, one whole-range estimate every 3 s: the first one moved it at once, and
    // it moved down with the delay until three estimates in a row agreed.
    const lock = after.findIndex((x) => x.locked);
    assert.ok(lock >= 2, label);
    assert.ok(after.slice(0, lock + 1).every((x) => x.method === "full" && x.accepted), label);
    assert.ok(after[0].D - TO > 150, label);
    for (let i = 1; i <= lock; i++) assert.ok(after[i].D <= after[i - 1].D + 10, label);
    assert.ok(offSec <= DRAIN + 6, `seed ${seed}: D more than 40 ms off for ${offSec} s after the voice came back`);
    assert.ok(t.locked && Math.abs(t.delayMs - TO) <= 10, label);
  }
});

test("follows a jitter buffer that grows and shrinks by 10 ms a second", () => {
  // No stall: the delay ramps 300 → 400 ms over 10 s, holds, then ramps down to 320 ms over 8 s.
  // A 12 s window lagged so far behind that D stayed up to 96 ms off for 18-24 s of the take; the
  // last 6 s keep it on a delay the converted voice really had a moment ago.
  const dAt = (sec) => (sec < 20 ? 300 : sec < 30 ? 300 + (sec - 20) * 10 : sec < 50 ? 400 : sec < 58 ? 400 - (sec - 50) * 10 : 320);
  for (const seed of [1, 2, 3, 4]) {
    const { samples } = synthSpeech({ sampleRate: LONG_SR, seconds: 75, seed });
    const orig = env(addNoise(samples, -65, seed + 10), LONG_SR);
    const conv = env(convertedVarying(samples, LONG_SR, dAt, seed + 77), LONG_SR);
    const t = new LatencyTracker();
    let worst = 0;
    feed(t, orig, conv, (tr, sec) => {
      if (sec < 3) return;
      const label = `seed ${seed} at ${sec} s: D ${tr.delayMs}, true ${dAt(sec).toFixed(1)}`;
      worst = Math.max(worst, Math.abs(tr.delayMs - dAt(sec)));
      // Within 20 ms of a delay the converted voice had in the last 6 s.
      let near = Infinity;
      for (let back = 0; back <= 6; back += 0.25) near = Math.min(near, Math.abs(tr.delayMs - dAt(Math.max(0, sec - back))));
      assert.ok(near <= 20, label);
      // Once a ramp ends, D is on the new delay within 4 s and stays there.
      if ((sec >= 34 && sec < 50) || sec >= 62) assert.ok(Math.abs(tr.delayMs - dAt(sec)) <= 10, label);
    });
    assert.ok(worst <= 75, `seed ${seed}: D up to ${worst} ms off the delay of the moment`);
  }
});

test("a delay that changes while the user listens: the first estimate on little speech never moves D to a look-alike", () => {
  // 20 s of talking at 330 ms; the delay changes during 15 s of listening. The first window of the
  // next answer is mostly silence: its short block of speech lifted the score of a side lobe near
  // the old D, and the narrow window took it, leaving D 40-55 ms from both delays for 9 s.
  for (const [delta, seed] of [
    [200, 4],
    [200, 13],
    [-200, 13],
    [250, 12],
  ]) {
    const d2 = 330 + delta;
    const a = synthSpeech({ sampleRate: LONG_SR, seconds: 20, seed, tailSec: 0.5 });
    const b = synthSpeech({ sampleRate: LONG_SR, seconds: 30, seed: seed + 50, leadSec: 15 });
    const join = (x, y) => {
      const out = new Float32Array(x.length + y.length);
      out.set(x);
      out.set(y, x.length);
      return out;
    };
    const orig = join(env(addNoise(a.samples, -65, seed + 10), LONG_SR), env(addNoise(b.samples, -65, seed + 11), LONG_SR));
    const conv = join(env(converted(a.samples, LONG_SR, 330, seed + 20), LONG_SR), env(converted(b.samples, LONG_SR, d2, seed + 21), LONG_SR));
    const t = new LatencyTracker();
    feed(t, orig, conv, (tr, sec) => {
      if (sec < 3) return;
      const off = Math.min(Math.abs(tr.delayMs - 330), Math.abs(tr.delayMs - d2));
      assert.ok(off <= 10, `${delta} ms, seed ${seed}, at ${sec} s: D ${tr.delayMs}, neither 330 nor ${d2}`);
    });
    assert.ok(Math.abs(t.delayMs - d2) <= 10, `${delta} ms, seed ${seed}: D ${t.delayMs} at the end`);
  }
});

// ---------- the decision rules, with a stand-in for the search ----------

/**
 * A stand-in for estimateDelayFromEnvelopes. The converted voice is
 * `world.peak` ms late with correlation `world.score`. A search whose range
 * misses the peak finds `world.lookalike` ({ at, score }) when it covers it,
 * else only a slope up to its nearer end (score `world.slope`, 0.2 unless
 * set). `world.none`: nothing to compare. Every search's [minLagMs,
 * maxLagMs] goes into `calls`.
 */
function fakeWorld(world) {
  const calls = [];
  const estimate = (orig, conv, hopMs, { minLagMs, maxLagMs }) => {
    calls.push([minLagMs, maxLagMs]);
    if (world.none) return null;
    const inside = (ms) => ms >= minLagMs && ms <= maxLagMs;
    if (inside(world.peak)) return { lagMs: world.peak, score: world.score, method: "onsets" };
    const l = world.lookalike;
    if (l && inside(l.at)) return { lagMs: l.at, score: l.score, method: "onsets" };
    return { lagMs: world.peak < minLagMs ? minLagMs : maxLagMs, score: world.slope ?? 0.2, method: "envelope" };
  };
  return { calls, estimate };
}

/** Frames that pass the tracker's sound checks: syllables at -25 dB over a -60 dB floor, on both sides. */
const TALK_ORIG = Float32Array.from({ length: CHUNK }, (_, i) => (i % 10 < 5 ? -25 : -60));
const TALK_CONV = TALK_ORIG.map((v) => v - 6);

/** Push `sec` of talking (whole chunks), calling update() after each push; the non-null results. */
function talk(tracker, sec, conv = TALK_CONV) {
  const results = [];
  for (let f = 0; f < Math.round((sec * 1000) / HOP); f += CHUNK) {
    tracker.push(TALK_ORIG, conv);
    const r = tracker.update();
    if (r) results.push(r);
  }
  return results;
}

/** One estimate's worth of talking (3 s): its result, or null. */
const step = (tracker) => talk(tracker, 3)[0] ?? null;

/** A tracker locked on `peak` with five estimates at `score`. */
function locked(world, options = {}) {
  const fake = fakeWorld(world);
  const t = new LatencyTracker({ estimate: fake.estimate, ...options });
  for (let i = 0; i < 5; i++) assert.equal(step(t).accepted, true);
  fake.calls.length = 0;
  return { t, calls: fake.calls };
}

test("locks on the first trusted whole-range estimate, then searches ±localSearchMs around D", () => {
  const world = { peak: 300.4, score: 0.9 };
  const { calls, estimate } = fakeWorld(world);
  const t = new LatencyTracker({ estimate });
  assert.deepEqual(talk(t, 2.75), [], "nothing before 3 s of frames");
  assert.equal(t.delayMs, null);
  assert.deepEqual(talk(t, 0.25), [{ ms: 300, score: 0.9, method: "full", accepted: true }]);
  assert.deepEqual(calls, [[-100, 1500]]);
  assert.equal(t.delayMs, 300);
  assert.equal(t.locked, true);
  assert.equal(talk(t, 2.75).length, 0, "one estimate per 3 s");
  assert.deepEqual(talk(t, 0.25), [{ ms: 300, score: 0.9, method: "local", accepted: true }]);
  assert.deepEqual(calls[1], [240, 360]);
  world.peak = 322;
  assert.deepEqual(step(t), { ms: 322, score: 0.9, method: "local", accepted: true });
  step(t);
  assert.deepEqual(calls.at(-1), [262, 382], "the window follows D");
  // An untrusted first estimate does not lock.
  const w2 = fakeWorld({ peak: 300, score: 0.25 });
  const t2 = new LatencyTracker({ estimate: w2.estimate });
  assert.deepEqual(step(t2), { ms: 300, score: 0.25, method: "full", accepted: false });
  assert.equal(t2.delayMs, null);
  assert.equal(t2.locked, false);
});

test("a best match at the edge of the narrow window is checked with a whole-range search at once", () => {
  const world = { peak: 300, score: 0.9 };
  const { t, calls } = locked(world);
  world.peak = 357; // inside [240, 360] but at its edge: the peak may be beyond it
  assert.deepEqual(step(t), { ms: 357, score: 0.9, method: "full", accepted: true });
  assert.deepEqual(calls, [
    [240, 360],
    [-100, 1500],
  ]);
  // A peak far outside: the narrow search sees a slope up to its end.
  world.peak = 650;
  calls.length = 0;
  assert.deepEqual(step(t), { ms: 650, score: 0.9, method: "full", accepted: false });
  assert.deepEqual(calls, [
    [297, 417],
    [-100, 1500],
  ]);
  assert.equal(t.delayMs, 357, "one far estimate does not move D");
});

test("D moves beyond the narrow window only after three whole-range estimates in a row agree", () => {
  const world = { peak: 300, score: 0.9 };
  const { t, calls } = locked(world);
  world.peak = 650;
  assert.equal(step(t).accepted, false);
  assert.equal(step(t).accepted, false);
  assert.equal(t.delayMs, 300);
  assert.deepEqual(step(t), { ms: 650, score: 0.9, method: "full", accepted: true });
  assert.equal(t.delayMs, 650);
  // The first update tried the narrow window; then, with a candidate pending, only the whole range.
  assert.deepEqual(calls, [
    [240, 360],
    [-100, 1500],
    [-100, 1500],
    [-100, 1500],
  ]);
  assert.deepEqual(step(t).method, "local", "back to the narrow window around the new D");

  // Agreement means within confirmMs of the previous one; an untrusted estimate in between starts over.
  const w2 = { peak: 300, score: 0.9 };
  const { t: t2 } = locked(w2);
  const seq = [
    [650, 0.9, false],
    [700, 0.9, false], // 50 ms from the candidate: a new candidate
    [705, 0.9, false],
    [705, 0.25, false], // untrusted: start over
    [708, 0.9, false],
    [700, 0.9, false],
    [692, 0.9, true], // within 10 ms of the previous one each time
  ];
  for (const [peak, score, accepted] of seq) {
    Object.assign(w2, { peak, score });
    assert.equal(step(t2).accepted, accepted, `${peak} ms at ${score}`);
    assert.equal(t2.delayMs, accepted ? peak : 300);
  }
});

test("a narrow-window result far below the recent scores is checked: a look-alike never walks D away", () => {
  // The delay jumped to 650 ms; near the old D there is a look-alike that still scores 0.45
  // (above minScore). Taking it would re-centre the window on it and walk D off, window by window.
  const world = { peak: 300, score: 0.9 };
  const { t } = locked(world);
  Object.assign(world, { peak: 650, lookalike: { at: 330, score: 0.45 } });
  const seen = [];
  for (let i = 0; i < 3; i++) {
    const r = step(t);
    assert.equal(r.method, "full");
    seen.push(t.delayMs);
  }
  assert.deepEqual(seen, [300, 300, 650]);

  // A drop with the peak still at D (a window with little speech) is checked and taken.
  const w2 = { peak: 300, score: 0.9 };
  const { t: t2, calls } = locked(w2);
  w2.score = 0.6; // below 0.75 x 0.9
  assert.deepEqual(step(t2), { ms: 300, score: 0.6, method: "full", accepted: true });
  assert.equal(calls.length, 2);
  w2.score = 0.7; // the median of the recent scores is still 0.9: 0.7 is within 0.75 of it
  assert.deepEqual(step(t2), { ms: 300, score: 0.7, method: "local", accepted: true });
});

test("two agreeing whole-range estimates move D when the delay drifted out of the narrow window toward an equally strong peak", () => {
  // The narrow window's best match is at its edge with a trusted score (a slope up toward the
  // new peak) and the whole range finds that peak scoring like the recent matches: a jitter
  // buffer grew past the window. Two estimates in a row are enough.
  const world = { peak: 300, score: 0.9 };
  const { t, calls } = locked(world);
  Object.assign(world, { peak: 395, slope: 0.6 });
  assert.deepEqual(step(t), { ms: 395, score: 0.9, method: "full", accepted: false });
  assert.deepEqual(step(t), { ms: 395, score: 0.9, method: "full", accepted: true });
  assert.equal(t.delayMs, 395);
  assert.deepEqual(calls, [
    [240, 360],
    [-100, 1500],
    [-100, 1500],
  ]);

  // Not drift, so three: a slope that is not trusted (the old peak faded: the test above), a new
  // peak far weaker than the recent matches, or the narrow window's edge on the other side.
  for (const [change, label] of [
    [{ peak: 395, slope: 0.2 }, "an untrusted slope"],
    [{ peak: 395, slope: 0.6, score: 0.5 }, "a weak new peak"],
    [{ peak: 395, lookalike: { at: 241, score: 0.6 } }, "the edge on the other side"],
  ]) {
    const w = { peak: 300, score: 0.9 };
    const { t: t2 } = locked(w);
    Object.assign(w, change);
    assert.deepEqual([step(t2).accepted, step(t2).accepted, step(t2).accepted], [false, false, true], label);
    assert.equal(t2.delayMs, 395, label);
  }
});

test("a whole-range match near D that scores far below the recent ones may confirm D but never move it", () => {
  // While the engine sends something unrelated, the best match near D is a look-alike: taking it
  // would walk D off by up to localSearchMs at a time.
  const world = { peak: 300, score: 0.9 };
  const { t, calls } = locked(world);
  Object.assign(world, { peak: 340, score: 0.5 }); // below 0.75 x 0.9, 40 ms from D
  assert.deepEqual(step(t), { ms: 340, score: 0.5, method: "full", accepted: false });
  assert.equal(t.delayMs, 300);
  assert.deepEqual(calls, [
    [240, 360],
    [-100, 1500],
  ]);
  // It counts as untrusted: after three in a row only the whole range is searched.
  step(t);
  step(t);
  calls.length = 0;
  assert.equal(step(t).accepted, false);
  assert.deepEqual(calls, [[-100, 1500]]);
  // A weak match within confirmMs of D confirms it (a window with little speech, the peak still at D).
  world.peak = 306;
  assert.deepEqual(step(t), { ms: 306, score: 0.5, method: "full", accepted: true });
  assert.equal(t.delayMs, 306);
  // A strong one near D moves it as before.
  Object.assign(world, { peak: 340, score: 0.9 });
  assert.deepEqual(step(t), { ms: 340, score: 0.9, method: "local", accepted: true });
});

test("in a window with little speech, a narrow-window result that moves D more than 20 ms is checked with the whole range", () => {
  // The first estimate after the user listened for a while: half a second of speech in 6 s. Its
  // block of speech lifts the score of every lag near it, so a side lobe looks like a peak.
  const QUIET_ORIG = new Float32Array(CHUNK).fill(-60);
  const QUIET_CONV = new Float32Array(CHUNK).fill(-66);
  /** 5.5 s of listening, then 0.5 s of talking: the result of the estimate that runs at its end. */
  const listenThenTalk = (tracker) => {
    let r = null;
    for (let i = 0; i < 24; i++) {
      tracker.push(i < 22 ? QUIET_ORIG : TALK_ORIG, i < 22 ? QUIET_CONV : TALK_CONV);
      r = tracker.update() ?? r;
    }
    return r;
  };
  // The delay jumped to 530 ms while the user listened; the narrow window holds a 0.85 look-alike at 270 ms.
  const world = { peak: 300, score: 0.9 };
  const { t, calls } = locked(world);
  Object.assign(world, { peak: 530, lookalike: { at: 270, score: 0.85 } });
  assert.deepEqual(listenThenTalk(t), { ms: 530, score: 0.9, method: "full", accepted: false });
  assert.deepEqual(calls, [
    [240, 360],
    [-100, 1500],
  ]);
  assert.equal(t.delayMs, 300, "the look-alike did not move D");

  // A small move from little speech is taken as usual; a bigger one once the whole range agrees.
  const w2 = { peak: 300, score: 0.9 };
  const { t: t2, calls: c2 } = locked(w2);
  w2.peak = 315;
  assert.deepEqual(listenThenTalk(t2), { ms: 315, score: 0.9, method: "local", accepted: true });
  w2.peak = 345;
  assert.deepEqual(listenThenTalk(t2), { ms: 345, score: 0.9, method: "full", accepted: true });
  assert.deepEqual(c2, [
    [240, 360],
    [255, 375],
    [-100, 1500],
  ]);
  // With speech in half the window, the same move needs no whole-range search.
  assert.equal(step(t2).method, "local");
  w2.peak = 375;
  assert.deepEqual(step(t2), { ms: 375, score: 0.9, method: "local", accepted: true });
});

test("after relock() D follows every trusted whole-range estimate, and locks again once three in a row agree", () => {
  const world = { peak: 300, score: 0.9 };
  const { t, calls } = locked(world);
  t.relock();
  // The voice came back late after a stall and the jitter buffer drains.
  const seen = [];
  for (const [peak, score] of [
    [620, 0.9],
    [480, 0.9],
    [335, 0.9],
    [700, 0.2], // untrusted: D stays, and agreement starts over
    [331, 0.9],
    [329, 0.9],
  ]) {
    Object.assign(world, { peak, score });
    const r = step(t);
    seen.push([r.ms, r.method, r.accepted, t.delayMs, t.locked]);
  }
  assert.deepEqual(seen, [
    [620, "full", true, 620, false],
    [480, "full", true, 480, false],
    [335, "full", true, 335, false],
    [700, "full", false, 335, false],
    [331, "full", true, 331, false],
    [329, "full", true, 329, false],
  ]);
  world.peak = 332;
  assert.deepEqual(step(t), { ms: 332, score: 0.9, method: "full", accepted: true });
  assert.equal(t.locked, true, "three in a row within confirmMs");
  assert.ok(calls.every(([lo, hi]) => lo === -100 && hi === 1500), "whole-range searches until then");
  assert.deepEqual(step(t).method, "local");
  assert.deepEqual(
    t.history.slice(5).map((h) => h.ms),
    [620, 480, 335, 331, 329, 332, 332],
    "every estimate taken is in the history",
  );
});

test("after three untrusted estimates in a row only the whole range is searched, until a trusted one", () => {
  const world = { peak: 300, score: 0.9 };
  const { t, calls } = locked(world);
  world.score = 0.2;
  for (let i = 0; i < 3; i++) {
    calls.length = 0;
    assert.deepEqual(step(t), { ms: 300, score: 0.2, method: "full", accepted: false });
    assert.deepEqual(calls, [
      [240, 360],
      [-100, 1500],
    ]);
  }
  calls.length = 0;
  assert.equal(step(t).accepted, false);
  assert.deepEqual(calls, [[-100, 1500]], "the narrow window is no longer tried");
  assert.equal(t.delayMs, 300, "untrusted estimates leave D alone");
  world.score = 0.9;
  assert.deepEqual(step(t), { ms: 300, score: 0.9, method: "full", accepted: true });
  assert.equal(step(t).method, "local");
});

test("estimates with nothing to compare count for nothing", () => {
  const world = { peak: 300, score: 0.9 };
  const { t } = locked(world);
  world.peak = 650;
  assert.equal(step(t).accepted, false); // candidate, 1
  world.none = true;
  assert.equal(step(t), null);
  assert.equal(step(t), null);
  world.none = false;
  assert.equal(step(t).accepted, false); // 2: the gap did not break the run
  assert.equal(step(t).accepted, true);
  assert.equal(t.delayMs, 650);
});

test("no estimate while the user is silent or the engine sends nothing; D stays", () => {
  const world = { peak: 300, score: 0.9 };
  const { t, calls } = locked(world);
  const roomNoise = new Float32Array(CHUNK).fill(-62);
  const engineQuiet = new Float32Array(CHUNK).fill(-80);
  for (let i = 0; i < 4 * 60; i++) {
    t.push(roomNoise, engineQuiet); // a minute of listening
    assert.equal(t.update(), null);
  }
  assert.deepEqual(talk(t, 15, new Float32Array(CHUNK).fill(-120)), [], "talking, nothing back");
  assert.deepEqual(calls, [], "nothing to compare: no search ran");
  assert.equal(t.delayMs, 300);
  assert.equal(talk(t, 3).length, 1, "back to estimating once both sides have sound");
});

test("relock() and reset()", () => {
  const world = { peak: 300, score: 0.9 };
  const { t, calls } = locked(world);
  world.peak = 900;
  t.relock();
  assert.equal(t.locked, false);
  assert.equal(t.delayMs, 300);
  assert.deepEqual(talk(t, 2.75), [], "the window starts over");
  assert.deepEqual(talk(t, 0.25), [{ ms: 900, score: 0.9, method: "full", accepted: true }]);
  assert.deepEqual(calls, [[-100, 1500]]);
  assert.equal(t.delayMs, 900, "taken at once, however far");
  assert.equal(t.history.length, 6, "the history stays");

  t.reset();
  assert.equal(t.delayMs, null);
  assert.equal(t.locked, false);
  assert.deepEqual(t.history, []);
  assert.equal(talk(t, 3).length, 1);
  assert.equal(t.history[0].atSec, 3, "stream time starts over");
});

test("push: both sides need the same number of frames; NaN, infinities and levels below -120 dB count as silence", () => {
  let seen = null;
  const t = new LatencyTracker({
    estimate: (orig, conv) => {
      seen = [Array.from(orig), Array.from(conv)];
      return null;
    },
  });
  assert.throws(() => t.push(new Float32Array(10), new Float32Array(9)), RangeError);
  // Plain arrays work, and the failed push changed nothing: the first estimate still needs 600 frames.
  const orig = Array.from(TALK_ORIG);
  const conv = Array.from(TALK_CONV);
  orig[3] = NaN;
  orig[4] = -Infinity;
  conv[3] = Infinity;
  conv[4] = -200;
  for (let i = 0; i < 11; i++) t.push(orig, conv);
  assert.equal(t.update(), null);
  assert.equal(seen, null, "not due yet");
  t.push(orig, conv);
  assert.equal(t.update(), null);
  assert.equal(seen[0].length, 600);
  assert.deepEqual([seen[0][3], seen[0][4], seen[1][3], seen[1][4]], [-120, -120, -120, -120]);
  assert.equal(seen[0][0], -25);
});

test("history and lipSyncTotalMs: p95 of the accepted delays + 30 ms, capped at 800", () => {
  const world = { peak: 300, score: 0.9 };
  const { estimate } = fakeWorld(world);
  const t = new LatencyTracker({ estimate });
  const delays = [300, 304, 298, 311, 340, 309];
  delays.forEach((peak, i) => {
    world.peak = peak;
    assert.equal(step(t).accepted, true);
    if (i < 4) assert.equal(t.lipSyncTotalMs(), null, "needs 5 estimates");
  });
  const h = t.history;
  assert.deepEqual(
    h.map((x) => x.ms),
    delays,
  );
  assert.deepEqual(
    h.map((x) => x.atSec),
    [3, 6, 9, 12, 15, 18],
  );
  assert.ok(h.every((x) => x.score === 0.9));
  const p95 = percentile(delays, 95);
  assert.equal(t.lipSyncTotalMs(), Math.ceil(p95 + 30));
  assert.equal(t.lipSyncTotalMs({ marginMs: 0 }), Math.ceil(p95));
  assert.equal(t.lipSyncTotalMs({ maxMs: 350 }), 350);
  h.push({ atSec: 0, ms: 5000, score: 1 });
  assert.equal(t.history.length, delays.length, "history is a copy");

  // Capped at 800 (and never below 0).
  const far = fakeWorld({ peak: 790, score: 0.9 });
  const t2 = new LatencyTracker({ estimate: far.estimate });
  for (let i = 0; i < 5; i++) step(t2);
  assert.equal(t2.lipSyncTotalMs(), 800);
  assert.equal(t2.lipSyncTotalMs({ maxMs: 1000 }), 820);
  const ahead = fakeWorld({ peak: -80, score: 0.9 });
  const t3 = new LatencyTracker({ estimate: ahead.estimate });
  for (let i = 0; i < 5; i++) step(t3);
  assert.equal(t3.delayMs, -80);
  assert.equal(t3.lipSyncTotalMs(), 0);

  // Only the last maxHistory estimates are kept.
  const t4 = new LatencyTracker({ estimate: fakeWorld({ peak: 300, score: 0.9 }).estimate, maxHistory: 3 });
  for (let i = 0; i < 5; i++) step(t4);
  assert.deepEqual(
    t4.history.map((x) => x.atSec),
    [9, 12, 15],
  );
});
