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

/**
 * Loudness levels that separate speech from pauses in one recording.
 * Digital silence at the very start and end (the probe pads its recordings
 * with zeros) is left out: it is not the room's noise, and in a short take
 * it would pull the floor down to -120 dB and make every noise frame "speech".
 */
function levels(db) {
  let a = 0;
  let b = db.length;
  while (a < b && db[a] <= SILENCE_DB) a++;
  while (b > a && db[b - 1] <= SILENCE_DB) b--;
  const body = typeof db.subarray === "function" ? db.subarray(a, b) : db.slice(a, b);
  const floor = percentile(body, 10) ?? SILENCE_DB;
  const peak = percentile(body, 99.5) ?? SILENCE_DB;
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
 * dips (between syllables) bridged and tiny blips dropped. Sounds that never
 * come within `quietRunDb` of the recording's peak (breaths, lip smacks,
 * chair creaks) are not speech: words have vowels near full level.
 */
export function speechMask(db, hopMs, { bridgeMs = 60, minMs = 30, quietRunDb = 20 } = {}) {
  const { threshold, peak } = levels(db);
  const mask = new Uint8Array(db.length);
  for (let i = 0; i < db.length; i++) mask[i] = db[i] > threshold ? 1 : 0;
  fillRuns(mask, 0, Math.round(bridgeMs / hopMs), 1);
  fillRuns(mask, 1, Math.round(minMs / hopMs), 0);
  if (Number.isFinite(quietRunDb)) dropQuietRuns(mask, db, peak - quietRunDb);
  return mask;
}

