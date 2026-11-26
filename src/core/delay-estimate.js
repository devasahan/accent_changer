/**
 * How much later, and how completely, a processed copy of speech comes back.
 *
 * Pure functions (no DOM, no Web Audio): the spike page, the app and the Node
 * tests all use them. Two recordings are compared that were captured side by
 * side in one AudioContext: `ref`, what went into the engine, and `sig`, what
 * came out. The converted voice sounds different from the original, so the
 * comparison uses loudness over time (syllables, pauses) rather than the
 * waveform: a frame-by-frame accent converter keeps the speaker's timing.
 */

const SILENCE_DB = -120;

/** Short-time loudness in dB, one value every `hopMs`, each over `winMs`. */
export function envelopeDb(samples, sampleRate, { hopMs = 2, winMs = 10 } = {}) {
  const hop = Math.max(1, Math.round((sampleRate * hopMs) / 1000));
  const win = Math.max(hop, Math.round((sampleRate * winMs) / 1000));
  const frames = samples.length >= win ? Math.floor((samples.length - win) / hop) + 1 : 0;
  const db = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const start = f * hop;
    for (let i = start, end = start + win; i < end; i++) sum += samples[i] * samples[i];
    db[f] = Math.max(SILENCE_DB, 10 * Math.log10(sum / win + 1e-12));
  }
  return { db, hopMs: (hop / sampleRate) * 1000 };
}

/** Linear-interpolated percentile (p in 0..100) of a list of numbers. */
export function percentile(values, p) {
  const list = Array.from(values).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!list.length) return null;
  const pos = (Math.min(100, Math.max(0, p)) / 100) * (list.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return list[lo] + (list[hi] - list[lo]) * (pos - lo);
}

export function median(values) {
  return percentile(values, 50);
}

/** Loudness levels that separate speech from pauses in one recording. */
function levels(db) {
  const floor = percentile(db, 10) ?? SILENCE_DB;
  const peak = percentile(db, 99.5) ?? SILENCE_DB;
  return { floor, peak, threshold: Math.max(floor + 10, peak - 40) };
}

/** True when a recording holds something speech-like rather than silence or steady hum. */
export function hasSignal(db) {
  if (!db.length) return false;
  const { floor, peak } = levels(db);
  return peak > -70 && peak - floor > 15;
}

/** Envelope prepared for correlation: quiet parts clamped, mean removed. */
function prepare(db, rangeDb = 50) {
  let max = -Infinity;
  for (const v of db) if (v > max) max = v;
  const lo = max - rangeDb;
  const out = new Float32Array(db.length);
  let sum = 0;
  for (let i = 0; i < db.length; i++) {
    out[i] = Math.max(db[i], lo);
    sum += out[i];
  }
  const mean = db.length ? sum / db.length : 0;
  for (let i = 0; i < out.length; i++) out[i] -= mean;
  return out;
}

/** Rises in loudness (syllable starts): sharper peaks than the envelope itself. */
function onsets(db, rangeDb = 50) {
  let max = -Infinity;
  for (const v of db) if (v > max) max = v;
  const lo = max - rangeDb; // flicker in the pauses' noise is not an onset
  const out = new Float32Array(db.length);
  let sum = 0;
  for (let i = 2; i < db.length; i++) {
    const d = Math.max(db[i], lo) - Math.max(db[i - 2], lo);
    out[i] = d > 0 ? d : 0;
    sum += out[i];
  }
  const mean = db.length ? sum / db.length : 0;
  for (let i = 0; i < out.length; i++) out[i] -= mean;
  return out;
}

/**
 * Normalised cross-correlation r[k] of a[n] with b[n + lag] for every lag in
 * [minLag, maxLag] (in frames). Returns { lags, r }.
 */
function crossCorrelate(a, b, minLag, maxLag) {
  const sqA = new Float64Array(a.length + 1);
  const sqB = new Float64Array(b.length + 1);
  for (let i = 0; i < a.length; i++) sqA[i + 1] = sqA[i] + a[i] * a[i];
  for (let i = 0; i < b.length; i++) sqB[i + 1] = sqB[i] + b[i] * b[i];
  const r = new Float64Array(maxLag - minLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    const n0 = Math.max(0, -lag);
    const n1 = Math.min(a.length, b.length - lag);
    let value = 0;
    if (n1 - n0 > 0) {
      let s = 0;
      for (let n = n0; n < n1; n++) s += a[n] * b[n + lag];
      const ea = sqA[n1] - sqA[n0];
      const eb = sqB[n1 + lag] - sqB[n0 + lag];
      value = ea > 0 && eb > 0 ? s / Math.sqrt(ea * eb) : 0;
    }
    r[lag - minLag] = value;
  }
  return { minLag, r };
}

