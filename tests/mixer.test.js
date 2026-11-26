import test from "node:test";
import assert from "node:assert/strict";
import { SafetyMixer } from "../src/core/mixer.js";
import { frameLevelsDb } from "../src/core/vad.js";
import { envelopeDb } from "../src/core/delay-estimate.js";
import { rng, synthSpeech } from "./helpers/synth.js";

const SR = 48000;
const BLOCK = 128; // one AudioWorklet render quantum
const FRAME = 480; // 10 ms
const ms = (x) => Math.round((x * SR) / 1000);
const LIMIT = 10 ** (-1 / 20); // the default limitDb

// A few takes, shared by all tests (making them is most of this file's run time): seeds 1-4
// last 24 s, seed 6 60 s. speech(seed, seconds) is the first `seconds` of one.
const takes = new Map();
function speech(seed, seconds = 24) {
  if (!takes.has(seed)) takes.set(seed, synthSpeech({ seconds: seed === 6 ? 60 : 24, seed }));
  const { samples, utterances } = takes.get(seed);
  const n = Math.min(samples.length, Math.round(seconds * SR));
  assert.ok(n === Math.round(seconds * SR), `take ${seed} is shorter than ${seconds} s`);
  return { samples: samples.subarray(0, n), utterances: utterances.filter((u) => u.start * SR < n) };
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

/**
 * A fake engine: what comes back from the converter, in arrival time. The
 * original `delayMs` later, a different colour (one-pole low-pass at
 * `cutoffHz`; null for none) and `gainDb`. Faults, at arrival samples:
 * - stopAt .. resumeAt: the stream stops (digital silence), or with
 *   `conceal` a jitter buffer's concealment: the last 20 ms again and again,
 *   fading 3 dB per 10 ms for 80 ms, then noise at -50 dBFS. Healthy again
 *   from resumeAt.
 * - nanAt: NaN samples; drops: [at, length] holes (digital silence).
 */
function engine(orig, { delayMs, gainDb = -6, cutoffHz = 2500, stopAt = null, resumeAt = null, conceal = false, nanAt = [], drops = [], seed = 9 } = {}) {
  // recolour(delayed(orig, d)) in one loop that keeps the filter out of subnormal numbers (in
  // the take's digital silence they make it ten times slower; they are far below audibility).
  const d = ms(delayMs);
  const g = 10 ** (gainDb / 20);
  const conv = new Float32Array(orig.length);
  if (cutoffHz === null) {
    for (let i = d; i < orig.length; i++) conv[i] = g * orig[i - d];
  } else {
    const a = 1 - Math.exp((-2 * Math.PI * cutoffHz) / SR);
    let y = 0;
    for (let i = d; i < orig.length; i++) {
      y += a * (orig[i - d] - y);
      if (y < 1e-20 && y > -1e-20) y = 0;
      conv[i] = g * y;
    }
  }
  if (stopAt !== null) {
    const end = Math.min(conv.length, resumeAt ?? conv.length);
    if (conceal) {
      const period = ms(20);
      const last = conv.slice(stopAt - period, stopAt);
      const fadeEnd = Math.min(end, stopAt + ms(80));
      for (let i = stopAt; i < fadeEnd; i++) conv[i] = last[(i - stopAt) % period] * 10 ** ((-3 * (i - stopAt)) / FRAME / 20);
      conv.set(noise(end - fadeEnd, -50, seed), fadeEnd);
    } else conv.fill(0, stopAt, end);
  }
  for (const at of nanAt) conv[at] = NaN;
  for (const [at, len] of drops) conv.fill(0, at, at + len);
  return conv;
}

/**
 * The AudioWorklet's view of the mixer: orig (mic) and conv (engine output)
 * block by block, main-thread commands between blocks. `script`: [[sample,
 * msg], ...], each sent before the first block that starts at or after
 * `sample`. Events are stamped with `from`, the first output sample they can
 * affect, and `at`, the end of the block that raised them (what was known
 * then). `onBlock(mixer, start, end)` runs after each block (it may change
 * conv ahead of time). `before(start)` tells what the mixer reported when
 * the block starting there began: the original's lag (samples) and healthyMs.
 */
function run(orig, conv, { mixer = new SafetyMixer(), script = [], block = BLOCK, until = orig.length, onBlock } = {}) {
  const out = new Float32Array(until);
  const events = [];
  const blocks = Math.ceil(until / block);
  const lag = new Float64Array(blocks + 1);
  const healthy = new Float64Array(blocks + 1);
  const cmds = script.slice().sort((a, b) => a[0] - b[0]);
  let next = 0;
  const take = (from, at) => {
    for (const ev of mixer.takeEvents()) events.push({ ...ev, from, at });
  };
  for (let i = 0, b = 0; i < until; i += block, b++) {
    while (next < cmds.length && cmds[next][0] <= i) {
      mixer.command(cmds[next++][1]);
      take(i, i);
    }
    const e = Math.min(until, i + block);
    mixer.process(orig.subarray(i, e), conv.subarray(i, e), out.subarray(i, e));
    take(i, e);
    lag[b + 1] = ms(mixer.originalLagMs);
    healthy[b + 1] = mixer.healthyMs;
    onBlock?.(mixer, i, e);
  }
  const before = (start) => ({ lag: lag[start / block], healthy: healthy[start / block] });
  return { mixer, out, events, before };
}

/** What the main thread sends at the start of a call: D, media flowing, and the user's Convert. */
const START = (D) => [
  [0, { type: "delay", ms: D }],
  [0, { type: "engine", status: "media" }],
  [0, { type: "convert" }],
];

/**
 * A switch to the converted voice at output sample T moves the listener from
 * the original's content (T - origLag) to the converted voice's (T - D); all
 * of it, and the 60 ms crossfade, must be silence, or a word is cut, skipped
 * or said twice.
 */
function assertSwitchInPause(spans, T, origLag, Ds, what) {
  const a = Math.min(T - origLag, T - Ds) - ms(20);
  const b = Math.max(T - origLag, T - Ds) + ms(80);
  const hit = spans.find((s) => s.on < b && s.off > a);
  assert.ok(!hit, `${what}: switched at ${(T / SR).toFixed(3)} s across speech [${hit?.on}, ${hit?.off}), content [${a}, ${b})`);
}

function firstState(events, state, after = -Infinity) {
  return events.find((e) => e.type === "state" && e.state === state && e.from >= after) ?? null;
}

/**
 * Speech frames of the original, independent of the mixer: 10 ms frames
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
 * The sound of a synth take in [from, to): runs of non-zero samples
 * (syllables; gaps under 1 ms joined), [on, off). Between them the take is
 * digital silence.
 */
function soundSpans(samples, from = 0, to = samples.length) {
  const spans = [];
  let i = from;
  while (i < to) {
    while (i < to && samples[i] === 0) i++;
    if (i >= to) break;
    let j = i;
    for (;;) {
      while (j < to && samples[j] !== 0) j++;
      let k = j;
      while (k < to && k < j + 48 && samples[k] === 0) k++;
      if (k < to && k < j + 48) j = k;
      else break;
    }
    spans.push({ on: i, off: j });
    i = j;
  }
  return spans;
}

/** Does any span overlap [a, b)? */
function overlaps(spans, a, b) {
  return spans.some((s) => s.on < b && s.off > a);
}

/**
 * Output index where each span of `src` comes out verbatim and in one piece
 * (every sample bit-exact, consecutive), searching in order from `from`; -1
 * when it does not.
 */
function locate(out, src, spans, from = 0) {
  let i0 = from;
  return spans.map(({ on, off }) => {
    const len = off - on;
    const first = src[on];
    for (let i = i0; i + len <= out.length; i++) {
      if (out[i] !== first) continue;
      let k = 1;
      while (k < len && out[i + k] === src[on + k]) k++;
      if (k === len) {
        i0 = i + len;
        return i;
      }
    }
    return -1;
  });
}

function maxStep(x, from = 1, to = x.length) {
  let m = 0;
  for (let i = Math.max(1, from); i < Math.min(to, x.length); i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
}

/** The lag (samples, lo..hi) at which `ref` delayed best matches `x` over [from, to) (normalised correlation). */
function bestLag(x, ref, from, to, lo, hi) {
  let best = lo;
  let bestR = -Infinity;
  for (let lag = lo; lag <= hi; lag++) {
    let s = 0;
    let ee = 0;
    for (let i = from; i < to; i++) {
      const r = ref[i - lag];
      s += x[i] * r;
      ee += r * r;
    }
    const r = s / Math.sqrt(ee + 1e-30);
    if (r > bestR) {
      bestR = r;
      best = lag;
    }
  }
  return best;
}

/**
 * The output is the converted voice times a slowly moving gain over [from,
 * to): in every 10 ms piece, out = k * conv with nothing left over, k within
 * ±6 dB.
 */
function assertFollows(out, conv, from, to, what) {
  for (let a = from; a + FRAME <= to; a += FRAME) {
    let s = 0;
    let cc = 0;
    let oo = 0;
    for (let i = a; i < a + FRAME; i++) {
      s += out[i] * conv[i];
      cc += conv[i] * conv[i];
      oo += out[i] * out[i];
    }
    if (cc < 1e-12) {
      assert.ok(oo < 1e-10, `${what}: sound at ${a} where the converted voice is silent`);
      continue;
    }
    const k = s / cc;
    let res = 0;
    for (let i = a; i < a + FRAME; i++) res += (out[i] - k * conv[i]) ** 2;
    assert.ok(res <= 1e-5 * oo + 1e-14, `${what}: at ${a} the output is not the converted voice (residual ${res / oo})`);
    assert.ok(k >= 0.5 && k <= 2.0, `${what}: gain ${k} at ${a}`);
  }
}

/**
 * Places where a stall cuts into continuous speech: inside a vowel (±30 ms
 * within 6 dB of the peak), at least 700 ms before the end of its sentence,
 * in a sentence starting after `afterSec`. One per sentence, at a random sample.
 */
function stallPoints(samples, utterances, rand, count, afterSec) {
  const levels = frameLevelsDb(samples, SR, 10);
  let peak = -Infinity;
  for (const v of levels) peak = Math.max(peak, v);
  const points = [];
  for (const u of utterances) {
    if (u.start < afterSec) continue;
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

/** The click threshold: twice the largest sample-to-sample step either path has on its own (the converted at +6 dB). */
function clickLimit(orig, conv) {
  return 2 * Math.max(maxStep(orig), 2 * maxStep(conv));
}

test("off and own voice: the original, bit-exact in low-delay mode, exactly L later in lip sync", () => {
  const { samples, utterances } = speech(1, 12);
  const D = 250;
  const healthy = engine(samples, { delayMs: D });
  // A converted stream that must never get through here: NaN, Infinity and a +30 dB burst.
  const garbage = engine(samples, { delayMs: D, nanAt: [ms(3000), ms(3000) + 1] });
  garbage[ms(3000) + 2] = Infinity;
  for (let i = ms(5000); i < ms(5100); i++) garbage[i] *= 30;
  const cases = [
    { what: "off", conv: garbage, script: [], state: "off" },
    { what: "own from the start", conv: garbage, script: [[0, { type: "own" }]], state: "own-manual" },
    { what: "own, healthy engine", conv: healthy, script: [...START(D).slice(0, 2), [ms(1000), { type: "own" }]], state: "own-manual" },
    { what: "convert, silent engine", conv: new Float32Array(samples.length), script: START(D), state: "connecting" },
    { what: "convert, no D", conv: healthy, script: START(D).slice(1), state: "connecting" },
    { what: "convert, no media", conv: healthy, script: [START(D)[0], START(D)[2]], state: "connecting" },
  ];
  for (const { what, conv, script, state } of cases) {
    const { mixer, out, events } = run(samples, conv, { script });
    for (let i = 0; i < out.length; i++) if (out[i] !== samples[i]) assert.fail(`${what}: sample ${i}: ${out[i]} vs ${samples[i]}`);
    assert.equal(mixer.state, state, what);
    assert.ok(!events.some((e) => e.type === "fault"), `${what}: a fault`);
  }

  // Lip sync from the start: silence, then the original exactly L later.
  for (const L of [450, 333.3]) {
    const Ls = Math.round((L * SR) / 1000);
    const { out } = run(samples, garbage, { mixer: new SafetyMixer({ lipSyncMs: L }) });
    for (let i = 0; i < out.length; i++) {
      const want = i >= Ls ? samples[i - Ls] : 0;
      if (out[i] !== want) assert.fail(`lip sync ${L}: sample ${i}: ${out[i]} vs ${want}`);
    }
  }

  // Lip sync switched on mid-sentence: the original holds back in the next pause (silence
  // goes in), then runs exactly L late; every sentence comes out whole, once.
  const L = 400;
  const on = Math.round((utterances[2].start + 0.3) * SR);
  const { out, mixer } = run(samples, garbage, { script: [[on, { type: "lipSync", totalMs: L }]] });
  assert.equal(mixer.lipSyncMs, L);
  for (let i = 0; i < on; i++) if (out[i] !== samples[i]) assert.fail(`before lip sync: sample ${i}`);
  const settled = Math.round(utterances[3].start * SR) + ms(L);
  for (let i = settled; i < out.length; i++) if (out[i] !== samples[i - ms(L)]) assert.fail(`lip sync on: sample ${i}`);
  const spans = soundSpans(samples, 0, samples.length - ms(L));
  const at = locate(out, samples, spans);
  at.forEach((p, k) => assert.ok(p >= 0, `span ${k} cut or changed`));
});

test("convert: switches only after 3 s of healthy converted speech and in a pause of both voices; then the output is the converted voice", () => {
  for (const D of [250, 400]) {
    for (const seed of [1, 2, 3]) {
      const { samples } = speech(seed, 14);
      const isSpeech = speechFrames(samples);
      const spans = soundSpans(samples);
      const conv = engine(samples, { delayMs: D });
      let healthyAtSwitch = null;
      const { out, events } = run(samples, conv, {
        script: START(D),
        onBlock: (m) => {
          if (healthyAtSwitch === null && m.state === "converting") healthyAtSwitch = m.healthyMs;
        },
      });
      const what = `D ${D} seed ${seed}`;
      assert.deepEqual(
        events.filter((e) => e.type === "state").map((e) => [e.state, e.reason]),
        [
          ["connecting", "user"],
          ["converting", "ready"],
        ],
        what,
      );
      const T0 = firstState(events, "converting").from; // the crossfade starts here
      assert.ok(healthyAtSwitch >= 3000, `${what}: healthy ${healthyAtSwitch} ms at the switch`);
      // Independently: the user had said 3 s of speech whose converted copy had arrived.
      assert.ok(speechMs(isSpeech, 0, T0 - ms(D)) >= 3000, `${what}: switched after ${speechMs(isSpeech, 0, T0 - ms(D))} ms of speech`);
      // In a pause of both voices: the live original (lag 0) and the content the converted
      // voice carries (D ago), all of it silence, so nothing is cut or said twice.
      assertSwitchInPause(spans, T0, 0, ms(D), what);
      for (let i = 0; i < T0; i++) if (out[i] !== samples[i]) assert.fail(`${what}: before the switch, sample ${i}`);
      assertFollows(out, conv, T0 + ms(60), out.length, what);
    }
  }

  // The engine only starts sending at 5 s: 3 s of healthy speech counted from there.
  const { samples } = speech(4, 16);
  const isSpeech = speechFrames(samples);
  const conv = engine(samples, { delayMs: 300 });
  conv.fill(0, 0, ms(5000));
  const script = [[0, { type: "delay", ms: 300 }], [0, { type: "convert" }], [ms(5000), { type: "engine", status: "media" }]];
  const { events } = run(samples, conv, { script });
  const T0 = firstState(events, "converting").from;
  assert.ok(speechMs(isSpeech, ms(4700), T0 - ms(300)) >= 3000, `switched after ${speechMs(isSpeech, ms(4700), T0 - ms(300))} ms of healthy speech`);
});

test("a digital-silence stall mid-sentence: own-fault after 350-450 ms of the user's speech, every word replayed, no click (low delay and lip sync)", () => {
  let cases = 0;
  for (const D of [250, 400]) {
    for (const seed of [1, 2, 3, 4]) {
      for (const lip of [null, 450]) {
        const { samples, utterances } = speech(seed, 24);
        const isSpeech = speechFrames(samples);
        const Ds = ms(D);
        const [at] = stallPoints(samples, utterances, rng(10 * seed + D), 1, 11);
        assert.ok(at, `seed ${seed}: no stall point`);
        const conv = engine(samples, { delayMs: D, stopAt: at + Ds });
        const until = Math.min(samples.length, at + ms(10000));
        const mixer = new SafetyMixer({ lipSyncMs: lip });
        const { out, events } = run(samples, conv, { mixer, script: START(D), until });
        const what = `D ${D} seed ${seed}${lip ? ` lip sync ${lip}` : ""}, stall at ${(at / SR).toFixed(3)} s`;
        assert.ok(firstState(events, "converting").from < at, `${what}: not converting before the stall`);
        const fault = events.find((e) => e.type === "fault");
        assert.ok(fault, `${what}: no fault`);
        assert.equal(fault.kind, "stall");
        assert.deepEqual([fault.locked, fault.retryAtMs], [false, null], what);
        const own = firstState(events, "own-fault");
        assert.equal(own.from, fault.from);
        // The replay starts a little before the stop: its 30 ms fade-in is over by then, and at
        // most 60 ms of what the converted voice said is said again.
        assert.ok(fault.replayFrom + ms(30) <= at && fault.replayFrom >= at - ms(60), `${what}: replay from ${(fault.replayFrom - at) / 48} ms`);
        // Detection: after 350-450 ms of the user's speech since the stall (counting what was due by then).
        const lost = speechMs(isSpeech, at, own.at - Ds);
        assert.ok(lost >= 350 && lost <= 450, `${what}: own-fault after ${lost} ms of speech`);
        assert.ok(own.at - (at + Ds) < ms(1000), `${what}: ${(own.at - at - Ds) / 48} ms after the stall arrived`);
        // The original caught up with the target lag again (shortening pauses only) ...
        const target = lip ?? 0;
        assert.ok(Math.abs(mixer.originalLagMs - target) < 0.01, `${what}: lag ${mixer.originalLagMs} ms at the end`);
        // ... and every speech sample from the stall start on came out, verbatim and in order.
        const spans = soundSpans(samples, at, until - ms(target));
        const pos = locate(out, samples, spans, own.from);
        pos.forEach((p, k) => assert.ok(p >= 0, `${what}: speech [${spans[k].on}, ${spans[k].off}) lost or changed`));
        assert.equal(mixer.state, "own-fault", `${what}: interview mode went back by itself`);
        // No click where the voices switch.
        const step = maxStep(out, own.from - ms(2), own.from + ms(40));
        assert.ok(step <= clickLimit(samples, conv), `${what}: step ${step} at the switch`);
        cases++;
      }
    }
  }
  assert.equal(cases, 16);
});

test("a concealment-like stall (the last 20 ms repeated and fading, then noise at -50 dBFS): own-fault within 350-500 ms of speech, nothing lost", () => {
  for (const D of [250, 400]) {
    for (const seed of [2, 3, 4]) {
      const { samples, utterances } = speech(seed, 24);
      const isSpeech = speechFrames(samples);
      const Ds = ms(D);
      const [at] = stallPoints(samples, utterances, rng(20 * seed + D), 1, 11);
      const conv = engine(samples, { delayMs: D, stopAt: at + Ds, conceal: true, seed });
      const until = Math.min(samples.length, at + ms(9000));
      const { mixer, out, events } = run(samples, conv, { script: START(D), until });
      const what = `D ${D} seed ${seed}, stall at ${(at / SR).toFixed(3)} s`;
      const own = firstState(events, "own-fault");
      assert.ok(own, `${what}: no fault`);
      const lost = speechMs(isSpeech, at, own.at - Ds);
      assert.ok(lost >= 350 && lost <= 500, `${what}: own-fault after ${lost} ms of speech`);
      // Behind a concealment tail the stall start can be a few tens of ms late; the replay still
      // starts by the stop (+20 ms at worst), and everything after its 30 ms fade-in comes out verbatim.
      const { replayFrom } = events.find((e) => e.type === "fault");
      assert.ok(replayFrom <= at + ms(20) && replayFrom >= at - ms(60), `${what}: replay from ${(replayFrom - at) / 48} ms`);
      assert.equal(mixer.originalLagMs, 0, `${what}: caught up`);
      const spans = soundSpans(samples, replayFrom + ms(30), until);
      locate(out, samples, spans, own.from).forEach((p, k) => assert.ok(p >= 0, `${what}: speech span ${k} lost`));
      assert.ok(maxStep(out, own.from - ms(2), own.from + ms(40)) <= clickLimit(samples, conv), `${what}: click`);
    }
  }
});

test("never a fault in healthy conversation: zero blocks of 2.7 and 10 ms, D off by 30 ms, a quieter recoloured voice", () => {
  for (const [D, seed] of [
    [250, 1],
    [400, 2],
  ]) {
    {
      const { samples } = speech(seed, 24);
      const drops = [];
      const rand = rng(seed + D);
      for (let t = ms(100); t < samples.length; t += ms(200)) drops.push([t + Math.floor(rand() * FRAME), rand() < 0.5 ? 128 : 480]);
      for (const conv of [engine(samples, { delayMs: D, drops }), engine(samples, { delayMs: D + 30 }), engine(samples, { delayMs: D - 30, gainDb: -10 })]) {
        const { mixer, events, out } = run(samples, conv, { script: START(D) });
        assert.equal(mixer.state, "converting", `D ${D} seed ${seed}`);
        assert.ok(!events.some((e) => e.type === "fault"), `D ${D} seed ${seed}: ${JSON.stringify(events.find((e) => e.type === "fault"))}`);
        assert.ok(out.every((v) => Math.abs(v) <= LIMIT));
      }
    }
  }
});

test("interview mode never goes back by itself: 30 s of a healthy engine after a fault; then Convert brings it back in a pause", () => {
  for (const D of [250, 400]) {
    const { samples, utterances } = speech(6, 50);
    const Ds = ms(D);
    const spans = soundSpans(samples);
    const [at] = stallPoints(samples, utterances, rng(D), 1, 11);
    const conv = engine(samples, { delayMs: D, stopAt: at + Ds, resumeAt: at + Ds + ms(1500) });
    const convertAt = at + Ds + ms(32000);
    let maxHealthy = 0;
    const { events, mixer, before } = run(samples, conv, {
      script: [...START(D), [convertAt, { type: "convert" }]],
      onBlock: (m, i) => {
        if (m.state === "own-fault" && i < convertAt) maxHealthy = Math.max(maxHealthy, m.healthyMs);
      },
    });
    const fault = events.find((e) => e.type === "fault");
    assert.ok(fault && fault.from < at + Ds + ms(1000), `D ${D}: no stall fault`);
    // Health and pauses were there all along: only the policy kept it on the user's own voice.
    assert.ok(maxHealthy >= 10000, `D ${D}: healthy only ${maxHealthy} ms after the fault`);
    const after = events.filter((e) => e.type === "state" && e.from > fault.from);
    assert.deepEqual(
      after.map((e) => [e.state, e.reason]),
      [
        ["connecting", "user"],
        ["converting", "ready"],
      ],
      `D ${D}`,
    );
    assert.equal(after[0].from, Math.ceil(convertAt / BLOCK) * BLOCK);
    const T0 = after[1].from;
    assertSwitchInPause(spans, T0, before(T0).lag, Ds, `D ${D}`);
    assert.equal(mixer.state, "converting");
  }
});

test("practice mode goes back by itself after the backoff (0.5 s, then 1 s), 3 s of healthy speech and a pause; three faults in 2 minutes lock it", () => {
  for (const D of [250, 400]) {
    const { samples, utterances } = speech(6, 60);
    const isSpeech = speechFrames(samples);
    const spans = soundSpans(samples);
    const Ds = ms(D);
    // Three stalls about 13 s apart, the engine healthy again 1.2 s after each.
    const points = stallPoints(samples, utterances, rng(7 + D), 40, 11);
    const stalls = [];
    for (const p of points) if (!stalls.length || p > stalls[stalls.length - 1] + ms(13000)) stalls.push(p);
    assert.ok(stalls.length >= 3, `D ${D}: stall points ${stalls.length}`);
    stalls.length = 3;
    const conv = engine(samples, { delayMs: D });
    for (const at of stalls) conv.fill(0, at + Ds, at + Ds + ms(1200));
    const { events, mixer, before } = run(samples, conv, { mixer: new SafetyMixer({ mode: "practice" }), script: START(D) });
    const faults = events.filter((e) => e.type === "fault");
    assert.equal(faults.length, 3, `D ${D}: ${faults.length} faults`);
    assert.deepEqual(
      faults.map((f) => [f.kind, f.locked, f.retryAtMs === null ? null : f.retryAtMs - f.atMs]),
      [
        ["stall", false, 500],
        ["stall", false, 1000],
        ["stall", true, null],
      ],
      `D ${D}`,
    );
    for (let k = 0; k < 2; k++) {
      const back = firstState(events, "converting", faults[k].from + 1);
      assert.ok(back && back.reason === "retry", `D ${D}: no return after fault ${k + 1}`);
      assert.ok(back.from < faults[k + 1].from, `D ${D}: return ${k + 1} too late`);
      const waitMs = ((back.from - faults[k].from) * 1000) / SR;
      assert.ok(waitMs >= faults[k].retryAtMs - faults[k].atMs, `D ${D}: back after ${waitMs} ms`);
      assert.ok(before(back.from).healthy >= 3000, `D ${D}: healthy ${before(back.from).healthy} ms at return ${k + 1}`);
      // Independently: 3 s of the user's speech after the engine recovered.
      const recovered = stalls[k] + ms(1200);
      assert.ok(speechMs(isSpeech, recovered, back.from - Ds) >= 3000, `D ${D}: return ${k + 1} after ${speechMs(isSpeech, recovered, back.from - Ds)} ms of healthy speech`);
      assertSwitchInPause(spans, back.from, before(back.from).lag, Ds, `D ${D} return ${k + 1}`);
    }
    // Locked: no return after the third fault, though the engine is healthy for 20 s more.
    assert.equal(firstState(events, "converting", faults[2].from + 1), null, `D ${D}: returned while locked`);
    assert.equal(mixer.state, "own-fault");
  }
});

test("going back while the replayed original still lags behind: the switch skips no word and repeats none", () => {
  // A timeline that never shortens a pause: after the replay the original stays ~0.7 s behind
  // the live mic, behind the converted voice. Going back to the converted voice jumps from the
  // original's position to the converted voice's: all of that must be a pause.
  for (const D of [250, 400]) {
    const take = speech(6, 40);
    const Ds = ms(D);
    const [at] = stallPoints(take.samples, take.utterances, rng(3 + D), 1, 11);
    // A short word ("so", "and") alone in the middle of every other long pause after the stall:
    // where a switch between the two positions could skip it or say it twice.
    const samples = Float32Array.from(take.samples);
    const word = soundSpans(take.samples).find((s) => s.off - s.on >= ms(110) && s.off - s.on <= ms(160));
    const sentences = take.utterances.map((u) => soundSpans(take.samples, Math.round(u.start * SR), Math.round(u.end * SR)));
    let words = 0;
    let long = 0;
    for (let k = 0; k + 1 < sentences.length; k++) {
      const gapFrom = sentences[k].at(-1).off;
      const gapTo = sentences[k + 1][0].on;
      if (gapFrom < at + ms(500) || gapTo - gapFrom < ms(800) || long++ % 2) continue;
      samples.set(take.samples.subarray(word.on, word.off), Math.round((gapFrom + gapTo - (word.off - word.on)) / 2));
      words++;
    }
    assert.ok(words >= 3, `D ${D}: ${words} short words`);
    const spans = soundSpans(samples);
    const conv = engine(samples, { delayMs: D, stopAt: at + Ds, resumeAt: at + Ds + ms(1000) });
    const mixer = new SafetyMixer({ mode: "practice", timelineOptions: { keepPauseMs: 60000 } });
    const { events, before } = run(samples, conv, { mixer, script: START(D) });
    const fault = events.find((e) => e.type === "fault");
    const back = firstState(events, "converting", fault.from + 1);
    assert.ok(back, `D ${D}: never went back`);
    const { lag } = before(back.from);
    assert.ok(lag > Ds + ms(200), `D ${D}: the original lags ${lag} samples`);
    assertSwitchInPause(spans, back.from, lag, Ds, `D ${D}`);
  }
});

test("NaN or Infinity in the converted stream: own-fault in the same block; the output never carries it", () => {
  for (const D of [250, 400]) {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const { samples } = speech(3, 16);
      const conv = engine(samples, { delayMs: D });
      let injected = null;
      let switchedAt = null;
      const { events, out } = run(samples, conv, {
        onBlock: (m, i, e) => {
          if (switchedAt === null && m.state === "converting") switchedAt = e;
          if (injected === null && switchedAt !== null && e > switchedAt + ms(1000)) {
            injected = e + 37; // inside the next block
            conv[injected] = bad;
            conv.fill(bad, injected + ms(100), injected + ms(130)); // and a run of them later
          }
        },
        script: START(D),
      });
      const what = `D ${D} ${bad}`;
      assert.ok(injected !== null, `${what}: never converting`);
      const fault = events.find((e) => e.type === "fault");
      assert.deepEqual([fault.kind, fault.reason], ["bad-output", "non-finite samples"], what);
      assert.ok(fault.from <= injected && fault.at > injected, `${what}: fault in block [${fault.from}, ${fault.at}), bad sample at ${injected}`);
      assert.equal(firstState(events, "own-fault").from, fault.from);
      for (let i = 0; i < out.length; i++) if (!(Math.abs(out[i]) <= LIMIT)) assert.fail(`${what}: sample ${i} = ${out[i]}`);
    }
  }
  // NaN from the mic: never in the output either, in any state.
  const { samples } = speech(2, 12);
  const mic = Float32Array.from(samples);
  for (let t = ms(500); t < mic.length; t += ms(777)) mic[t] = NaN;
  const { out } = run(mic, engine(samples, { delayMs: 300 }), { script: START(300) });
  assert.ok(out.every(Number.isFinite));
});

test("equal-power crossfades: two uncorrelated noises at the same level keep the output RMS within ±1.5 dB", () => {
  for (const D of [250, 400]) {
    // 11 s of speech (the converted copy: delayed, same level) to get healthy, then quiet room
    // noise in both: noise A in the mic, an unrelated noise B in the converted stream.
    const { samples } = speech(4, 11);
    const total = samples.length + ms(3000);
    const speechEnd = samples.length;
    const orig = new Float32Array(total);
    orig.set(samples);
    orig.set(noise(total - speechEnd, -60, 11), speechEnd);
    const conv = engine(orig, { delayMs: D, cutoffHz: null, gainDb: 0 });
    conv.set(noise(total - speechEnd - ms(D), -60, 12), speechEnd + ms(D));
    const convertAt = speechEnd + ms(800);
    const ownAt = speechEnd + ms(2000);
    const { events, out, mixer } = run(orig, conv, {
      script: [...START(D).slice(0, 2), [convertAt, { type: "convert" }], [ownAt, { type: "own" }]],
    });
    const sw = firstState(events, "converting");
    assert.ok(sw && sw.from === convertAt, `D ${D}: switch at ${sw && sw.from} instead of ${convertAt}`);
    assert.equal(mixer.gainDb, 0, `D ${D}: the copy is at the original's level`);
    const back = firstState(events, "own-manual");
    assert.equal(back.from, ownAt);
    const rms = (x, a, b) => {
      let s = 0;
      for (let i = a; i < b; i++) s += x[i] * x[i];
      return Math.sqrt(s / (b - a));
    };
    const ref = rms(orig, speechEnd + ms(200), total);
    for (const [start, fade] of [
      [sw.from, ms(60)],
      [back.from, ms(30)],
    ]) {
      for (let a = start - ms(20); a < start + fade + ms(20); a += ms(10)) {
        const db = 20 * Math.log10(rms(out, a, a + ms(10)) / ref);
        assert.ok(Math.abs(db) <= 1.5, `D ${D}: ${db.toFixed(2)} dB at ${a - start} samples into the fade`);
      }
    }
  }
});

test("lip sync: the original and the converted voice both come out L later (± one block)", () => {
  const L = 450;
  for (const D of [250, 400]) {
    for (const cutoffHz of [null, 2500]) {
      const { samples } = speech(1, 16);
      const conv = engine(samples, { delayMs: D, cutoffHz, gainDb: cutoffHz ? -6 : 0 });
      const { events, out, before } = run(samples, conv, { mixer: new SafetyMixer({ lipSyncMs: L }), script: START(D) });
      const what = `D ${D}${cutoffHz ? " recoloured" : ""}`;
      const T0 = firstState(events, "converting").from;
      const Ls = ms(L);
      // Both voices play content L ago: the switch is in a pause there.
      assert.equal(before(T0).lag, Ls);
      assertSwitchInPause(soundSpans(samples), T0, Ls, Ls, what);
      // Before the switch: the original path, exactly L.
      for (let i = 0; i < T0; i++) if (out[i] !== (i >= Ls ? samples[i - Ls] : 0)) assert.fail(`${what}: sample ${i}`);
      assert.equal(bestLag(out, samples, T0 - ms(1000), T0, Ls - 192, Ls + 192), Ls, what);
      // After it: the converted path (delay line L - D after its own delay D).
      const lag = bestLag(out, samples, T0 + ms(500), T0 + ms(1500), Ls - 192, Ls + 192);
      assert.ok(Math.abs(lag - Ls) <= BLOCK, `${what}: the converted voice comes out at ${lag} samples, not ${Ls}`);
      if (!cutoffHz) for (let i = T0 + ms(60); i < out.length; i++) if (out[i] !== samples[i - Ls]) assert.fail(`${what}: sample ${i}`);
    }
  }
});

test("lip sync: a new D moves the converted voice only where it plays a pause, and keeps it at L", () => {
  const L = 450;
  const { samples, utterances } = speech(2, 24);
  const spans = soundSpans(samples);
  const conv = engine(samples, { delayMs: 400 });
  // The jitter buffer grows by 30 ms in a pause (arrival time) ...
  const k = utterances.findIndex((u) => u.start > 12);
  const grow = Math.round(((utterances[k - 1].end + utterances[k].start) / 2) * SR) + ms(400);
  conv.set(engine(samples, { delayMs: 430 }).subarray(grow), grow);
  // ... and the main thread reports it mid-sentence.
  const tell = Math.round((utterances[k].start + 0.5) * SR) + ms(400);
  let applied = null;
  const { out, mixer, events } = run(samples, conv, {
    mixer: new SafetyMixer({ lipSyncMs: L }),
    script: [...START(400), [tell, { type: "delay", ms: 430 }]],
    onBlock: (m, i) => {
      if (applied === null && m.delayMs === 430) applied = i;
    },
  });
  assert.ok(firstState(events, "converting").from < grow);
  assert.ok(!events.some((e) => e.type === "fault"));
  assert.ok(applied !== null && applied >= tell, `applied at ${applied}, told at ${tell}`);
  // What the converted voice played around the move (content L ago, 30 ms more before it) was a pause.
  assert.ok(!overlaps(spans, applied - ms(L + 30 + 5), applied - ms(L) + ms(10)), `moved at ${applied / SR} s, in speech`);
  assert.equal(mixer.delayMs, 430);
  const lag = bestLag(out, samples, applied + ms(1000), applied + ms(2000), ms(L) - 192, ms(L) + 192);
  assert.ok(Math.abs(lag - ms(L)) <= BLOCK, `after the move: ${lag}`);
});

test("a new D waits for a pause of the original while the converted voice is heard, and applies at once when it is not", () => {
  const { samples, utterances } = speech(3, 16);
  const spans = soundSpans(samples);
  const conv = engine(samples, { delayMs: 300 });
  const k = utterances.findIndex((u) => u.start > 11);
  const tell = Math.round((utterances[k].start + 0.3) * SR);
  let applied = null;
  const { mixer } = run(samples, conv, {
    script: [...START(300), [tell, { type: "delay", ms: 310 }]],
    onBlock: (m, i) => {
      if (applied === null && m.delayMs === 310) applied = i;
    },
  });
  assert.equal(mixer.state, "converting");
  assert.ok(applied > tell, "applied mid-sentence");
  // The Vad's flag falls 300 ms after the last speech frame.
  assert.ok(!overlaps(spans, applied - ms(280), applied), `applied at ${applied / SR} s, not in a pause`);

  const m2 = new SafetyMixer();
  m2.command({ type: "delay", ms: 300 });
  assert.equal(m2.delayMs, 300);
  m2.command({ type: "delay", ms: null });
  assert.equal(m2.delayMs, null);
  m2.command({ type: "delay", ms: "300" });
  assert.equal(m2.delayMs, null);
});

test("engine down or a main-thread fault while converting: own voice at once, replayed from 100 ms before the converted voice; while connecting: health starts over", () => {
  for (const [D, kind, msg] of [
    [250, "engine-down", { type: "engine", status: "down", reason: "ice failed" }],
    [400, "main", { type: "fault", reason: "packets stalled" }],
  ]) {
    const { samples, utterances } = speech(4, 20);
    const conv = engine(samples, { delayMs: D });
    const u = utterances.find((x) => x.start > 11 && x.end - x.start > 1);
    const at = Math.round((u.start + 0.6) * SR) - (Math.round((u.start + 0.6) * SR) % BLOCK);
    const { events, out, mixer } = run(samples, conv, { script: [...START(D), [at, msg]] });
    const fault = events.find((e) => e.type === "fault");
    assert.deepEqual([fault.kind, fault.reason, fault.from], [kind, msg.reason, at]);
    assert.equal(firstState(events, "own-fault").from, at);
    // Nothing lost: from 100 ms before what the converted voice was saying (plus the 30 ms fade).
    const from = at - ms(D) - ms(100) + ms(30);
    const spans = soundSpans(samples, from, samples.length - ms(1000));
    locate(out, samples, spans, at).forEach((p, k) => assert.ok(p >= 0, `${kind}: span ${k} lost`));
    assert.equal(mixer.state, "own-fault");
  }

  // Down while connecting: no fault, but 3 s of healthy speech again after the media is back.
  const { samples } = speech(1, 20);
  const isSpeech = speechFrames(samples);
  const conv = engine(samples, { delayMs: 300 });
  const script = [...START(300), [ms(2500), { type: "engine", status: "down" }], [ms(6000), { type: "engine", status: "media" }]];
  const { events } = run(samples, conv, { script });
  assert.ok(!events.some((e) => e.type === "fault"));
  const T0 = firstState(events, "converting").from;
  assert.ok(T0 > ms(6000) && speechMs(isSpeech, ms(6000), T0 - ms(300)) >= 3000 - 300, `switched at ${T0 / SR} s`);
});

test("own voice while converting: the original goes on from the converted voice's words (nothing lost); own and off are idempotent", () => {
  for (const lip of [null, 450]) {
    const D = 300;
    const { samples, utterances } = speech(2, 20);
    const conv = engine(samples, { delayMs: D });
    const u = utterances.find((x) => x.start > 12 && x.end - x.start > 1);
    const at = Math.round((u.start + 0.5) * SR) - (Math.round((u.start + 0.5) * SR) % BLOCK);
    const script = [...START(D), [at, { type: "own" }], [at + ms(500), { type: "own" }], [at + ms(600), { type: "convert" }], [at + ms(600), { type: "convert" }]];
    const { events, out } = run(samples, conv, { mixer: new SafetyMixer({ lipSyncMs: lip }), script });
    const what = lip ? "lip sync" : "low delay";
    const states = events.filter((e) => e.type === "state" && e.from >= at);
    assert.deepEqual(
      states.map((e) => [e.state, e.reason]),
      [
        ["own-manual", "user"],
        ["connecting", "user"],
        ["converting", "ready"],
      ],
      what,
    );
    assert.equal(states[0].from, at);
    assert.ok(!events.some((e) => e.type === "fault"), what);
    // The converted voice was saying content at - max(D, L); the original takes over from there
    // (after the 30 ms crossfade) and plays every word until the converted voice is back.
    const lag = ms(Math.max(D, lip ?? 0));
    const spans = soundSpans(samples, at - lag + ms(30), states[2].from - lag);
    assert.ok(spans.length >= 3, `${what}: ${spans.length} spans`);
    locate(out, samples, spans, at).forEach((p, k) => assert.ok(p >= 0, `${what}: span ${k} lost`));
    assert.ok(maxStep(out, at - ms(2), at + ms(40)) <= clickLimit(samples, conv), `${what}: click`);
  }
  const m = new SafetyMixer();
  m.command({ type: "own" });
  m.command({ type: "own" });
  m.command({ type: "off" });
  m.command({ type: "off" });
  m.command({ type: "nonsense" });
  m.command(null);
  m.command("own");
  assert.deepEqual(
    m.takeEvents().map((e) => [e.type, e.state]),
    [
      ["state", "own-manual"],
      ["state", "off"],
    ],
  );
  const none = m.takeEvents();
  assert.equal(none.length, 0);
  assert.ok(Object.isFrozen(none));
});

test("envelope events: every 250 ms, 5 ms hops, the levels envelopeDb gives for each input", () => {
  const { samples } = speech(4, 6);
  const conv = engine(samples, { delayMs: 300 });
  conv[ms(2000)] = NaN; // counted as 0
  const { events } = run(samples, conv);
  const env = events.filter((e) => e.type === "envelopes");
  const want = (x) => envelopeDb(x, SR, { hopMs: 5, winMs: 10 }).db;
  const o = want(samples);
  const c = want(conv.map((v) => (Number.isFinite(v) ? v : 0)));
  assert.equal(env.length, Math.floor(o.length / 50));
  env.forEach((e, k) => {
    assert.equal(e.hopMs, 5);
    assert.equal(e.frame, 50 * k);
    assert.equal(e.orig.length, 50);
    // Sent as soon as its last frame is complete.
    const done = (e.frame + 49) * 240 + 480;
    assert.ok(e.at >= done && e.at < done + BLOCK, `event ${k} at ${e.at}, complete at ${done}`);
    for (let f = 0; f < 50; f++) {
      assert.ok(Math.abs(e.orig[f] - o[e.frame + f]) < 1e-3, `orig frame ${e.frame + f}: ${e.orig[f]} vs ${o[e.frame + f]}`);
      assert.ok(Math.abs(e.conv[f] - c[e.frame + f]) < 1e-3, `conv frame ${e.frame + f}: ${e.conv[f]} vs ${c[e.frame + f]}`);
    }
  });
});

test("silence in, silence out: in every state, after crossfades, replays and lip sync", () => {
  const zeros = new Float32Array(ms(4000));
  for (const script of [[], START(300), [...START(300), [ms(1000), { type: "own" }]], [[0, { type: "lipSync", totalMs: 300 }], ...START(300)]]) {
    const { out } = run(zeros, zeros, { script });
    assert.ok(out.every((v) => v === 0));
  }
  // Missing inputs (an unconnected worklet input) and a short one count as silence.
  const bare = new SafetyMixer();
  const blk = new Float32Array(BLOCK).fill(1);
  bare.process(null, undefined, blk);
  assert.ok(blk.every((v) => v === 0));
  bare.process(new Float32Array(5).fill(0.25), null, blk);
  assert.deepEqual(Array.from(blk.subarray(0, 7)), [0.25, 0.25, 0.25, 0.25, 0.25, 0, 0]);
  // Speech that switches to the converted voice, a stall, a replay ... then both go silent.
  const { samples, utterances } = speech(1, 16);
  const D = 300;
  const [at] = stallPoints(samples, utterances, rng(1), 1, 10);
  const orig = new Float32Array(samples.length + ms(4000));
  orig.set(samples);
  const conv = engine(orig, { delayMs: D, stopAt: at + ms(D), resumeAt: samples.length });
  const { out, events } = run(orig, conv, { script: START(D) });
  assert.ok(events.some((e) => e.type === "fault"));
  assert.ok(out.subarray(samples.length + ms(2000)).every((v) => v === 0));
});

test("the limiter keeps peaks at -1 dBFS and lets go: bit-exact passthrough again after the release", () => {
  const { samples } = speech(2, 8);
  const hot = Float32Array.from(samples);
  for (let i = ms(2000); i < ms(3000); i++) hot[i] *= 8; // peaks near +4 dBFS
  const { out } = run(hot, new Float32Array(hot.length));
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak <= LIMIT * (1 + 1e-6) && peak > 0.8 * LIMIT, `peak ${peak}`);
  for (let i = ms(4000); i < out.length; i++) if (out[i] !== hot[i]) assert.fail(`sample ${i}: still limited`);
  assert.ok(maxStep(out) <= 2 * maxStep(hot));

  // A converted voice 12 dB hot (the gain can only take 6 dB off): limited too.
  const long = speech(2, 14).samples;
  const conv = engine(long, { delayMs: 300, gainDb: 12, cutoffHz: null });
  const r = run(long, conv, { script: START(300) });
  assert.equal(r.mixer.state, "converting");
  assert.ok(r.out.every((v) => Math.abs(v) <= LIMIT * (1 + 1e-6)));
});

test("the converted voice is brought to the original's level: -offset within ±6 dB, set while unheard, at most 1 dB/s while heard", () => {
  const { samples } = speech(6, 36);
  const conv = engine(samples, { delayMs: 300, gainDb: -3 });
  const step = ms(16000);
  for (let i = step; i < conv.length; i++) conv[i] *= 10 ** (4 / 20); // the engine gets 4 dB louder
  const gains = [];
  const { events } = run(samples, conv, { script: START(300), onBlock: (m, i) => gains.push([i, m.gainDb, m.state]) });
  const T0 = firstState(events, "converting").from;
  assert.ok(T0 < step);
  // At the switch it already matches the converted voice (-3 dB, ~0.5 dB more of the low-pass).
  const atSwitch = gains.find(([i]) => i === T0)[1];
  assert.ok(Math.abs(atSwitch - 3.5) < 0.75, `gain ${atSwitch} dB at the switch`);
  for (let k = 1; k < gains.length; k++) {
    if (gains[k][0] <= T0) continue;
    const d = Math.abs(gains[k][1] - gains[k - 1][1]);
    assert.ok(d <= (1 * BLOCK) / SR + 1e-9, `gain moved ${d} dB in one block at ${gains[k][0]}`);
  }
  const end = gains[gains.length - 1][1];
  assert.ok(Math.abs(end + 0.5) < 0.75, `gain ${end} dB at the end`);
  assert.ok(Math.abs(gains.find(([i]) => i >= step + ms(2000))[1] - atSwitch) <= 2.01, "moved faster than 1 dB/s");

  // Clamped to ±6 dB.
  const quiet = run(samples, engine(samples, { delayMs: 300, gainDb: -10 }), { script: START(300), until: ms(16000) });
  assert.equal(quiet.mixer.gainDb, 6);
});

test("the block size does not change the decisions", () => {
  const { samples, utterances } = speech(4, 20);
  const D = 300;
  const [at] = stallPoints(samples, utterances, rng(4), 1, 11);
  const conv = engine(samples, { delayMs: D, stopAt: at + ms(D) });
  const results = [128, 480, 100, 2048].map((block) => {
    const { events } = run(samples, conv, { block, script: START(D) });
    const fault = events.find((e) => e.type === "fault");
    return { block, sw: firstState(events, "converting").from, fault: fault.from };
  });
  for (const r of results) {
    assert.ok(Math.abs(r.sw - results[0].sw) <= 2048, `block ${r.block}: switch at ${r.sw} vs ${results[0].sw}`);
    assert.ok(Math.abs(r.fault - results[0].fault) <= 2048, `block ${r.block}: fault at ${r.fault} vs ${results[0].fault}`);
  }
});

test("cheap enough for the audio thread: 1 s of audio (375 blocks) in well under 30 ms", () => {
  const { samples, utterances } = speech(6, 30);
  const D = 300;
  const [at] = stallPoints(samples, utterances, rng(7), 1, 10);
  const conv = engine(samples, { delayMs: D, stopAt: at + ms(D), resumeAt: at + ms(D) + ms(1000) });
  const blocks = Math.floor(samples.length / BLOCK);
  const views = [];
  for (let b = 0; b < blocks; b++) views.push([samples.subarray(b * BLOCK, (b + 1) * BLOCK), conv.subarray(b * BLOCK, (b + 1) * BLOCK)]);
  const out = new Float32Array(BLOCK);
  const once = () => {
    const m = new SafetyMixer({ mode: "practice", lipSyncMs: 450 });
    for (const [, msg] of START(D)) m.command(msg);
    const t0 = performance.now();
    for (const [o, c] of views) {
      m.process(o, c, out);
      m.takeEvents();
    }
    return { elapsed: performance.now() - t0, m };
  };
  once(); // warm up
  const { elapsed, m } = once();
  const perSecond = elapsed / ((blocks * BLOCK) / SR);
  // About 2 ms here: a stall, a replay, catching up and an automatic return included.
  assert.ok(perSecond < 30, `${perSecond.toFixed(2)} ms per second of audio`);
  assert.equal(m.state, "converting");
});
