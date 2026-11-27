/**
 * Speech-like test signals: utterances of voiced "syllables" (a harmonic
 * buzz with a syllable-shaped loudness curve), some led by a noisy
 * consonant, separated by short gaps; utterances separated by pauses.
 * Deterministic for a given seed, so tests are repeatable.
 */

export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (rand, lo, hi) => lo + (hi - lo) * rand();

export function synthSpeech({ sampleRate = 48000, seconds = 12, seed = 1, leadSec = 0.5, tailSec = 1.0 } = {}) {
  const rand = rng(seed);
  const total = Math.round(seconds * sampleRate);
  const out = new Float32Array(total);
  const utterances = [];
  let t = Math.round(leadSec * sampleRate);
  const stop = total - Math.round(tailSec * sampleRate);
  while (t < stop) {
    const uttStart = t;
    const syllables = 3 + Math.floor(rand() * 6);
    for (let s = 0; s < syllables && t < stop; s++) {
      if (rand() < 0.4) {
        // Consonant: a burst of high-ish noise.
        const n = Math.round(between(rand, 0.03, 0.09) * sampleRate);
        let prev = 0;
        for (let i = 0; i < n && t + i < stop; i++) {
          const white = rand() * 2 - 1;
          const hp = white - prev; // crude high-pass
          prev = white;
          const env = Math.sin((Math.PI * i) / n);
          out[t + i] += 0.08 * hp * env;
        }
        t += n;
      }
      const n = Math.round(between(rand, 0.09, 0.28) * sampleRate);
      const f0 = between(rand, 100, 220);
      const glide = between(rand, -0.25, 0.25);
      let phase = 0;
      for (let i = 0; i < n && t + i < stop; i++) {
        const k = i / n;
        const f = f0 * (1 + glide * k);
        phase += (2 * Math.PI * f) / sampleRate;
        let x = 0;
        for (let h = 1; h <= 12; h++) x += Math.sin(h * phase) / h;
        const attack = Math.min(1, i / (0.015 * sampleRate));
        const env = attack * Math.sin(Math.PI * Math.min(1, k * 1.05)) ** 0.6;
        out[t + i] += 0.12 * x * env;
      }
      t += n;
      t += Math.round(between(rand, 0.02, 0.12) * sampleRate);
    }
    utterances.push({ start: uttStart / sampleRate, end: Math.min(t, stop) / sampleRate });
    t += Math.round(between(rand, 0.6, 1.0) * sampleRate);
  }
  return { samples: out, utterances, sampleRate };
}

/** An inhalation: noise shaped to about 400-4000 Hz with soft ends, peak 1. */
export function breathNoise(sampleRate, seconds, seed = 1) {
  const rand = rng(seed);
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const ah = Math.exp((-2 * Math.PI * 400) / sampleRate);
  const al = 1 - Math.exp((-2 * Math.PI * 4000) / sampleRate);
  let hx = 0;
  let hy = 0;
  let lp = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const w = rand() * 2 - 1;
    const y = ah * (hy + w - hx);
    hx = w;
    hy = y;
    lp += al * (y - lp);
    const k = i / n;
    out[i] = lp * Math.min(1, k / 0.2, (1 - k) / 0.2);
    peak = Math.max(peak, Math.abs(out[i]));
  }
  for (let i = 0; i < n; i++) out[i] /= peak || 1;
  return out;
}

/** `x` with digital silence before and after, as the probe records a run. */
export function padded(x, sampleRate, { leadSec = 0.15, tailSec = 2.5 } = {}) {
  const out = new Float32Array(Math.round(leadSec * sampleRate) + x.length + Math.round(tailSec * sampleRate));
  out.set(x, Math.round(leadSec * sampleRate));
  return out;
}

/** Copy of `x` delayed by `delaySamples` (positive = later), same length. */
export function delayed(x, delaySamples) {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const j = i - delaySamples;
    out[i] = j >= 0 && j < x.length ? x[j] : 0;
  }
  return out;
}