/** Index of the largest value, refined between frames with a parabola. */
function peakOf(r, from = 0, to = r.length - 1) {
  let best = from;
  for (let i = from + 1; i <= to; i++) if (r[i] > r[best]) best = i;
  let pos = best;
  if (best > 0 && best < r.length - 1) {
    const y0 = r[best - 1];
    const y1 = r[best];
    const y2 = r[best + 1];
    const denom = y0 - 2 * y1 + y2;
    if (denom < 0) pos = best + (0.5 * (y0 - y2)) / denom;
  }
  return { index: best, position: pos, value: r[best] };
}

/**
 * Overall delay of `sig` behind `ref`, in ms. Null when either recording has
 * no speech-like signal. `score` is the correlation peak (1 = identical
 * loudness pattern; below ~0.3 the number is not trustworthy).
 */
export function estimateDelay(ref, sig, sampleRate, { minLagMs = -100, maxLagMs = 2000, hopMs = 2, winMs = 10 } = {}) {
  const A = envelopeDb(ref, sampleRate, { hopMs, winMs });
  const B = envelopeDb(sig, sampleRate, { hopMs, winMs });
  return estimateDelayFromEnvelopes(A.db, B.db, A.hopMs, { minLagMs, maxLagMs });
}

export function estimateDelayFromEnvelopes(refDb, sigDb, hopMs, { minLagMs = -100, maxLagMs = 2000 } = {}) {
  if (!hasSignal(refDb) || !hasSignal(sigDb)) return null;
  const minLag = Math.round(minLagMs / hopMs);
  const maxLag = Math.round(maxLagMs / hopMs);
  const coarse = crossCorrelate(prepare(refDb), prepare(sigDb), minLag, maxLag);
  const c = peakOf(coarse.r);
  const coarseLag = c.position + minLag;

  // Refine around the coarse peak with syllable onsets, which give a narrower peak.
  const span = Math.max(3, Math.round(40 / hopMs));
  const lo = Math.round(coarseLag) - span;
  const hi = Math.round(coarseLag) + span;
  const fine = crossCorrelate(onsets(refDb), onsets(sigDb), lo, hi);
  const f = peakOf(fine.r);
  const useFine = f.value >= 0.25 && f.index > 0 && f.index < fine.r.length - 1;
  const lagFrames = useFine ? f.position + lo : coarseLag;
  return {
    lagMs: lagFrames * hopMs,
    score: c.value,
    onsetScore: f.value,
    method: useFine ? "onsets" : "envelope",
  };
}

/**
 * Speech frames of a recording: louder than its own pause level, with short
 * dips (between syllables) bridged and tiny blips dropped.
 */
export function speechMask(db, hopMs, { bridgeMs = 60, minMs = 30 } = {}) {
  const { threshold } = levels(db);
  const mask = new Uint8Array(db.length);
  for (let i = 0; i < db.length; i++) mask[i] = db[i] > threshold ? 1 : 0;
  fillRuns(mask, 0, Math.round(bridgeMs / hopMs), 1);
  fillRuns(mask, 1, Math.round(minMs / hopMs), 0);
  return mask;
}

/** Turn interior runs of `value` shorter than `maxLen` frames into `fill`. */
function fillRuns(mask, value, maxLen, fill) {
  let i = 0;
  while (i < mask.length) {
    if (mask[i] !== value) {
      i++;
      continue;
    }
    let j = i;
    while (j < mask.length && mask[j] === value) j++;
    const interior = i > 0 && j < mask.length;
    if (j - i < maxLen && (interior || value === 1)) mask.fill(fill, i, j);
    i = j;
  }
}

/** Shrink (negative frames) or grow (positive) the true runs of a mask. */
function morph(mask, frames) {
  const out = new Uint8Array(mask.length);
  const k = Math.abs(frames);
  for (let i = 0; i < mask.length; i++) {
    let v = frames >= 0 ? 0 : 1;
    for (let j = Math.max(0, i - k); j <= Math.min(mask.length - 1, i + k); j++) {
      if (frames >= 0 && mask[j]) {
        v = 1;
        break;
      }
      if (frames < 0 && !mask[j]) {
        v = 0;
        break;
      }
    }
    out[i] = v;
  }
  return out;
}