/** Clear the runs of `mask` whose loudest frame stays below `minDb`. */
function dropQuietRuns(mask, db, minDb) {
  let i = 0;
  while (i < mask.length) {
    if (!mask[i]) {
      i++;
      continue;
    }
    let j = i;
    let loudest = -Infinity;
    while (j < mask.length && mask[j]) {
      if (db[j] > loudest) loudest = db[j];
      j++;
    }
    if (loudest < minDb) mask.fill(0, i, j);
    i = j;
  }
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
 * Delay of each utterance on its own, searched from `minLagMs` up to
 * `searchMs` either side of the overall delay: shows whether the delay
 * drifts or jumps during a run (a jitter buffer that grew after a network
 * hiccup, for example). `edge` marks a best match at the end of the search
 * window: the true delay is outside it, so the number is not usable.
 */
export function utteranceDelays(
  refDb,
  sigDb,
  hopMs,
  lagMs,
  segs,
  { searchMs = 1000, minLagMs = -100, marginMs = 150, rangeDb = 50 } = {},
) {
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
  const lo = Math.min(0, Math.max(-search, Math.round(minLagMs / hopMs) - center)); // offsets from the overall delay
  return segs.map((seg) => {
    const start = Math.max(0, seg.start - margin);
    const full = Math.min(a.length, seg.end + margin) - start;
    // An utterance at the very end of a recording may have its output cut off
    // by the end: compare only the part whose output is inside the recording
    // at every lag searched (one window length for all lags, so no lag is
    // favoured). With less than half of it left, the match can't be trusted.
    const len = Math.min(full, b.length - (start + center + search));
    const cut = len < full;
    const r = new Float64Array(search - lo + 1);
    for (let k = lo; k <= search; k++) r[k - lo] = windowCorrelation(a, start, b, start + center + k, len);
    const p = peakOf(r);
    return {
      startSec: (seg.start * hopMs) / 1000,
      endSec: (seg.end * hopMs) / 1000,
      lagMs: (center + lo + p.position) * hopMs,
      score: p.value,
      edge: p.index === 0 || p.index === r.length - 1 || (cut && len < full / 2),
    };
  });
}

/**
 * Holes: stretches where the converted output is silent while the original
 * had speech at the matching moment. A pause both share is not a hole.
 *
 * Each speech frame of the original is expected in the output at its own
 * utterance's delay (`segLags`, frame ranges with a lagMs), else at `lagMs`:
 * a sentence that arrives late is late, not missing. Every silent run of
 * the output is checked; `tolMs` at each end that touches sound is allowed
 * for timing slop. A run is a hole when, inside that margin, it swallowed at
 * least `minGapMs` of speech of which at least `minLoudMs` was within
 * `loudDb` of the original's peak (a vowel, not a breath the converter left
 * out). Reported per hole: where it starts in the original (atSec), its
 * length (holeMs: the longest stretch of missing speech in the run, pauses
 * under `splitMs` inside it included), the speech it swallowed in total
 * (missingSpeechMs) and the whole silent run around it (silentMs).
 */
export function findGaps(
  refDb,
  sigDb,
  hopMs,
  lagMs,
  { minGapMs = 100, tolMs = 20, loudDb = 20, minLoudMs = 40, blipMs = 30, splitMs = 100, segLags = [], refMask = null } = {},
) {
  const lag = Math.round(lagMs / hopMs);
  const refSpeech = refMask ?? speechMask(refDb, hopMs);
  const loudLevel = levels(refDb).peak - loudDb;

  const lagAt = new Int32Array(refDb.length).fill(lag);
  for (const s of segLags) {
    lagAt.fill(Math.round(s.lagMs / hopMs), Math.max(0, s.start), Math.min(refDb.length, s.end));
  }
  let maxLag = lag;
  for (let i = 0; i < refSpeech.length; i++) if (refSpeech[i] && lagAt[i] > maxLag) maxLag = lagAt[i];
  // Output time; positions past the end of the output count as silent.
  const total = Math.max(sigDb.length, refDb.length + Math.max(0, maxLag));
  const due = new Int32Array(total).fill(-1); // output frame -> original speech frame expected there
  for (let i = 0; i < refSpeech.length; i++) {
    if (!refSpeech[i]) continue;
    const j = i + lagAt[i];
    if (j >= 0 && j < total) due[j] = i;
  }

  const { threshold } = levels(sigDb);
  const active = new Uint8Array(total);
  for (let j = 0; j < sigDb.length; j++) active[j] = sigDb[j] > threshold ? 1 : 0;
  fillRuns(active, 1, Math.round(blipMs / hopMs), 0); // a click inside a hole is still a hole

  const tol = Math.round(tolMs / hopMs);
  const split = Math.round(splitMs / hopMs);
  const gaps = [];
  let a = 0;
  while (a < total) {
    if (active[a]) {
      a++;
      continue;
    }
    let b = a;
    while (b < total && !active[b]) b++;
    const coreFrom = a > 0 ? a + tol : a;
    const coreTo = b < total ? b - tol : b;
    let swallowed = 0;
    let core = 0;
    let loud = 0;
    // Longest cluster of missing speech in this run (the hole itself, not
    // the slop at the far side of a pause it runs into).
    let hole = null;
    let cluster = null;
    for (let j = a; j < b; j++) {
      const i = due[j];
      if (i < 0) continue;
      swallowed++;
      if (j >= coreFrom && j < coreTo) {
        core++;
        if (refDb[i] > loudLevel) loud++;
      }
      if (!cluster || j - cluster.last > split) cluster = { first: j, last: j, at: i };
      cluster.last = j;
      if (!hole || cluster.last - cluster.first > hole.last - hole.first) hole = { ...cluster };
    }
    if (core * hopMs >= minGapMs && loud * hopMs >= minLoudMs) {
      gaps.push({
        atSec: (hole.at * hopMs) / 1000,
        holeMs: (hole.last - hole.first + 1) * hopMs,
        missingSpeechMs: swallowed * hopMs,
        silentMs: (b - a) * hopMs,
        pastEnd: b > sigDb.length,
      });
    }
    a = b;
  }
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

/** A per-utterance delay is used when its match is clear and inside the search window. */
const TRUST_SCORE = 0.3;

/**
 * Where each stretch of speech is due in the output, for findGaps. Each
 * utterance is due at its own delay. An utterance that matches poorly
 * (score below `refineBelow`) probably had its delay change partway (a
 * stall, a jitter buffer draining): its phrases (speech between pauses of at
 * least `pauseMs`) then get their own delays, used only when they match
 * clearly (`acceptScore`). Falls back to the utterance's delay, then to the
 * overall one. Tuned on simulated stalls and real read speech with dropouts:
 * looser settings start explaining real dropouts away.
 */
function phraseLags(A, B, refMask, segs, utt, lagMs, { pauseMs = 200, searchMs = 1000, refineBelow = 0.8, acceptScore = 0.75 } = {}) {
  const out = [];
  segs.forEach((seg, k) => {
    const base = utt[k].trusted ? utt[k].lagMs : lagMs;
    const whole = utt[k].trusted ? [{ start: seg.start, end: seg.end, lagMs: base }] : [];
    if (utt[k].score >= refineBelow) {
      out.push(...whole);
      return;
    }
    const phrases = utterances(refMask.subarray(seg.start, seg.end), A.hopMs, { pauseMs, minMs: 100 }).map((p) => ({
      start: p.start + seg.start,
      end: p.end + seg.start,
    }));
    if (phrases.length < 2) {
      out.push(...whole);
      return;
    }
    const found = utteranceDelays(A.db, B.db, A.hopMs, base, phrases, { searchMs, marginMs: 100 });
    phrases.forEach((p, i) => {
      const f = found[i];
      const ok = f.score >= acceptScore && !f.edge;
      if (ok || utt[k].trusted) out.push({ start: p.start, end: p.end, lagMs: ok ? f.lagMs : base });
    });
  });
  return out;
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
  const utt = utteranceDelays(A.db, B.db, A.hopMs, est.lagMs, segs).map((u) => ({
    ...u,
    trusted: u.score >= TRUST_SCORE && !u.edge,
  }));
  const trusted = utt.filter((u) => u.trusted).map((u) => u.lagMs);
  const gaps = findGaps(A.db, B.db, A.hopMs, est.lagMs, { segLags: phraseLags(A, B, refMask, segs, utt, est.lagMs), refMask });
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
    longestGapMs: gaps.reduce((m, g) => Math.max(m, g.holeMs), 0),
    speechSec: (speechFrames * A.hopMs) / 1000,
    levelRefDb,
    levelSigDb,
    levelDiffDb: levelRefDb != null && levelSigDb != null ? levelSigDb - levelRefDb : null,
  };
}