/** One-pole low-pass (a different "voice colour"), then a gain in dB. */
export function recolour(x, sampleRate, { cutoffHz = 2500, gainDb = 0 } = {}) {
  const a = 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  const g = 10 ** (gainDb / 20);
  const out = new Float32Array(x.length);
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    y += a * (x[i] - y);
    out[i] = g * y;
  }
  return out;
}

export function addNoise(x, levelDb, seed = 7) {
  const rand = rng(seed);
  const amp = 10 ** (levelDb / 20);
  return x.map((v) => v + amp * (rand() * 2 - 1));
}

/** White noise band-limited to `cutoffHz` by summing random-phase sines. */
export function bandNoise(sampleRate, seconds, cutoffHz, seed = 3) {
  const rand = rng(seed);
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const step = 50;
  const parts = [];
  for (let f = step; f <= cutoffHz; f += step) parts.push({ w: (2 * Math.PI * f) / sampleRate, p: rand() * 2 * Math.PI });
  const amp = 0.5 / Math.sqrt(parts.length);
  for (const { w, p } of parts) for (let i = 0; i < n; i++) out[i] += amp * Math.sin(w * i + p);
  return out;
}

/**
 * A steady sine (the long check's test tone by default: 1031.25 Hz, exactly
 * 11 cycles per 512 samples at 48 kHz) with a peak level of `dbfs`.
 */
export function tone({ sampleRate = 48000, seconds = 1, hz = 1031.25, dbfs = -12, phase = 0.3 } = {}) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const amp = 10 ** (dbfs / 20);
  const w = (2 * Math.PI * hz) / sampleRate;
  // The phase wraps every `period` samples when the tone fits a whole number of cycles into it (1031.25 Hz: 512).
  const period = Number.isInteger((hz * 512) / sampleRate) ? 512 : 0;
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(w * (period ? i % period : i) + phase);
  return out;
}

// Positions and lengths below are sample counts; fractional ones (seconds × rate) are rounded.

/** `x` without the `n` samples from `at` (a clock crossing that dropped a buffer): shorter by n. */
export function dropFrames(x, at, n) {
  at = Math.round(at);
  n = Math.round(n);
  const out = new Float32Array(x.length - n);
  out.set(x.subarray(0, at));
  out.set(x.subarray(at + n), at);
  return out;
}

/** `x` with `n` zeros inserted at `at` (a clock crossing that ran short): longer by n. */
export function insertZeros(x, at, n) {
  at = Math.round(at);
  n = Math.round(n);
  const out = new Float32Array(x.length + n);
  out.set(x.subarray(0, at));
  out.set(x.subarray(at), at + n);
  return out;
}

/** A copy of `x` with the `n` samples from `at` set to zero (a dropout): same length. */
export function zeroFill(x, at, n) {
  at = Math.round(at);
  const out = Float32Array.from(x);
  out.fill(0, at, Math.min(x.length, at + Math.round(n)));
  return out;
}

/** A copy of `x` whose gain moves by `db` from `at`, over `rampFrames` samples (linear in dB; 0 = at once). */
export function gainStep(x, at, db, rampFrames = 0) {
  const out = Float32Array.from(x);
  for (let i = Math.round(at); i < out.length; i++) {
    const k = rampFrames > 0 ? Math.min(1, (i - at) / rampFrames) : 1;
    out[i] *= 10 ** ((db * k) / 20);
  }
  return out;
}

/** A copy of `x` with `value` added to the sample at `at` (a click). */
export function addSpike(x, at, value) {
  const out = Float32Array.from(x);
  out[Math.round(at)] += value;
  return out;
}

/** `n` samples of seeded white noise (uniform) with an RMS level of `dbfs`. */
export function whiteNoise(n, seed, dbfs = -60) {
  const rand = rng(seed);
  const amp = 10 ** (dbfs / 20) * Math.sqrt(3);
  const out = new Float32Array(Math.round(n));
  for (let i = 0; i < n; i++) out[i] = amp * (rand() * 2 - 1);
  return out;
}