/** Utterances: speech separated by pauses of at least `pauseMs`. Frame ranges [start, end). */
export function utterances(mask, hopMs, { pauseMs = 600, minMs = 150 } = {}) {
  const merged = Uint8Array.from(mask);
  fillRuns(merged, 0, Math.round(pauseMs / hopMs), 1);
  const list = [];
  let i = 0;
  while (i < merged.length) {
    if (!merged[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < merged.length && merged[j]) j++;
    if ((j - i) * hopMs >= minMs) list.push({ start: i, end: j });
    i = j;
  }
  return list;
}

/** Correlation of a[aStart..aStart+len) with b[bStart..), each with its own mean removed. */
function windowCorrelation(a, aStart, b, bStart, len) {
  if (aStart < 0 || bStart < 0 || aStart + len > a.length || bStart + len > b.length || len < 2) return 0;
  let ma = 0;
  let mb = 0;
  for (let n = 0; n < len; n++) {
    ma += a[aStart + n];
    mb += b[bStart + n];
  }
  ma /= len;
  mb /= len;
  let s = 0;
  let ea = 0;
  let eb = 0;
  for (let n = 0; n < len; n++) {
    const x = a[aStart + n] - ma;
    const y = b[bStart + n] - mb;
    s += x * y;
    ea += x * x;
    eb += y * y;
  }
  return ea > 0 && eb > 0 ? s / Math.sqrt(ea * eb) : 0;
}

/**
 * Delay of each utterance on its own, searched within ±searchMs of the
 * overall delay: shows whether the delay drifts or jumps during a run.
 */
export function utteranceDelays(refDb, sigDb, hopMs, lagMs, segs, { searchMs = 300, marginMs = 150, rangeDb = 50 } = {}) {
  const clamp = (db) => {
    let max = -Infinity;
    for (const v of db) if (v > max) max = v;
    return db.map((v) => Math.max(v, max - rangeDb));
  };
  const a = clamp(refDb);
  const b = clamp(sigDb);
  const margin = Math.round(marginMs / hopMs);
  const search = Math.round(searchMs / hopMs);
  const center = Math.round(lagMs / hopMs);
  return segs.map((seg) => {
    const start = Math.max(0, seg.start - margin);
    const end = Math.min(a.length, seg.end + margin);
    const len = end - start;
    const r = new Float64Array(2 * search + 1);
    for (let k = -search; k <= search; k++) r[k + search] = windowCorrelation(a, start, b, start + center + k, len);
    const p = peakOf(r);
    return {
      startSec: (seg.start * hopMs) / 1000,
      endSec: (seg.end * hopMs) / 1000,
      lagMs: (center + p.position - search) * hopMs,
      score: p.value,
    };
  });
}

/**
 * Holes: stretches where the converted output is silent while the original
 * had speech at the matching moment. A pause both share is not a hole.
 * Reports each silent run of the output that swallowed at least `minGapMs`
 * of speech.
 */
export function findGaps(refDb, sigDb, hopMs, lagMs, { minGapMs = 100, erodeMs = 30, growMs = 30 } = {}) {
  const lag = Math.round(lagMs / hopMs);
  const refSpeech = morph(speechMask(refDb, hopMs), -Math.round(erodeMs / hopMs));
  const { threshold } = levels(sigDb);
  const sigActive = new Uint8Array(sigDb.length);
  for (let i = 0; i < sigDb.length; i++) sigActive[i] = sigDb[i] > threshold ? 1 : 0;
  const sigOn = morph(sigActive, Math.round(growMs / hopMs));

  // Walk in output time; positions past the end of the output count as silent.
  const total = Math.max(sigDb.length, refDb.length + Math.max(0, lag));
  const gaps = [];
  let runStart = -1;
  let swallowed = 0;
  const close = (end) => {
    if (runStart >= 0 && swallowed * hopMs >= minGapMs) {
      gaps.push({
        atSec: ((runStart - lag) * hopMs) / 1000,
        silentMs: (end - runStart) * hopMs,
        missingSpeechMs: swallowed * hopMs,
        pastEnd: end > sigDb.length,
      });
    }
    runStart = -1;
    swallowed = 0;
  };
  for (let j = 0; j < total; j++) {
    const silent = j >= sigDb.length || !sigOn[j];
    if (!silent) {
      close(j);
      continue;
    }
    if (runStart < 0) runStart = j;
    const i = j - lag;
    if (i >= 0 && i < refSpeech.length && refSpeech[i]) swallowed++;
  }
  close(total);
  return gaps;
}

/** Energy-average level (dB) over the frames marked in `mask`. */
function maskedLevelDb(db, mask) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < db.length; i++) {
    if (!mask[i]) continue;
    sum += 10 ** (db[i] / 10);
    n++;
  }
  return n ? 10 * Math.log10(sum / n) : null;
}

/** In-place iterative radix-2 FFT of (re, im); length must be a power of two. */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/**
 * Highest frequency that still carries sound: the top of the averaged
 * spectrum of the loud frames, `dropDb` below its strongest band. Tells a
 * phone-band (8 kHz), wideband (16 kHz) and full-band (48 kHz) path apart.
 */
export function bandwidthHz(samples, sampleRate, { fftSize = 2048, dropDb = 60 } = {}) {
  const frames = Math.floor(samples.length / fftSize);
  if (!frames) return null;
  const energies = [];
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = f * fftSize, end = i + fftSize; i < end; i++) e += samples[i] * samples[i];
    energies.push(e);
  }
  const loudest = Math.max(...energies);
  if (!(loudest > 0)) return null;
  const half = fftSize / 2;
  const power = new Float64Array(half);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  let used = 0;
  for (let f = 0; f < frames; f++) {
    if (energies[f] < loudest / 100) continue; // within 20 dB of the loudest frame
    for (let i = 0; i < fftSize; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1));
      re[i] = samples[f * fftSize + i] * w;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < half; k++) power[k] += re[k] * re[k] + im[k] * im[k];
    used++;
  }
  if (!used) return null;
  // Smooth over ~1/3 octave-ish neighbourhood so single empty bins don't decide.
  let peak = 0;
  for (let k = 1; k < half; k++) if (power[k] > peak) peak = power[k];
  const limit = peak * 10 ** (-dropDb / 10);
  for (let k = half - 1; k > 0; k--) {
    let s = 0;
    let c = 0;
    for (let j = Math.max(1, k - 4); j <= Math.min(half - 1, k + 4); j++) {
      s += power[j];
      c++;
    }
    if (s / c > limit) return Math.round((k * sampleRate) / fftSize);
  }
  return 0;
}

/**
 * Everything the spike reports for one run through an engine: overall and
 * per-utterance delay, holes, level change and bandwidth.
 */
export function analyzeRun({ ref, sig, sampleRate, maxLagMs = 2000, hopMs = 2, winMs = 10 }) {
  const A = envelopeDb(ref, sampleRate, { hopMs, winMs });
  const B = envelopeDb(sig, sampleRate, { hopMs, winMs });
  const est = estimateDelayFromEnvelopes(A.db, B.db, A.hopMs, { maxLagMs });
  const base = {
    sampleRate,
    durationSec: ref.length / sampleRate,
    bandwidthRefHz: bandwidthHz(ref, sampleRate),
    bandwidthSigHz: bandwidthHz(sig, sampleRate),
  };
  if (!est) {
    return { ok: false, reason: hasSignal(A.db) ? "no converted audio came back" : "the recording is silent", ...base };
  }
  const refMask = speechMask(A.db, A.hopMs);
  const segs = utterances(refMask, A.hopMs);
  const utt = utteranceDelays(A.db, B.db, A.hopMs, est.lagMs, segs);
  const trusted = utt.filter((u) => u.score >= 0.3).map((u) => u.lagMs);
  const gaps = findGaps(A.db, B.db, A.hopMs, est.lagMs);
  const sigMask = speechMask(B.db, B.hopMs);
  const levelRefDb = maskedLevelDb(A.db, refMask);
  const levelSigDb = maskedLevelDb(B.db, sigMask);
  let speechFrames = 0;
  for (const v of refMask) speechFrames += v;
  return {
    ok: true,
    ...base,
    delayMs: est.lagMs,
    delayScore: est.score,
    delayMethod: est.method,
    utterances: utt,
    delayMedianMs: median(trusted),
    delayP95Ms: percentile(trusted, 95),
    delayMinMs: trusted.length ? Math.min(...trusted) : null,
    delayMaxMs: trusted.length ? Math.max(...trusted) : null,
    gaps,
    gapCount: gaps.length,
    gapMissingMs: gaps.reduce((s, g) => s + g.missingSpeechMs, 0),
    longestGapMs: gaps.reduce((m, g) => Math.max(m, g.silentMs), 0),
    speechSec: (speechFrames * A.hopMs) / 1000,
    levelRefDb,
    levelSigDb,
    levelDiffDb: levelRefDb != null && levelSigDb != null ? levelSigDb - levelRefDb : null,
  };
}
