/**
 * What the Session B checks found, in numbers and plain words: the delay
 * through VB-CABLE, the long check of what the meeting hears (gaps, clicks
 * from the two clock crossings, the volume), how long a Windows Audio
 * restart took, and the Gate 1 checklist built from all the results.
 *
 * Two clocks meet the cable's. The microphone's: the passthrough's own
 * source node holds a buffer (a FIFO) that fills when the microphone runs
 * faster than VB-CABLE, then drops 10 ms at a time, and inserts 10 ms of
 * zeros when it runs slower. And Windows' default playback device's: the
 * converted voice will cross from it in Step 7, and the long check's test
 * tone takes that road. Each crossing gives one 10 ms click per 10 ms of
 * clock drift, so "no audible clicks" means "rare": at most 6 per 30 minutes
 * on each road.
 *
 * Pure: no DOM, no Web Audio, no clock. Times come in as numbers (frames at
 * 48 kHz, or ms on the page's performance.now() timeline).
 */
import {
  estimateDelayFromEnvelopes,
  findGaps,
  hasSignal,
  median,
  speechMask,
  utteranceDelays,
  utterances,
} from "./delay-estimate.js";

export const LIMITS = Object.freeze({
  DELAY_GOOD_MS: 110,
  DELAY_MAX_MS: 130,
  CAPTURE_DEFAULT_MS: 10,
  FRESH_FIFO_MS: 10,
  MIN_SCORE: 0.3,
  MIC_FIFO_NOTE_MS: 20,
  LAG_MIN_SCORE: 0.9,
  TICKS_PER_30_MIN: 6,
  DROPOUT_MS: 20,
  GAP_MS: 100,
  MIC_HOLE_MIN_MS: 8,
  MIC_HOLE_MAX_MS: 11,
  NOISE_GATE_FRACTION: 0.01,
  GATE_RUN_MAX_MS: 2000,
  GATE_MIN_RUNS: 20,
  MIN_SPEECH_SEC: 10,
  MIN_SPEECH_SHARE: 0.1,
  LEVEL_WARN_DB: -3,
  CABLE_QUIET_DB: -3,
  TONE_LEVEL_MIN_DB: -13,
  PAUSE_STEP_MS: 200,
  PAUSE_CONFIRM: 3,
  RESTART_MS: 2000,
  RESTART_APP_MS: 1000,
  MIN_PHASE_SEC: 25 * 60,
  HIDE_TAIL_SEC: 120,
  EXTEND_MAX_SEC: 35 * 60,
});

/** Frames per ms: every time base in the app is 48 kHz. */
const FRAMES_PER_MS = 48;

/** The tone's level as the monitor makes it (−12 dBFS). */
const TONE_DB = -12;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const round = (x, digits = 1) => {
  const k = 10 ** digits;
  return Math.round(x * k) / k;
};
const list = (v) => (Array.isArray(v) ? v.filter((x) => x !== null && typeof x === "object") : []);

/** "once", "twice", "3 times". */
const times = (n) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

/** A length of time for people: "300 ms", "12.5 s", "5 min". */
const lengthOfMs = (ms) =>
  ms < 10000 ? `${Math.round(ms)} ms` : ms < 120000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60000)} min`;

/** A level in dB with a real minus sign: "−12.0 dB". */
const dbText = (v) => `${v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)} dB`;

/**
 * How the reason for a microphone that sent only digital silence begins: gateSummary looks for it in a check's
 * reasons. A muted headset gives the same exact zeros as a capture Windows paused, so the reason names both.
 */
const MIC_STOPPED = "Your microphone sent only digital silence";

/** How the reason for a microphone that dropped out for 20 to 100 ms begins: gateSummary looks for it too. */
const MIC_DROPPED = "The microphone itself dropped out";

/** How the reason for other sound in the test tone begins: gateSummary looks for it too. */
const OTHER_SOUND = "Other sound was mixed into the test tone";

/** CABLE Output envelope frames at or below this carried nothing: digital silence (−120) or next to it. */
const SILENT_DB = -100;

/** What to do when the voice arrives much quieter in CABLE Output than it left the microphone. */
const QUIET_ADVICE =
  "check that CABLE Input and CABLE Output are at 100 % in Windows sound settings, and that Communications is set to “Do nothing”.";

/** The window phase in words. */
const PHASE_WORDS = { visible: "open", minimized: "minimized", hidden: "hidden" };

/** 75 → "1:15", 3725 → "1:02:05" (whole seconds; negative and non-numbers as 0). */
export function formatClock(sec) {
  const total = Math.max(0, Math.floor(isNum(sec) ? sec : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

// ---------- the delay ----------

/**
 * Verdict for one "Measure the delay" run. r: the analyzeRun() result
 * (ref = a fresh source node on the microphone, sig = CABLE Output) or
 * {ok: false, reason}. The estimate adds what the recording cannot see:
 * estimateMs = r.delayMs + (captureLatencyMs ?? CAPTURE_DEFAULT_MS) +
 * FRESH_FIFO_MS, to 1 decimal, ± 10 ms.
 * → { verdict: "good" | "borderline" | "slow" | "unclear" | "silent-mic" |
 * "silent-cable", estimateMs (null unless measured clearly), text, notes }:
 * good ≤ DELAY_GOOD_MS, borderline ≤ DELAY_MAX_MS, else slow. Notes: CABLE
 * Output much quieter than the microphone (a setting), and the share of the
 * delay that built up in the microphone's buffer (micFifoMs).
 */
export function delayVerdict(r, { captureLatencyMs = null, micFifoMs = null } = {}) {
  const notes = [];
  const result = (verdict, text, estimateMs = null) => ({ verdict, estimateMs, text, notes });
  if (!r || r.ok !== true) {
    const reason = String(r?.reason ?? "");
    if (/no converted audio/.test(reason)) {
      return result("silent-cable", "“CABLE Output” stayed silent: your voice isn't reaching VB-CABLE.");
    }
    if (/the recording is silent/.test(reason)) {
      return result("silent-mic", "Your microphone stayed silent: say “pa-ta-ka” during the 12 seconds.");
    }
    return result("unclear", "Could not measure clearly. Speak a bit louder, closer to the microphone, and try again.");
  }
  if (isNum(r.levelDiffDb) && r.levelDiffDb < LIMITS.CABLE_QUIET_DB) {
    notes.push(`The voice arrives ${(-r.levelDiffDb).toFixed(1)} dB quieter in CABLE Output: ${QUIET_ADVICE}`);
  }
  if (isNum(micFifoMs) && micFifoMs >= LIMITS.MIC_FIFO_NOTE_MS) {
    notes.push(
      `${Math.round(micFifoMs)} ms of this delay built up in the microphone's buffer since the app started (its clock runs faster than VB-CABLE's).`,
    );
  }
  const score = r.delayScore;
  if (!isNum(score) || score < LIMITS.MIN_SCORE || !isNum(r.delayMs)) {
    const match = isNum(score) ? ` (match ${score.toFixed(2)})` : "";
    return result("unclear", `Could not measure clearly${match}. Speak a bit louder, closer to the microphone, and try again.`);
  }
  const capture = isNum(captureLatencyMs) ? captureLatencyMs : LIMITS.CAPTURE_DEFAULT_MS;
  const estimateMs = round(r.delayMs + capture + LIMITS.FRESH_FIFO_MS, 1);
  const about = `Delay through VB-CABLE: about ${Math.round(estimateMs)} ms (± 10).`;
  if (estimateMs <= LIMITS.DELAY_GOOD_MS) return result("good", `${about} Good.`, estimateMs);
  if (estimateMs <= LIMITS.DELAY_MAX_MS) return result("borderline", `${about} Close to the limit: send me the results.`, estimateMs);
  return result("slow", `${about} Too slow.`, estimateMs);
}

/**
 * The lag in frames of `sig` behind `ref` when both carry the same samples
 * (two source nodes on one microphone track): the normalised
 * cross-correlation, for every lag L in [minLagFrames, maxLagFrames], of a
 * windowFrames-long window from the middle of `sig` with `ref` L frames
 * earlier (the energy of `ref` from running sums). Room noise is enough: no
 * speech needed. → { lagFrames, lagMs, score }, or null when the window is
 * digital silence, an array is shorter than maxLagFrames − minLagFrames +
 * windowFrames, or the best score is below minScore.
 * @param {Float32Array|number[]} ref
 * @param {Float32Array|number[]} sig
 */
export function sampleLag(ref, sig, { minLagFrames = -960, maxLagFrames = 5760, windowFrames = 4800, minScore = 0.9 } = {}) {
  const lo = Math.round(minLagFrames);
  const hi = Math.round(maxLagFrames);
  const W = Math.round(windowFrames);
  if (!ref || !sig || !(hi >= lo) || !(W >= 1)) return null;
  const need = hi - lo + W;
  if (ref.length < need || sig.length < need) return null;
  // sig[s0 + i] is compared with ref[s0 − L + i]: both must stay inside their arrays for every L.
  const first = Math.max(0, hi);
  const last = Math.min(sig.length - W, ref.length - W + lo);
  if (last < first) return null;
  const s0 = Math.min(last, Math.max(first, Math.floor((sig.length - W) / 2)));
  const win = Float64Array.from({ length: W }, (_, i) => sig[s0 + i]);
  let ew = 0;
  for (let i = 0; i < W; i++) ew += win[i] * win[i];
  if (!(ew > 0)) return null;
  const from = s0 - hi; // the first ref sample any lag uses
  const span = s0 - lo + W - from;
  const part = Float64Array.from({ length: span }, (_, i) => ref[from + i]);
  const sq = new Float64Array(span + 1);
  for (let i = 0; i < span; i++) sq[i + 1] = sq[i] + part[i] * part[i];
  const W4 = W - (W % 4);
  let best = -Infinity;
  let bestLag = lo;
  for (let L = lo; L <= hi; L++) {
    const a = s0 - L - from; // where this lag's ref window starts in `part`
    let d0 = 0;
    let d1 = 0;
    let d2 = 0;
    let d3 = 0;
    for (let i = 0; i < W4; i += 4) {
      d0 += win[i] * part[a + i];
      d1 += win[i + 1] * part[a + i + 1];
      d2 += win[i + 2] * part[a + i + 2];
      d3 += win[i + 3] * part[a + i + 3];
    }
    for (let i = W4; i < W; i++) d0 += win[i] * part[a + i];
    const dot = d0 + d1 + d2 + d3;
    const er = sq[a + W] - sq[a];
    const r = er > 0 ? dot / Math.sqrt(ew * er) : 0;
    if (r > best) {
      best = r;
      bestLag = L;
    }
  }
  if (!(best >= minScore)) return null;
  return { lagFrames: bestLag, lagMs: bestLag / FRAMES_PER_MS, score: best };
}

// ---------- zero runs ----------

const runList = (runs) =>
  list(runs)
    .filter((r) => isNum(r.startFrame) && isNum(r.frames))
    .sort((a, b) => a.startFrame - b.startFrame);

/**
 * Zero runs (from ZeroRuns) of the microphone (ref) and CABLE Output (sig),
 * frames on one timeline. A sig run is explained (it came from the
 * microphone) when a ref run starts 0 … maxLagMs earlier and their lengths
 * differ by at most slackMs.
 * → { dropouts: the unexplained sig runs, micHoles: ref runs shorter than
 * longMs, micSilent: ref runs of longMs or more, explained: the explained sig runs }
 */
export function classifyZeroRuns(refRuns, sigRuns, { sampleRate = 48000, maxLagMs = 300, slackMs = 5, longMs = 200 } = {}) {
  const frames = (ms) => (ms * sampleRate) / 1000;
  const refs = runList(refRuns);
  const sigs = runList(sigRuns);
  const maxLag = frames(maxLagMs);
  const slack = frames(slackMs);
  const dropouts = [];
  const explained = [];
  let from = 0; // refs before this start too early for every later sig run
  for (const s of sigs) {
    while (from < refs.length && refs[from].startFrame < s.startFrame - maxLag) from++;
    let ok = false;
    for (let i = from; i < refs.length && refs[i].startFrame <= s.startFrame; i++) {
      if (Math.abs(s.frames - refs[i].frames) <= slack) {
        ok = true;
        break;
      }
    }
    (ok ? explained : dropouts).push(s);
  }
  const long = frames(longMs);
  return {
    dropouts,
    micHoles: refs.filter((r) => r.frames < long),
    micSilent: refs.filter((r) => r.frames >= long),
    explained,
  };
}

/**
 * The microphone's 10 ms holes: micBus zero runs of MIC_HOLE_MIN_MS …
 * MIC_HOLE_MAX_MS (384–528 frames at 48 kHz), the FIFO's underrun inserts
 * and capture buffers marked silent, each a click in the voice. → n
 */
export function micHoleCount(refRuns, { sampleRate = 48000 } = {}) {
  const lo = Math.round((LIMITS.MIC_HOLE_MIN_MS * sampleRate) / 1000);
  const hi = Math.round((LIMITS.MIC_HOLE_MAX_MS * sampleRate) / 1000);
  let n = 0;
  for (const r of list(refRuns)) if (isNum(r.frames) && r.frames >= lo && r.frames <= hi) n++;
  return n;
}

// ---------- the microphone's clock ----------

/** A microphone clock more than this many ppm faster than VB-CABLE's is "faster": its buffer fills, then drops. */
const FASTER_PPM = 3;

/**
 * How far the buffer rises above its start before it counts as full. A
 * source's buffer holds at most 60 ms and starts with 0–20 ms of its own
 * (H1), so it rises only 30–50 ms before it drops; each reading has ± 10 ms.
 */
const RISE_MS = 25;

/**
 * Readings that start this far above a fresh source come from a buffer that
 * had already filled (a faster clock before the check, or rendering that
 * paused): it may have no room left to rise, so a flat slope says nothing
 * about a faster clock. A buffer that starts empty reads −20 to +20 ms.
 */
const FULL_START_MS = 30;

/** 10 ms drops per 30 minutes for a microphone clock offset: one per 10 ms of drift (ppm·1e-6 × 1800 s / 0.010 s). */
const dropsOf = (ppm) => Math.max(0, ppm) * 0.18;

/** Theil–Sen slope: the median of the slopes between every pair of points (in lag ms per second). */
function theilSen(points) {
  const slopes = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dt = points[j].atSec - points[i].atSec;
      if (dt > 0) slopes.push((points[j].lagMs - points[i].lagMs) / dt);
    }
  }
  return median(slopes);
}

/**
 * The microphone → CABLE crossing over a long check. samples: [{atSec,
 * lagMs, micGen}], the readings of how much delay the passthrough's own
 * buffer holds (micFifoMs). Only the longest run of readings with one
 * micGen is used: a new microphone source starts a new buffer. Each reading
 * has ± 10 ms of its own, so one difference means nothing; the slope over
 * many does. The run should start with the buffer empty (the tone check
 * gives micBus a new source at its start): the buffer can rise only 30–50 ms
 * before it drops (H1), so one that had already filled shows no slope.
 *  1. base = the first lag, or the median of the first 3 when that is lower.
 *     The buffer counts as full (it drops 10 ms at a time from then on) from
 *     the first group of three readings in a row (two, at the end) whose
 *     median is RISE_MS (25 ms) or more above base; saturatedAtSec = the time
 *     of the first reading of that group that is that high itself, else null.
 *     One high reading alone does not count.
 *  2. ppm = the Theil–Sen slope (ms/s × 1000) of the readings while the
 *     buffer rose: all of them when it never counted as full, else those
 *     before the first group (from saturatedAtSec on) whose median is within
 *     5 ms of the median of the readings from saturatedAtSec on (where it
 *     settles), when they span 600 s or more and number 4 or more; else, once
 *     saturated, 25 ms over the time from the first reading to
 *     saturatedAtSec, as a lower bound; else null. fullAtStart: base is
 *     FULL_START_MS (30 ms) or more and the buffer never rose by 25 ms: it
 *     had filled before the readings began, so there is no slope (ppm null)
 *     and only holes can still tell a clock.
 *  3. direction: ppm above 3 → "faster" (the buffer fills, then drops 10 ms
 *     per 10 ms of drift); else holes → "slower" (it inserts 10 ms of zeros
 *     per 10 ms of drift and its fill only saw-tooths, so the holes are the
 *     evidence: ppm = −holes × 10 ms / durationSec); else "same" when ppm is
 *     known; else null.
 *  4. dropsPer30Min = max(0, ppm) × 0.18; holesPer30Min = holes × 1800 /
 *     durationSec; ticksPer30Min = their sum.
 * slopePpm and slopeIsLowerBound keep step 2's result (null when the
 * readings were too few) after the holes take over ppm in step 3: with a
 * noise gate the holes seen are only some of them (gatedMicRoad), and the
 * slope is what tells a faster clock.
 * → { ppm, ppmIsLowerBound, direction, saturatedAtSec, fullAtStart, holes,
 * holesPer30Min, dropsPer30Min, ticksPer30Min, slopePpm, slopeIsLowerBound,
 * readings (the run used: [{atSec, lagMs}]) }
 */
export function micClock(samples, { holes = 0, durationSec = null } = {}) {
  const valid = list(samples).filter((s) => isNum(s.atSec) && isNum(s.lagMs));
  let best = [];
  let run = [];
  for (const s of valid) {
    if (run.length && s.micGen !== run[0].micGen) {
      if (run.length >= best.length) best = run;
      run = [];
    }
    run.push(s);
  }
  if (run.length >= best.length) best = run;
  const readings = best.map((s) => ({ atSec: s.atSec, lagMs: s.lagMs }));

  let ppm = null;
  let ppmIsLowerBound = false;
  let saturatedAtSec = null;
  let fullAtStart = false;
  if (readings.length) {
    const lags = readings.map((s) => s.lagMs);
    // The first reading alone when it is lower: with a fast clock the 2nd and 3rd are already on their way up.
    const base = Math.min(lags[0], median(lags.slice(0, 3)));
    // The first reading from which the median of it and the next two (the next one, at the end) is at `level`.
    const firstAt = (level, from) => {
      for (let i = from; i + 1 < lags.length; i++) if (median(lags.slice(i, i + 3)) >= level) return i;
      return -1;
    };
    const win = firstAt(base + RISE_MS, 1);
    // Full from the first reading of that window that is RISE_MS up itself (it, else the next one).
    const at = win < 0 ? -1 : lags[win] - base >= RISE_MS ? win : win + 1;
    const saturated = at >= 0 ? readings[at] : null;
    saturatedAtSec = saturated ? saturated.atSec : null;
    // The slope's readings: up to where the buffer settles (5 ms below the median of the readings from `at` on).
    const end = saturated ? Math.max(at, firstAt(Math.max(base + RISE_MS, median(lags.slice(at)) - 5), at)) : -1;
    const before = saturated ? readings.slice(0, end) : readings;
    const spanSec = before.length ? before[before.length - 1].atSec - before[0].atSec : 0;
    if (saturated) {
      // RISE_MS gathered by then (from the first reading of this run).
      const tookSec = saturated.atSec - readings[0].atSec;
      if (before.length >= 4 && spanSec >= 600) {
        ppm = theilSen(before) * 1000;
      } else if (tookSec > 0) {
        ppm = (RISE_MS / tookSec) * 1000;
        ppmIsLowerBound = true;
      }
    } else if (base >= FULL_START_MS) {
      // Filled before the readings began: a flat slope cannot tell "the same clock" from "faster".
      fullAtStart = true;
    } else if (before.length >= 4 && spanSec >= 600) {
      ppm = theilSen(before) * 1000;
    }
  }
  const slopePpm = ppm;
  const slopeIsLowerBound = ppmIsLowerBound;
  const holeCount = isNum(holes) && holes > 0 ? holes : 0;
  const duration = isNum(durationSec) && durationSec > 0 ? durationSec : null;
  let direction = null;
  if (ppm !== null && ppm > FASTER_PPM) {
    direction = "faster";
  } else if (holeCount > 0) {
    direction = "slower";
    ppm = duration ? -((holeCount * 0.01) / duration) * 1e6 : null;
    ppmIsLowerBound = false;
  } else if (ppm !== null) {
    direction = "same";
  }
  const dropsPer30Min = dropsOf(ppm ?? 0);
  const holesPer30Min = duration ? (holeCount * 1800) / duration : 0;
  return {
    ppm,
    ppmIsLowerBound,
    direction,
    saturatedAtSec,
    fullAtStart,
    holes: holeCount,
    holesPer30Min,
    dropsPer30Min,
    ticksPer30Min: dropsPer30Min + holesPer30Min,
    slopePpm,
    slopeIsLowerBound,
    readings,
  };
}

/**
 * The microphone's buffer slope, for a microphone with a noise gate (whose
 * holes are only some of a slower clock's): { ppm, lowerBound }, or null
 * when the readings were too few. micClock() gives it as slopePpm; a result
 * without that field (a check's result that kept only some of the fields)
 * has it worked out again from its readings, else from a ppm the holes did
 * not make.
 */
function slopeOf(mp) {
  if (!mp) return null;
  if (mp.slopePpm !== undefined) {
    return isNum(mp.slopePpm) ? { ppm: mp.slopePpm, lowerBound: mp.slopeIsLowerBound === true } : null;
  }
  if (Array.isArray(mp.readings) && mp.readings.length) {
    const again = micClock(mp.readings);
    return isNum(again.slopePpm) ? { ppm: again.slopePpm, lowerBound: again.slopeIsLowerBound } : null;
  }
  return isNum(mp.ppm) && mp.direction !== "slower" ? { ppm: mp.ppm, lowerBound: mp.ppmIsLowerBound === true } : null;
}

/**
 * The microphone's road for a microphone with a noise gate, for the check's
 * verdict and the checklist alike. A slower clock's 10 ms hole that falls
 * into the gate's own silence is not seen (it only makes that silence
 * longer), so the holes seen are some of its holes, never all; and the
 * buffer's slope tells only a faster clock, which makes drops, not holes.
 * → { ticks, atLeast, slope, holes }, or null when there is neither a slope
 * nor a hole (not measured). ticks: the drops the slope predicts when it
 * shows a faster clock, plus the holes seen per 30 minutes (their sum, as
 * micClock counts them without a gate). atLeast: the slope does not show a
 * faster clock, so a slower one is not ruled out and ticks is only a lower
 * bound: above TICKS_PER_30_MIN it fails, otherwise the road was not
 * measured; it never passes.
 */
function gatedMicRoad(mp) {
  if (!mp) return null;
  const slope = slopeOf(mp);
  const holes = isNum(mp.holes) && mp.holes > 0 ? mp.holes : 0;
  if (!slope && holes === 0) return null;
  const faster = slope !== null && slope.ppm > FASTER_PPM;
  const seen = holes > 0 && isNum(mp.holesPer30Min) ? mp.holesPer30Min : 0;
  return { ticks: (faster ? dropsOf(slope.ppm) : 0) + seen, atLeast: !faster, slope, holes };
}

// ---------- time ----------

/** Sync points with the time each one stands for: producedMs, else wallMs. Invalid points are skipped. */
function syncTimes(syncPoints) {
  const out = [];
  list(syncPoints).forEach((p, index) => {
    const t = isNum(p.producedMs) ? p.producedMs : p.wallMs;
    if (isNum(p.frame) && isNum(t)) out.push({ index, frame: p.frame, t, wallMs: p.wallMs, producedMs: p.producedMs });
  });
  return out;
}

/**
 * Frames to page time (ms). syncPoints: [{frame, producedMs, wallMs}],
 * ascending, one per worklet summary. The time used is producedMs (wallMs
 * when a point has none), so main-thread lateness does not move events.
 * Linear between points; before the first and after the last, 48 frames per
 * ms from the nearest point. toWallMs() gives null without points.
 */
export function frameClock(syncPoints) {
  const pts = syncTimes(syncPoints).sort((a, b) => a.frame - b.frame);
  return {
    toWallMs(frame) {
      if (!pts.length || !isNum(frame)) return null;
      const head = pts[0];
      const tail = pts[pts.length - 1];
      if (frame <= head.frame) return head.t + (frame - head.frame) / FRAMES_PER_MS;
      if (frame >= tail.frame) return tail.t + (frame - tail.frame) / FRAMES_PER_MS;
      let lo = 0;
      let hi = pts.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (pts[mid].frame <= frame) lo = mid;
        else hi = mid;
      }
      const a = pts[lo];
      const b = pts[hi];
      const span = b.frame - a.frame;
      return span > 0 ? a.t + ((frame - a.frame) * (b.t - a.t)) / span : b.t;
    },
  };
}

/**
 * Rendering pauses of the recording context, from the sync points
 * [{frame, producedMs, wallMs}]. producedMs is when the worklet made the
 * summary (its own clock stamp, mapped onto the page's timeline when it
 * arrived); wallMs is when the message arrived. offset = producedMs −
 * frame / 48 moves only when frames stop while time goes on (the context did
 * not render), never because the main thread was late.
 * A change of the system clock (a time sync) moves the stamps of every
 * summary that was on its way at that moment (made before it, mapped after
 * it) by the same amount: one odd stamp, or several when the main thread was
 * seconds late. A real pause moves every later point and stays. So a pause
 * at point i: the offset steps up by more than PAUSE_STEP_MS from point
 * i − 1, and the median offset of up to PAUSE_CONFIRM points from point i on
 * is above the median of up to PAUSE_CONFIRM points before point i by more
 * than PAUSE_STEP_MS, where both groups skip every point that could have
 * been on its way at the same moment as point i or point i − 1: later points
 * made (by the frames, from point i − 1's stamp) before point i arrived, and
 * earlier points that arrived after point i − 1 was made (by the frames,
 * from point i's stamp), each with PAUSE_STEP_MS to spare. Where either
 * group is empty (at the ends of the list), the delivery must have stepped
 * too: wallMs − frame / 48 up by more than PAUSE_STEP_MS from point i − 1
 * (a real pause delays the delivery as well; an odd stamp does not). Slow
 * drift between the audio clock and the system clock never forms a step.
 * Main-thread lateness (wallMs − producedMs) above PAUSE_STEP_MS is a late
 * delivery, never a pause.
 * → { pauses: [{index, atFrame, producedMs, ms}] (index, frame and time of
 * point i; ms = the step), late: {count, maxMs} }
 */
export function renderPauses(syncPoints) {
  const pts = syncTimes(syncPoints);
  const n = pts.length;
  const offsets = pts.map((p) => p.t - p.frame / FRAMES_PER_MS);
  const arrived = pts.map((p) => (isNum(p.wallMs) ? p.wallMs : p.t));
  const wallOffset = (p) => (isNum(p.wallMs) ? p.wallMs - p.frame / FRAMES_PER_MS : null);
  const C = LIMITS.PAUSE_CONFIRM;
  const STEP = LIMITS.PAUSE_STEP_MS;
  const pauses = [];
  for (let i = 1; i < n; i++) {
    const step = offsets[i] - offsets[i - 1];
    if (!(step > STEP)) continue;
    // Later points that could have been on their way with point i: made before it arrived.
    const made = (j) => pts[i - 1].t + (pts[j].frame - pts[i - 1].frame) / FRAMES_PER_MS;
    let after = i;
    while (after < n && made(after) < arrived[i] + STEP) after++;
    // Earlier points that could have been on their way with point i − 1: they arrived after it was made.
    const madeBefore = pts[i].t - (pts[i].frame - pts[i - 1].frame) / FRAMES_PER_MS;
    let before = i;
    while (before > 0 && arrived[before - 1] > madeBefore - STEP) before--;
    const later = offsets.slice(after, after + C);
    const earlier = offsets.slice(Math.max(0, before - C), before);
    if (later.length && earlier.length) {
      if (!(median(later) - median(earlier) > STEP)) continue;
    } else {
      const a = wallOffset(pts[i]);
      const b = wallOffset(pts[i - 1]);
      if (!(a !== null && b !== null && a - b > STEP)) continue;
    }
    pauses.push({ index: pts[i].index, atFrame: pts[i].frame, producedMs: pts[i].t, ms: step });
  }
  let count = 0;
  let maxMs = 0;
  for (const p of pts) {
    if (!isNum(p.producedMs) || !isNum(p.wallMs)) continue;
    const late = p.wallMs - p.producedMs;
    if (late > STEP) count++;
    if (late > maxMs) maxMs = late;
  }
  return { pauses, late: { count, maxMs } };
}

/**
 * Phases of the app window. marks (ascending atMs): {atMs, visibility:
 * "visible" | "hidden"} (visibilitychange), {atMs, visible?, minimized?,
 * focused?} (windowState polls), {atMs, hiddenByApp: true, untilMs} (Hide),
 * {atMs, note} (ignored here).
 * phaseAt(t), from the marks at or before t: "hidden" while a Hide is active
 * (from its atMs until untilMs, or until a later poll says visible: true);
 * else "minimized" when the last poll said minimized; else "hidden" when the
 * last poll said visible: false or the last visibility mark is "hidden";
 * else "visible"; "unknown" before the first mark.
 * spans(fromMs, toMs) → { visibleSec, minimizedSec, hiddenSec, unknownSec }, exact.
 */
export function phaseTimeline(marks) {
  const all = list(marks)
    .filter((m) => isNum(m.atMs) && m.note === undefined)
    .map((m, order) => ({ m, order }))
    .sort((a, b) => a.m.atMs - b.m.atMs || a.order - b.order)
    .map((x) => x.m);
  const isPoll = (m) => typeof m.visible === "boolean" || typeof m.minimized === "boolean";
  const hides = all
    .filter((m) => m.hiddenByApp === true)
    .map((h) => {
      let end = isNum(h.untilMs) ? h.untilMs : h.atMs;
      const shown = all.find((m) => m.atMs > h.atMs && isPoll(m) && m.visible === true);
      if (shown && shown.atMs < end) end = shown.atMs;
      return { from: h.atMs, to: end };
    });

  const foldAt = (t) => {
    let poll = null;
    let visibility = null;
    for (const m of all) {
      if (m.atMs > t) break;
      if (isPoll(m)) poll = m;
      if (typeof m.visibility === "string") visibility = m.visibility;
    }
    if (hides.some((h) => h.from <= t && t < h.to)) return "hidden";
    if (poll && poll.minimized === true) return "minimized";
    if ((poll && poll.visible === false) || visibility === "hidden") return "hidden";
    return "visible";
  };

  // The phase only changes at a mark or at the end of a Hide: work it out once for each.
  const times = [...new Set([...all.map((m) => m.atMs), ...hides.map((h) => h.to)])].sort((a, b) => a - b);
  const start = all.length ? all[0].atMs : Infinity;
  const steps = times.filter((t) => t >= start).map((t) => ({ t, phase: foldAt(t) }));

  const phaseAt = (wallMs) => {
    if (!isNum(wallMs) || !steps.length || wallMs < steps[0].t) return "unknown";
    let lo = 0;
    let hi = steps.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (steps[mid].t <= wallMs) lo = mid;
      else hi = mid - 1;
    }
    return steps[lo].phase;
  };

  const spans = (fromMs, toMs) => {
    const sec = { visibleSec: 0, minimizedSec: 0, hiddenSec: 0, unknownSec: 0 };
    if (!isNum(fromMs) || !isNum(toMs) || !(toMs > fromMs)) return sec;
    const cuts = [fromMs, ...steps.map((s) => s.t).filter((t) => t > fromMs && t < toMs), toMs];
    for (let i = 0; i < cuts.length - 1; i++) sec[`${phaseAt(cuts[i])}Sec`] += (cuts[i + 1] - cuts[i]) / 1000;
    return sec;
  };

  return { phaseAt, spans };
}

/**
 * When a long check stops after a Hide pressed during it: at least
 * tailSec after the Hide ends, never before the planned end, and never after
 * maxEndSec (plannedEndSec + EXTEND_MAX_SEC by default). Without a usable
 * hide end (or tail) there is no extension: plannedEndSec. → seconds since
 * the check started; null only when plannedEndSec is not a number. Never
 * NaN: the worklet could not stop by itself at a NaN.
 */
export function stopAfterHide({ plannedEndSec, hideEndSec, tailSec = LIMITS.HIDE_TAIL_SEC, maxEndSec } = {}) {
  if (!isNum(plannedEndSec)) return null;
  if (!isNum(hideEndSec) || !isNum(tailSec)) return plannedEndSec;
  const cap = isNum(maxEndSec) ? maxEndSec : plannedEndSec + LIMITS.EXTEND_MAX_SEC;
  return Math.min(cap, Math.max(plannedEndSec, hideEndSec + tailSec));
}

// ---------- the long check ----------

/**
 * Mic-mode analysis: loudness envelopes of the microphone (ref) and CABLE
 * Output (sig) on one time origin (5 ms hop), plus both sides' zero runs.
 * The delay comes from the whole recording, then each utterance gets its
 * own (the clock crossings move it in 10 ms steps), and findGaps looks for
 * speech that did not arrive. Without speech only the zero runs are checked.
 * Synchronous: about 5 s for 65 minutes, so the caller paints "Analysing…"
 * and yields once before calling it.
 * → { lagMs | null, lagScore | null, gaps (findGaps), speechSec, dropouts
 * (unexplained CABLE Output zero runs: [{startFrame, frames, ms}]), micHoles
 * (short microphone zero runs: n), micSilentSec, micPauses (the
 * microphone's own zero runs of GAP_MS or more: [{startFrame, frames, ms}],
 * for longVerdict's "capture paused"), cableSilent (CABLE Output carried
 * nothing: every frame of sigDb at or below −100 dB; false without frames) }
 */
export function analyzeSpeech({ refDb, sigDb, hopMs = 5, refRuns = [], sigRuns = [], sampleRate = 48000 } = {}) {
  const runs = classifyZeroRuns(refRuns, sigRuns, { sampleRate });
  const msOf = (frames) => (frames / sampleRate) * 1000;
  const asList = (rs) => rs.map((r) => ({ startFrame: r.startFrame, frames: r.frames, ms: round(msOf(r.frames), 2) }));
  const dropouts = asList(runs.dropouts);
  const micPauses = asList(runList(refRuns).filter((r) => msOf(r.frames) >= LIMITS.GAP_MS));
  const micSilentSec = runs.micSilent.reduce((s, r) => s + r.frames, 0) / sampleRate;
  const ref = refDb && typeof refDb.length === "number" ? refDb : new Float32Array(0);
  const sig = sigDb && typeof sigDb.length === "number" ? sigDb : new Float32Array(0);
  let cableSilent = sig.length > 0;
  for (let i = 0; cableSilent && i < sig.length; i++) if (!(sig[i] <= SILENT_DB)) cableSilent = false;
  let lagMs = null;
  let lagScore = null;
  let gaps = [];
  let speechSec = 0;
  if (ref.length && hasSignal(ref)) {
    const refMask = speechMask(ref, hopMs);
    let speechFrames = 0;
    for (let i = 0; i < refMask.length; i++) speechFrames += refMask[i];
    speechSec = (speechFrames * hopMs) / 1000;
    const est = sig.length ? estimateDelayFromEnvelopes(ref, sig, hopMs, { minLagMs: 0, maxLagMs: 500 }) : null;
    if (est) {
      lagMs = est.lagMs;
      lagScore = est.score;
      const segs = utterances(refMask, hopMs);
      const found = utteranceDelays(ref, sig, hopMs, est.lagMs, segs, { searchMs: 300, minLagMs: 0 });
      const segLags = [];
      found.forEach((u, k) => {
        if (u.score >= 0.3 && !u.edge) segLags.push({ start: segs[k].start, end: segs[k].end, lagMs: u.lagMs });
      });
      gaps = findGaps(ref, sig, hopMs, est.lagMs, { segLags, refMask });
    }
  }
  return { lagMs, lagScore, gaps, speechSec, dropouts, micHoles: runs.micHoles.length, micSilentSec, micPauses, cableSilent };
}

/** An event's time in seconds: atSec, else atFrame at 48 kHz; null without either. */
const eventSec = (e) => (isNum(e.atSec) ? e.atSec : isNum(e.atFrame) ? e.atFrame / 48000 : null);

/** The most two audio clocks drift apart (and the most the tone detector measures): one 10 ms event every 33 s. */
const MAX_DRIFT_PPM = 300;

/**
 * A FIFO holds at most 120 ms (6 buffers of a 20 ms period), so steady drift
 * gives its first drop or hole within 12 intervals of the start, plus one.
 */
const FIRST_EVENT_WITHIN = 13;

/**
 * The clock offset of the tone road from the tone's events. A clock
 * crossing gives one event of one kind per 10 ms of drift (skips: the
 * tone's clock is faster than CABLE's; holes: slower), at a steady interval
 * once its FIFO has filled or drained. With 3 or more events of one kind
 * that look like that, ppm = 10 ms / the median interval T (+ for skips, −
 * for holes) and ticksPer30Min = 1800 s / T. They look like steady drift
 * when T is at least 10 ms / MAX_DRIFT_PPM (33 s), the first came within 13
 * intervals of the start, and from the first one to the end of the check
 * they came at least every 2 T on average ((durationSec − first) / T ≤ 2 ×
 * their number). Otherwise (a burst of holes in one second, a cluster that
 * stopped) ticksPer30Min = ticks × 1800 / durationSec and ppm and direction
 * are null: they say nothing about the clocks. With fewer than 3 events of
 * one kind, ticksPer30Min is that same count rate and ppm = ticks × 10 ms /
 * durationSec (a bound when there are none).
 * → { ppm, direction: "faster" | "slower" | null, ticksPer30Min }
 */
export function clockFromEvents(events, durationSec) {
  const evs = list(events);
  const timesOf = (kind) =>
    evs
      .filter((e) => e.kind === kind)
      .map(eventSec)
      .filter(isNum)
      .sort((a, b) => a - b);
  const skips = timesOf("skip");
  const holes = timesOf("hole");
  const skipCount = evs.filter((e) => e.kind === "skip").length;
  const holeCount = evs.filter((e) => e.kind === "hole").length;
  const ticks = skipCount + holeCount + evs.filter((e) => e.kind === "click").length;
  if (!isNum(durationSec) || !(durationSec > 0)) return { ppm: null, direction: null, ticksPer30Min: null };
  const countRate = (ticks * 1800) / durationSec;
  const regular = skips.length >= 3 && skips.length >= holes.length ? { at: skips, sign: 1 } : holes.length >= 3 ? { at: holes, sign: -1 } : null;
  if (regular) {
    const at = regular.at;
    const intervals = [];
    for (let i = 1; i < at.length; i++) if (at[i] > at[i - 1]) intervals.push(at[i] - at[i - 1]);
    const every = median(intervals);
    const steady =
      isNum(every) &&
      every >= 0.01 / (MAX_DRIFT_PPM * 1e-6) &&
      at[0] <= FIRST_EVENT_WITHIN * every &&
      durationSec - at[0] <= 2 * at.length * every;
    if (!steady) return { ppm: null, direction: null, ticksPer30Min: countRate };
    return {
      ppm: (regular.sign * 0.01 * 1e6) / every,
      direction: regular.sign > 0 ? "faster" : "slower",
      ticksPer30Min: 1800 / every,
    };
  }
  const direction = skipCount > holeCount ? "faster" : holeCount > skipCount ? "slower" : null;
  const ppm = ((ticks * 0.01) / durationSec) * 1e6;
  return { ppm: direction === "slower" ? -ppm : ppm, direction, ticksPer30Min: countRate };
}

/** "15 s" for a short check, "65 min" for a long one. */
function lengthText(sec, inMinutes) {
  return inMinutes ? `${Math.round(sec / 60)} min` : `${Math.round(sec)} s`;
}

/** " at 12:30 while hidden", from what is known. */
function whereText(atSec, phase) {
  const at = isNum(atSec) ? ` at ${formatClock(atSec)}` : "";
  const word = PHASE_WORDS[phase];
  return at + (word ? ` while ${word}` : "");
}

const per30 = (x) => round(x, 1).toFixed(1);

/**
 * Whether the microphone sends digital silence in its pauses (a noise gate),
 * so that its own silences say nothing: NOISE_GATE_FRACTION or more of the
 * check is digital silence, and it comes the way a gate's does, which shuts
 * again and again at every pause in the sound: GATE_MIN_RUNS or more
 * silences of GAP_MS or more, or NOISE_GATE_FRACTION of the check in zero
 * runs shorter than GATE_RUN_MAX_MS. One or a few long silences are the
 * microphone muted or paused, however long they were: their length never
 * makes a gate. micZeroFraction: the frames in all its zero runs of 1 ms or
 * more / all frames; runs: its zero runs ([{startFrame, frames}]: at least
 * every run of GAP_MS or more); totalFrames: all frames. A long run missing
 * from `runs` stays among the short ones, so an error leans towards a gate (a
 * note in the checklist), never towards a pass. → boolean
 */
export function noiseGateOf(micZeroFraction, runs, totalFrames) {
  if (!isNum(micZeroFraction) || micZeroFraction < LIMITS.NOISE_GATE_FRACTION) return false;
  const longFrames = LIMITS.GATE_RUN_MAX_MS * FRAMES_PER_MS;
  const gapFrames = LIMITS.GAP_MS * FRAMES_PER_MS;
  let silences = 0;
  let frames = 0;
  for (const r of runList(runs)) {
    if (r.frames >= gapFrames) silences++;
    if (r.frames >= longFrames) frames += r.frames;
  }
  if (silences >= LIMITS.GATE_MIN_RUNS) return true;
  const share = isNum(totalFrames) && totalFrames > 0 ? frames / totalFrames : 0;
  return micZeroFraction - share >= LIMITS.NOISE_GATE_FRACTION;
}

/**
 * Where the "capture paused" rule finds the microphone's own zero runs of
 * GAP_MS or more: refRuns when given (both modes), else the mic-mode speech
 * analysis (its micPauses; else its micSilentSec, the runs of 200 ms or more,
 * whose number is not known). A run's time is its atSec (else startFrame at
 * 48 kHz) and its phase, when it has one. → { count, longestMs, atSec, phase }
 * | { totalMs } | null (nothing to check with).
 */
function micStops(refRuns, speech) {
  const long = (r) => r.ms >= LIMITS.GAP_MS;
  const run = (r, ms) => ({
    ms,
    atSec: isNum(r.atSec) ? r.atSec : isNum(r.startFrame) ? r.startFrame / (FRAMES_PER_MS * 1000) : null,
    phase: r.phase ?? null,
  });
  const summary = (runs) => {
    const top = runs.reduce((a, b) => (b.ms > a.ms ? b : a), { ms: 0, atSec: null, phase: null });
    return { count: runs.length, longestMs: top.ms, atSec: top.atSec, phase: top.phase };
  };
  if (Array.isArray(refRuns)) return summary(runList(refRuns).map((r) => run(r, r.frames / FRAMES_PER_MS)).filter(long));
  if (speech && Array.isArray(speech.micPauses)) {
    return summary(list(speech.micPauses).map((p) => run(p, isNum(p.ms) ? p.ms : (p.frames ?? 0) / FRAMES_PER_MS)).filter(long));
  }
  if (speech && isNum(speech.micSilentSec)) {
    return speech.micSilentSec > 0 ? { totalMs: speech.micSilentSec * 1000 } : summary([]);
  }
  return null;
}

/**
 * The microphone's own drop-outs: its zero runs (refRuns) of DROPOUT_MS up
 * to GAP_MS: several of its buffer's 10 ms holes in a row, a USB hiccup, a
 * capture that came late. In normal use the voice carries each one to the
 * meeting, as it carries a stop. A run may carry atSec and phase.
 * → { count, longest: the longest run } | null (no record of the runs).
 */
function micDrops(refRuns) {
  if (!Array.isArray(refRuns)) return null;
  const lo = LIMITS.DROPOUT_MS * FRAMES_PER_MS;
  const hi = LIMITS.GAP_MS * FRAMES_PER_MS;
  const drops = runList(refRuns).filter((r) => r.frames >= lo && r.frames < hi);
  return { count: drops.length, longest: drops.reduce((a, b) => (a && a.frames >= b.frames ? a : b), null) };
}

/**
 * Long-check verdict. input: { mode: "tone" | "mic", durationSec, phases
 * (spans()), counts (tone: ToneCheck counts), events (tone events with
 * atSec or atFrame, and phase), tone: {lockDb, minStableDb} (tone mode),
 * speech (analyzeSpeech(), mic mode), outages: [{phase, ms, cause, atSec?}]
 * (recoveries during the run and rendering pauses), recoveries: n, micPath
 * (micClock()), micZeroFraction (the frames in the microphone's zero runs of
 * 1 ms or more, ZeroRuns.zeroFrames, / all frames), late
 * (renderPauses().late), levelChanges ([{atSec, fromDb, toDb}]; taken from
 * the tone's "level" events when absent), refRuns (the microphone's zero
 * runs over the whole check, [{startFrame, frames, atSec?, phase?}]: every
 * run of GAP_MS or more, and every run of DROPOUT_MS up to GAP_MS once the
 * microphone's sources have settled. Tone mode needs them for the
 * microphone's silences and drop-outs; mic mode falls back to
 * speech.micPauses for its silences) }.
 * It fails on: any gap (a tone gap, every outage; counts.gaps counts too,
 * also a gap that has no event, such as one still going on when the check
 * ended); other sound mixed into the tone (its "noise" events or
 * counts.noises; the reason begins "Other sound was mixed into the test
 * tone"); a drop-out (tone), or an unexplained CABLE Output zero run of
 * DROPOUT_MS or more (mic); more than 6 clicks per 30 minutes on the tone's
 * road (tone mode) or on the microphone's road; more than 6 short drop-outs
 * per 30 minutes (mic mode); missing words (findGaps, mic mode); any
 * recovery; the microphone itself silent for GAP_MS or more, however long
 * (a capture Windows paused, or a muted headset: the same exact zeros; the
 * reason begins "Your microphone sent only digital silence"; without refRuns
 * or speech a line says it was not checked); the microphone itself silent
 * for DROPOUT_MS up to GAP_MS (its own drop-outs: the reason begins "The
 * microphone itself dropped out"; without refRuns a line says they were not
 * checked). The microphone's holes, drop-outs and silences count only when
 * it has no noise gate (noiseGateOf: NOISE_GATE_FRACTION or more of digital
 * silence that comes as a gate's does, in GATE_MIN_RUNS or more silences or
 * mostly in short ones; one or a few long silences are never a gate);
 * otherwise a line says so, and the microphone's road is gatedMicRoad's:
 * the drops its buffer's slope predicts when the slope shows a faster clock;
 * otherwise the holes seen, which a slower clock's hidden holes can only add
 * to: more than 6 per 30 minutes fail ("at least"), fewer leave the road
 * not measured (a line says so, and the checklist's clicks row is a note),
 * never a pass. A buffer that had already filled when the readings began
 * (micPath.fullAtStart) has no slope: its road is not measured unless holes
 * tell. micSilence says whether the microphone's own silences were judged
 * (checked: false with a noise gate or without a record of them);
 * gateSummary makes the gaps row a note then. With nothing failing, a tone
 * quieter than TONE_LEVEL_MIN_DB or a drop in volume of 3 dB or more needs a
 * setting changed ("fix-setting"). "no-signal": nothing on the cable was
 * measured, so tonePath is null and the lines say gaps were not checked. In
 * tone mode: the tone was never found. In mic mode: no speech analysis, a
 * voice on the microphone that never reached CABLE Output, or CABLE Output
 * that carried only digital silence (speech.cableSilent); and, when nothing
 * failed, less speech than MIN_SPEECH_SEC or MIN_SPEECH_SHARE of the check
 * (only the silence was checked, which is no pass). Late deliveries never
 * fail: a line reports them.
 * → { verdict: "pass" | "fix-setting" | "fail" | "no-signal", reasons, tonePath:
 * {ticksPer30Min, ppm, direction} | null, micPath, lines (at most 10),
 * micSilence: {checked, gate} }
 */
export function longVerdict(input) {
  const inp = input && typeof input === "object" ? input : {};
  const mode = inp.mode === "mic" ? "mic" : "tone";
  const durationSec = isNum(inp.durationSec) && inp.durationSec > 0 ? inp.durationSec : 0;
  const rate = (n) => (durationSec > 0 ? (n * 1800) / durationSec : 0);
  const events = list(inp.events);
  const counts = inp.counts && typeof inp.counts === "object" ? inp.counts : null;
  const tone = inp.tone && typeof inp.tone === "object" ? inp.tone : {};
  const speech = inp.speech && typeof inp.speech === "object" ? inp.speech : null;
  const micPath = inp.micPath && typeof inp.micPath === "object" ? inp.micPath : null;
  const outages = list(inp.outages);
  const recoveries = isNum(inp.recoveries) ? inp.recoveries : 0;
  // A noise gate by the pattern of the microphone's silences, not by their total: one long silence is not one.
  const noiseGate = noiseGateOf(
    inp.micZeroFraction,
    Array.isArray(inp.refRuns) ? inp.refRuns : speech?.micPauses,
    durationSec * FRAMES_PER_MS * 1000,
  );
  // Mic mode measured nothing on the cable when the voice heard on the microphone never arrived there, or when
  // CABLE Output carried only digital silence (a muted microphone, nothing sent, no speech).
  const voiceLost = mode === "mic" && (!speech || (!isNum(speech.lagMs) && (speech.speechSec ?? 0) > 0));
  const cableSilent = mode === "mic" && !voiceLost && speech.cableSilent === true;
  const noSignal = mode === "tone" ? !isNum(tone.lockDb) : voiceLost || cableSilent;
  const fails = [];
  const fixes = [];
  const lines = [];

  // The window's phases.
  const minutes = durationSec >= 90;
  const ph = inp.phases && typeof inp.phases === "object" ? inp.phases : null;
  const len = (sec) => lengthText(sec ?? 0, minutes);
  lines.push(
    ph
      ? `${len(durationSec)} recorded: ${len(ph.minimizedSec)} minimized, ${len(ph.hiddenSec)} hidden, ${len(ph.visibleSec)} open.`
      : `${len(durationSec)} recorded.`,
  );

  // Gaps: the tone's gap events and every outage (recoveries, rendering pauses). Nothing on the cable was
  // measured without a signal there.
  if (noSignal) {
    lines.push(
      mode === "tone"
        ? "Gaps and clicks: not checked, because the test tone never reached “CABLE Output”."
        : cableSilent
          ? "Gaps: not checked, because nothing reached “CABLE Output”."
          : "Gaps: not checked, because your voice never reached “CABLE Output”.",
    );
  } else {
    const gapEvents = events.filter((e) => e.kind === "gap");
    const gapCount = (mode === "tone" && counts && isNum(counts.gaps) ? Math.max(counts.gaps, gapEvents.length) : gapEvents.length) + outages.length;
    if (gapCount > 0) {
      const longest = [
        ...gapEvents.map((e) => ({ ms: e.holeMs ?? e.ms ?? 0, atSec: eventSec(e), phase: e.phase })),
        ...outages.map((o) => ({ ms: o.ms ?? 0, atSec: o.atSec, phase: o.phase })),
      ].reduce((a, b) => (b.ms > a.ms ? b : a), { ms: 0, atSec: null, phase: null });
      // A gap only counted (one still going on when the check ended has no event) has no known length.
      const where = whereText(longest.atSec, longest.phase);
      const known = longest.ms > 0;
      fails.push(`The sound stopped ${times(gapCount)}${known ? ` (the longest for ${lengthOfMs(longest.ms)}${where})` : ""}.`);
      lines.push(`Gaps: ${gapCount}${known ? ` (the longest ${lengthOfMs(longest.ms)}${where})` : ""}.`);
    } else {
      lines.push("Gaps: none.");
    }
  }
  if (recoveries > 0) fails.push(`The app had to bring your voice back ${times(recoveries)}.`);

  // The tone's road: Windows' default playback device → VB-CABLE.
  let tonePath = null;
  if (mode === "tone" && !noSignal) {
    // Other sound mixed into the tone: the cable carried more than the app's own sound.
    const noiseEvents = events.filter((e) => e.kind === "noise");
    const noise = Math.max(counts && isNum(counts.noises) ? counts.noises : 0, noiseEvents.length);
    if (noise > 0) {
      const longest = noiseEvents
        .map((e) => ({ ms: e.holeMs ?? e.ms ?? (isNum(e.frames) ? e.frames / FRAMES_PER_MS : 0), atSec: eventSec(e), phase: e.phase }))
        .reduce((a, b) => (b.ms > a.ms ? b : a), { ms: 0, atSec: null, phase: null });
      const detail = longest.ms > 0 ? ` (the longest for ${lengthOfMs(longest.ms)}${whereText(longest.atSec, longest.phase)})` : "";
      fails.push(
        `${OTHER_SOUND} ${times(noise)}${detail}. Nothing but this app may play into “CABLE Input”: in Zoom, Teams or Meet, the speaker must be your headset.`,
      );
      lines.push(`Other sound in the test tone: ${noise}${detail}.`);
    }
    const dropouts = counts && isNum(counts.dropouts) ? counts.dropouts : events.filter((e) => e.kind === "dropout").length;
    if (dropouts > 0) {
      const longest = events.filter((e) => e.kind === "dropout").reduce((m, e) => Math.max(m, e.holeMs ?? e.ms ?? 0), 0);
      fails.push(`The sound dropped out ${times(dropouts)} for 20 to 100 ms${longest > 0 ? ` (the longest ${Math.round(longest)} ms)` : ""}.`);
    }
    const fromEvents = clockFromEvents(events, durationSec);
    const ticks = counts ? (counts.holes ?? 0) + (counts.skips ?? 0) + (counts.clicks ?? 0) : null;
    const fromCounts = ticks !== null && durationSec > 0 ? rate(ticks) : null;
    const ticksPer30Min =
      fromEvents.ticksPer30Min === null && fromCounts === null ? null : Math.max(fromEvents.ticksPer30Min ?? 0, fromCounts ?? 0);
    tonePath = { ticksPer30Min, ppm: fromEvents.ppm, direction: fromEvents.direction };
    if (ticksPer30Min !== null && ticksPer30Min > LIMITS.TICKS_PER_30_MIN) {
      fails.push(`Too many clicks from the meeting's side: about ${per30(ticksPer30Min)} per 30 minutes (6 at most).`);
    }
    const n = ticks ?? events.filter((e) => e.kind === "hole" || e.kind === "skip" || e.kind === "click").length;
    const offset = isNum(fromEvents.ppm) ? Math.round(Math.abs(fromEvents.ppm)) : 0;
    const differ = offset > 0 ? `; Windows' default playback device and VB-CABLE differ by about ${offset} ppm` : "";
    lines.push(
      n > 0
        ? `Clicks from the meeting's side of the sound: ${n} (about ${per30(ticksPer30Min ?? 0)} per 30 minutes${differ}).`
        : "Clicks from the meeting's side of the sound: none.",
    );
  }

  // The microphone's road: microphone → VB-CABLE.
  const tooShort =
    micPath?.fullAtStart === true
      ? "The microphone's clock could not be measured: its buffer had already filled when the check began."
      : "The microphone's clock could not be measured (the check was too short).";
  const micClicks = (ticks, how) => {
    if (ticks > LIMITS.TICKS_PER_30_MIN) {
      fails.push(`Too many clicks from your microphone's side: about ${per30(ticks)} per 30 minutes (6 at most).`);
    }
    lines.push(`Clicks from your microphone's side: about ${per30(ticks)} per 30 minutes (${how}).`);
  };
  if (micPath && noiseGate) {
    // With a noise gate a slower clock's holes hide among the gate's silence: the holes seen still count, but only
    // as a lower bound, and the buffer's slope can only tell a faster clock.
    const road = gatedMicRoad(micPath);
    if (!road) {
      lines.push(tooShort);
    } else if (!road.atLeast) {
      const { slope } = road;
      micClicks(road.ticks, `its clock runs ${slope.lowerBound ? "at least " : ""}${Math.round(slope.ppm)} ppm faster than VB-CABLE's`);
    } else {
      const why = `${road.slope ? "its clock is not faster than VB-CABLE's" : "the check was too short to measure its clock"}; its noise gate hides the clicks a slower clock makes`;
      const n = per30(road.ticks);
      if (road.ticks > LIMITS.TICKS_PER_30_MIN) {
        fails.push(`Too many clicks from your microphone's side: at least ${n} per 30 minutes (6 at most).`);
        lines.push(`Clicks from your microphone's side: at least ${n} per 30 minutes (${why}, so there may be more).`);
      } else {
        lines.push(`Clicks from your microphone's side: not measured${road.holes > 0 ? `, at least ${n} per 30 minutes` : ""} (${why}).`);
      }
    }
  } else if (micPath) {
    const holesCount = isNum(micPath.holes) ? micPath.holes : 0;
    if (!(isNum(micPath.ppm) || holesCount > 0)) {
      lines.push(tooShort);
    } else {
      const ppm = isNum(micPath.ppm) ? Math.round(Math.abs(micPath.ppm)) : null;
      micClicks(
        micPath.ticksPer30Min ?? 0,
        micPath.direction === "faster" && ppm !== null
          ? `its clock runs ${micPath.ppmIsLowerBound === true ? "at least " : ""}${ppm} ppm faster than VB-CABLE's`
          : micPath.direction === "slower" && ppm !== null
            ? `its clock runs ${ppm} ppm slower than VB-CABLE's`
            : "its clock keeps time with VB-CABLE's",
      );
    }
  } else {
    lines.push("The microphone's clock was not measured on this output route.");
  }

  // The microphone itself: digital silence for GAP_MS or more while the app was capturing ("capture paused", or
  // a muted headset: the same exact zeros).
  const stops = noiseGate ? null : micStops(inp.refRuns, speech);
  const why = "it was muted, or Windows paused it.";
  if (stops && isNum(stops.count) && stops.count > 0) {
    const where = whereText(stops.atSec, stops.phase);
    fails.push(`${MIC_STOPPED} ${times(stops.count)} (the longest for ${lengthOfMs(stops.longestMs)}${where}): ${why}`);
  } else if (stops && isNum(stops.totalMs)) {
    fails.push(`${MIC_STOPPED} for ${lengthOfMs(stops.totalMs)} in all: ${why}`);
  } else if (!noiseGate && stops === null) {
    lines.push("Whether the microphone itself stopped was not checked (no record of its silences).");
  }
  const micSilence = { checked: stops !== null, gate: noiseGate };

  // The microphone itself: drop-outs of DROPOUT_MS up to GAP_MS. In tone mode the tone took its place on the
  // cable, but in normal use the voice carries each one to the meeting, as it carries a stop.
  const micDropouts = noiseGate ? null : micDrops(inp.refRuns);
  if (micDropouts && micDropouts.count > 0) {
    const l = micDropouts.longest;
    const where = whereText(isNum(l.atSec) ? l.atSec : l.startFrame / (FRAMES_PER_MS * 1000), l.phase);
    // Whole ms, rounded down: a run just under GAP_MS is "99 ms", never "100 ms".
    fails.push(`${MIC_DROPPED} ${times(micDropouts.count)} for 20 to 100 ms (the longest ${Math.floor(l.frames / FRAMES_PER_MS)} ms${where}).`);
  } else if (!noiseGate && micDropouts === null && stops !== null) {
    lines.push("Whether the microphone itself dropped out for 20 to 100 ms was not checked (no record of its short silences).");
  }

  // Mic mode: words, drop-outs.
  if (mode === "mic" && speech) {
    const gaps = list(speech.gaps);
    if (gaps.length) {
      const longest = gaps.reduce((m, g) => Math.max(m, g.holeMs ?? 0), 0);
      fails.push(`Words went missing ${times(gaps.length)} (the longest ${lengthOfMs(longest)}).`);
    }
    const drops = list(speech.dropouts).map((d) => ({ ...d, ms: isNum(d.ms) ? d.ms : (d.frames ?? 0) / FRAMES_PER_MS }));
    const long = drops.filter((d) => d.ms >= LIMITS.DROPOUT_MS);
    const short = drops.filter((d) => d.ms < LIMITS.DROPOUT_MS);
    if (long.length) {
      const longest = long.reduce((m, d) => Math.max(m, d.ms), 0);
      fails.push(`CABLE Output dropped out ${times(long.length)} (the longest for ${lengthOfMs(longest)}).`);
    }
    if (rate(short.length) > LIMITS.TICKS_PER_30_MIN) {
      fails.push(`Too many short drop-outs in CABLE Output: about ${per30(rate(short.length))} per 30 minutes (6 at most).`);
    }
    const heard = speech.speechSec ?? 0;
    lines.push(
      isNum(speech.lagMs)
        ? `Speech heard: ${lengthText(heard, heard >= 90)}; your voice reached CABLE Output about ${Math.round(speech.lagMs)} ms later.`
        : heard > 0
          ? `Speech heard: ${lengthText(heard, heard >= 90)}, but none of it in CABLE Output.`
          : cableSilent
            ? "No speech was heard on the microphone."
            : "No speech was heard, so only the silence was checked.",
    );
    lines.push(
      cableSilent
        ? "CABLE Output carried only digital silence."
        : drops.length
          ? `Drop-outs in CABLE Output: ${drops.length} (the longest ${lengthOfMs(drops.reduce((m, d) => Math.max(m, d.ms), 0))}).`
          : "Drop-outs in CABLE Output: none.",
    );
  }

  // The volume (tone mode): absolute, and drops while the check ran.
  if (mode === "tone" && isNum(tone.lockDb)) {
    const levelChanges = Array.isArray(inp.levelChanges)
      ? list(inp.levelChanges)
      : events.filter((e) => e.kind === "level").map((e) => ({ atSec: eventSec(e), fromDb: e.fromDb, toDb: e.toDb }));
    const minDb = isNum(tone.minStableDb) ? tone.minStableDb : tone.lockDb;
    if (minDb < LIMITS.TONE_LEVEL_MIN_DB) {
      fixes.push(
        `The meeting hears your voice ${(TONE_DB - minDb).toFixed(1)} dB quieter than it should: in Windows sound settings set Communications to “Do nothing”, set CABLE Input and CABLE Output to 100 %, and in Zoom untick “Automatically adjust microphone volume”. Then run the check again.`,
      );
    }
    for (const c of levelChanges) {
      if (!isNum(c.fromDb) || !isNum(c.toDb) || c.toDb - c.fromDb > LIMITS.LEVEL_WARN_DB) continue;
      const at = isNum(c.atSec) ? ` at ${formatClock(c.atSec)}` : "";
      fixes.push(
        `Windows turned the voice down by ${(c.fromDb - c.toDb).toFixed(1)} dB${at}, probably when the meeting started: in Windows sound settings set Communications to “Do nothing”. Then run the check again.`,
      );
    }
    lines.push(
      minDb < tone.lockDb - 0.5
        ? `Volume: ${dbText(tone.lockDb)} at the start, ${dbText(minDb)} at the lowest.`
        : `Volume: steady at ${dbText(tone.lockDb)}.`,
    );
  }

  if (noiseGate) {
    lines.push(
      "Your microphone sends digital silence in pauses (a noise gate?), so pauses and short drop-outs in the microphone itself could not be checked.",
    );
  }
  const late = inp.late && typeof inp.late === "object" ? inp.late : null;
  if (late && isNum(late.count) && late.count > 0) {
    lines.push(
      `The app's window was slow to update ${times(late.count)}, at most ${((late.maxMs ?? 0) / 1000).toFixed(1)} s; the sound was not affected.`,
    );
  }

  // A check with your voice that heard (almost) no speech checked only the silence: it never passes. What it
  // found still fails it (a capture pause, CABLE Output drop-outs, an outage); otherwise it measured nothing.
  const heardSec = speech && isNum(speech.speechSec) ? speech.speechSec : 0;
  const tooQuiet = mode === "mic" && !noSignal && heardSec < Math.max(LIMITS.MIN_SPEECH_SEC, LIMITS.MIN_SPEECH_SHARE * durationSec);

  let verdict;
  let reasons;
  if (noSignal) {
    verdict = "no-signal";
    reasons = [
      mode === "tone"
        ? "The test tone never reached “CABLE Output”."
        : cableSilent
          ? "Nothing reached “CABLE Output”: it carried only digital silence."
          : "Your voice never reached “CABLE Output”.",
    ];
  } else if (fails.length) {
    verdict = "fail";
    reasons = fails;
  } else if (tooQuiet) {
    verdict = "no-signal";
    reasons = [
      heardSec > 0
        ? `Too little speech was heard (${lengthText(heardSec, heardSec >= 90)} in ${lengthText(durationSec, durationSec >= 90)}), so the check could not tell whether words went missing: run it again and read aloud the whole time.`
        : "No speech was heard, so the check could not tell whether words went missing: run it again and read aloud the whole time.",
    ];
  } else if (fixes.length) {
    verdict = "fix-setting";
    reasons = fixes;
  } else {
    verdict = "pass";
    reasons = [];
  }
  return { verdict, reasons, tonePath, micPath, lines: lines.slice(0, 10), micSilence };
}

// ---------- Windows Audio restart ----------

/**
 * Windows Audio restart, from an OutputRecovery.log record (or a results
 * entry with serviceBackAfterMs). "pass" when the voice was back within
 * RESTART_MS; also a pass when Windows itself took longer but the app's own
 * part (its wait after the last failure, the rebuild and the first
 * heartbeat: appMs + waitMs) took at most RESTART_APP_MS after Windows Audio
 * was back; else "fail". → { verdict: "pass" | "fail", text }
 */
export function restartVerdict(record) {
  const r = record && typeof record === "object" ? record : {};
  const outageMs = isNum(r.outageMs) ? r.outageMs : null;
  if (outageMs === null) return { verdict: "fail", text: "fail (no recovery was recorded)" };
  if (outageMs <= LIMITS.RESTART_MS) return { verdict: "pass", text: "pass" };
  const serviceMs = isNum(r.serviceBackAfterMs)
    ? r.serviceBackAfterMs
    : isNum(r.serviceBackAtMs) && isNum(r.lostAtMs)
      ? r.serviceBackAtMs - r.lostAtMs
      : null;
  const app = isNum(r.appMs) ? r.appMs : null;
  const wait = isNum(r.waitMs) ? r.waitMs : null;
  if (serviceMs !== null && app !== null && wait !== null && app + wait <= LIMITS.RESTART_APP_MS) {
    return { verdict: "pass", text: `pass (Windows itself took about ${(serviceMs / 1000).toFixed(1)} s)` };
  }
  const back = `back after ${(outageMs / 1000).toFixed(1)} s`;
  if (serviceMs === null || app === null || wait === null) {
    return { verdict: "fail", text: `fail (${back}; the app could not tell when Windows Audio was running again)` };
  }
  return {
    verdict: "fail",
    text: `fail (${back}; the app's own part took ${Math.round(app + wait)} ms: ${Math.round(wait)} ms of waiting, then ${Math.round(app)} ms to rebuild)`,
  };
}

// ---------- the Gate 1 checklist ----------

const row = (name, status, text) => ({ row: name, status, text });

/** The last item of `items` that passes `test`. */
const lastOf = (items, test) => {
  for (let i = items.length - 1; i >= 0; i--) if (test(items[i])) return items[i];
  return null;
};

function securePageRow(results) {
  const secure = results.page?.secureContext;
  if (secure === true) return row("Secure page", "pass", "The app's page is a secure page.");
  if (secure === false) return row("Secure page", "fail", "The app's page is not a secure page, so the microphone can't work.");
  return row("Secure page", "todo", "Not checked yet.");
}

function microphoneRow(results) {
  const name = "Microphone: no prompt, processing off";
  const mic = results.voice?.mic ?? null;
  const start = results.voice?.start ?? null;
  const step1 = results.microphone ?? null;
  const settings = mic?.settings ?? null;
  const allOff = settings
    ? settings.allOff === true
    : step1
      ? step1.echoCancellation === false && step1.noiseSuppression === false && step1.autoGainControl === false
      : null;
  if (allOff === null) return row(name, "todo", "No microphone was opened yet: press “Check the microphone”.");
  if (!allOff) {
    return row(name, "fail", "Echo cancellation, noise suppression or auto gain is still on for the microphone.");
  }
  // Whether anything asked at the 1st and 3rd start is known only from the user's notes (and the log): the row
  // stays a note until then, never a pass. A slow open of this launch's first start hints at a prompt; a later
  // reopen (after a fault or a change) says nothing about one.
  const note =
    "Whether Windows or the app asked anything at the 1st and 3rd start: your notes (Session B step 4); the first start's timings are in the log file.";
  const first = (key) => (isNum(start?.[key]) ? start[key] : mic?.[key]);
  const slow = [first("unlockMs"), first("openedInMs")].filter((ms) => isNum(ms) && ms > 1500);
  if (slow.length) {
    const ms = Math.max(...slow);
    return row(name, "note", `Processing is off. The microphone took ${(ms / 1000).toFixed(1)} s to open at the start: was there a prompt? ${note}`);
  }
  return row(name, "note", `Processing is off. ${note}`);
}

const ROUTE_WORDS = {
  context: "the app's audio engine",
  element: "an audio element (fallback)",
  "context-after-permission": "the app's audio engine, after the permission fix",
  "element-after-permission": "an audio element (fallback), after the permission fix",
};

function cableRow(results) {
  const name = "Voice into CABLE Input";
  const voice = results.voice ?? {};
  if (voice.state === "sink-refused") return row(name, "fail", "The app could not send your voice into “CABLE Input”.");
  const method = voice.output?.method;
  if (!method) return row(name, "todo", "The voice is not going into CABLE Input yet.");
  const words = ROUTE_WORDS[method] ?? method;
  const changes = list(voice.output?.routeChanges);
  const extra = method === "context" ? "" : " It works, but this route may add delay or clicks.";
  if (changes.length) {
    return row(name, "note", `Sent through ${words}.${extra} The route changed ${times(changes.length)} during the session: to discuss.`);
  }
  return row(name, "pass", `Sent through ${words}.${extra}`);
}

/**
 * A check forced onto the audio element under Advanced (Session B step 7.6): a comparison, listed beside its row and
 * never counted. A check without routePreference (results made before it was recorded) counts as the normal route.
 */
const isComparison = (run) => run?.routePreference === "element";

/** The delay runs that measured clearly, on the normal route ("counted") and forced onto the audio element. */
function delayRuns(results) {
  const runs = list(results.checks?.delay).filter(
    (r) => isNum(r.estimateMs) && ["good", "borderline", "slow"].includes(r.verdict),
  );
  return { counted: runs.filter((r) => !isComparison(r)), element: runs.filter(isComparison) };
}

function delayRow(results) {
  const name = "Delay at most 120 ms";
  const { counted, element } = delayRuns(results);
  const elementText = element.length
    ? ` Through the audio element (not counted): ${element.map((r) => `${Math.round(r.estimateMs)} ms`).join(", ")}.`
    : "";
  if (!counted.length) return row(name, "todo", `Press “Measure the delay” in step 3 of this page (Session B step 6).${elementText}`);
  const top = counted.reduce((a, b) => (b.estimateMs > a.estimateMs ? b : a));
  const ms = Math.round(top.estimateMs);
  const fifo = isNum(top.micFifoMs) && top.micFifoMs >= LIMITS.MIC_FIFO_NOTE_MS
    ? ` ${Math.round(top.micFifoMs)} ms of it built up in the microphone's buffer.`
    : "";
  const of = counted.length === 1 ? "One measurement" : `The highest of ${counted.length} measurements`;
  const text = `${of}: about ${ms} ms (± 10).${fifo}${elementText}`;
  if (top.estimateMs <= LIMITS.DELAY_GOOD_MS) return row(name, "pass", text);
  if (top.estimateMs <= LIMITS.DELAY_MAX_MS) return row(name, "note", `${text} Close to the limit: I decide with the details.`);
  return row(name, "fail", `${text} Too slow.`);
}

/** The check failed because the microphone itself sent only digital silence (longVerdict's "capture paused" reason). */
const micStopped = (run) =>
  run.verdict === "fail" && Array.isArray(run.reasons) && run.reasons.some((t) => typeof t === "string" && t.startsWith(MIC_STOPPED));

/**
 * The check could not judge the microphone's own silences: it sends digital silence in pauses (a noise gate),
 * or no record of them was kept. Such a check cannot pass the gaps row, only make it a note.
 */
const micUnchecked = (run) => run.micSilence?.checked === false || run.micPath?.noiseGate === true;

/** The gaps row's note for the first of `runs` that could not judge the microphone's silences, with what it saw. */
function micUncheckedText(runs) {
  const run = runs.find(micUnchecked);
  if (!run) return "";
  const s = run.micSilence ?? {};
  if (s.checked === false && s.gate === false) return " Whether your microphone itself stopped was not checked (no record of its silences).";
  const top = list(s.longest)[0];
  const saw =
    isNum(s.count) && s.count > 0 && top && isNum(top.ms)
      ? `it sent only digital silence ${times(s.count)} (the longest for ${lengthOfMs(top.ms)}${whereText(top.atSec, top.phase)}): a noise gate, or a microphone that kept stopping`
      : "it sends digital silence in pauses (a noise gate?)";
  return ` Whether your microphone itself stopped could not be checked: ${saw}. I decide with the details.`;
}

/** The check failed because the microphone itself dropped out for 20 to 100 ms (longVerdict's reason). */
const micDropped = (run) =>
  run.verdict === "fail" && Array.isArray(run.reasons) && run.reasons.some((t) => typeof t === "string" && t.startsWith(MIC_DROPPED));

/** "the microphone itself dropped out twice for 20 to 100 ms", for the checks that failed on it. */
function droppedWords(runs) {
  const n = runs.reduce((a, r) => a + (isNum(r.micDropouts?.count) ? r.micDropouts.count : 0), 0);
  return `the microphone itself dropped out${n > 0 ? ` ${times(n)}` : ""} for 20 to 100 ms`;
}

/** A check that measured nothing: its signal never reached CABLE Output. It counts as no check at all. */
const measuredNothing = (run) => run.verdict === "no-signal";

/**
 * Why a long check ended early for a reason nobody chose (CABLE Output or the test tone lost, the voice
 * stopped, …): its endedEarly note; null when it ran to its end or was stopped.
 */
const earlyNote = (run) => {
  const e = run?.endedEarly;
  return e && typeof e === "object" && typeof e.note === "string" && e.note ? e.note : null;
};

/** "1 gap", "2 gaps"; "1 recovery", "3 recoveries". */
const count = (n, word, plural = `${word}s`) => `${n} ${n === 1 ? word : plural}`;

/** The outages, rendering pauses and recoveries of some checks, in words: ["1 outage", "2 recoveries"]. */
function stopWords(runs) {
  const sum = (f) => runs.reduce((a, r) => a + f(r), 0);
  const outages = sum((r) => list(r.outages).length);
  const pauses = sum((r) => list(r.renderPauses).length);
  const recoveries = sum((r) => (isNum(r.recoveries) ? r.recoveries : 0));
  const out = [];
  if (outages) out.push(count(outages, "outage"));
  if (pauses) out.push(count(pauses, "rendering pause"));
  if (recoveries) out.push(count(recoveries, "recovery", "recoveries"));
  return out;
}

/**
 * How often other sound was mixed into a tone check's test tone: its "noise"
 * count or events, else -1 when only its reasons say so, else 0.
 */
function otherSound(run) {
  const counted = run.tone?.counts?.noises;
  const n = Math.max(isNum(counted) ? counted : 0, list(run.tone?.events).filter((e) => e.kind === "noise").length);
  if (n > 0) return n;
  const said = Array.isArray(run.reasons) && run.reasons.some((t) => typeof t === "string" && t.startsWith(OTHER_SOUND));
  return said ? -1 : 0;
}

const NOTHING_MEASURED = " In the last one the test tone never reached “CABLE Output”, so it measured nothing.";

/** Minutes, rounded, of a number of seconds (0 for anything else). */
const minutesOf = (sec) => Math.round((isNum(sec) ? sec : 0) / 60);

/**
 * The long drop-outs (DROPOUT_MS or more) of a check with your voice: its
 * speech.longDropoutCount (every one), else those in its list of the first 50
 * (results made before the count was kept).
 */
function longDropouts(run) {
  const n = run.speech?.longDropoutCount;
  if (isNum(n)) return n;
  return list(run.speech?.dropouts).filter((d) => (d.ms ?? 0) >= LIMITS.DROPOUT_MS).length;
}

function gapsRow(results) {
  const name = "No gaps while minimized and hidden";
  const meet = " Meet call still open at the end: your note (Session B step 7.5).";
  const long = list(results.checks?.long);
  // Checks forced onto the audio element (Session B step 7.6) are comparisons: they never count here.
  const counted = long.filter((r) => !isComparison(r));
  const toneRuns = counted.filter((r) => r.mode === "tone");
  // A page in Edge cannot tell minimized from hidden (both are just "not visible"): an Edge run is judged on the
  // time it was not on screen, both phases together.
  const edge = results.shell === "browser";
  const away = (r) => (r.phases?.minimizedSec ?? 0) + (r.phases?.hiddenSec ?? 0);
  const enough = (r) =>
    edge
      ? away(r) >= 2 * LIMITS.MIN_PHASE_SEC
      : (r.phases?.minimizedSec ?? 0) >= LIMITS.MIN_PHASE_SEC && (r.phases?.hiddenSec ?? 0) >= LIMITS.MIN_PHASE_SEC;
  const run = lastOf(toneRuns, (r) => !measuredNothing(r) && enough(r));
  if (!run) {
    const latest = toneRuns[toneRuns.length - 1];
    const sofar = !latest
      ? ""
      : measuredNothing(latest)
        ? NOTHING_MEASURED
        : edge
          ? ` The last one was ${minutesOf(away(latest))} min not on screen.`
          : ` The last one had ${minutesOf(latest.phases?.minimizedSec)} min minimized and ${minutesOf(latest.phases?.hiddenSec)} min hidden.`;
    const why = latest && !measuredNothing(latest) && earlyNote(latest) ? ` ${earlyNote(latest)}` : "";
    const need = edge
      ? "Run the long check with the Edge window minimized (Session B step 7): it needs 50 min not on screen (Edge can't tell minimized from hidden)."
      : "Run the long check (Session B step 7): it needs 25 min minimized and 25 min hidden.";
    return row(name, "todo", `${need}${sofar}${why}${meet}`);
  }
  // A check that ended early for a reason nobody chose did not cover what it was asked to, whatever the part
  // it recorded says (its own verdict fails): so does this row, with that reason first.
  const early = earlyNote(run);
  const stopped = "your microphone sent only digital silence (muted, or paused by Windows)";
  const problems = [];
  const gaps = run.tone?.counts?.gaps ?? 0;
  const dropouts = run.tone?.counts?.dropouts ?? 0;
  const noise = otherSound(run);
  if (gaps) problems.push(count(gaps, "gap"));
  if (dropouts) problems.push(count(dropouts, "drop-out"));
  problems.push(...stopWords([run]));
  if (noise) problems.push(`other sound mixed into the test tone${noise > 0 ? ` ${times(noise)}` : ""}`);
  // The tone replaced the microphone on the cable, but a microphone that stopped or dropped out while hidden is a
  // gap or a drop-out in the voice.
  if (micStopped(run)) problems.push(stopped);
  if (micDropped(run)) problems.push(droppedWords([run]));
  // The checks with your voice fail this row on the same problems. One that measured nothing counts for nothing.
  const voiceRuns = counted.filter((r) => r.mode === "mic" && !measuredNothing(r));
  const sum = (f) => voiceRuns.reduce((a, r) => a + f(r), 0);
  const words = sum((m) => list(m.speech?.gaps).length);
  const drops = sum(longDropouts);
  const voice = [];
  if (words) voice.push(`missing words ${times(words)}`);
  if (drops) voice.push(count(drops, "drop-out"));
  voice.push(...stopWords(voiceRuns));
  if (voiceRuns.some(micStopped)) voice.push(stopped);
  if (voiceRuns.some(micDropped)) voice.push(droppedWords(voiceRuns.filter(micDropped)));
  if (voiceRuns.some(earlyNote)) voice.push("it ended early");
  const phases = edge
    ? `${minutesOf(away(run))} min not on screen (Edge can't tell minimized from hidden)`
    : `${minutesOf(run.phases.minimizedSec)} min minimized and ${minutesOf(run.phases.hiddenSec)} min hidden`;
  if (early || problems.length || voice.length) {
    const tonePart = problems.length ? `In ${phases}: ${problems.join(", ")}.` : `No gaps in ${phases}.`;
    const voicePart = voice.length ? ` In the check${voiceRuns.length > 1 ? "s" : ""} with your voice: ${voice.join(", ")}.` : "";
    return row(name, "fail", `${early ? `${early} ` : ""}${tonePart}${voicePart}${meet}`);
  }
  // A microphone whose own silences could not be judged (a noise gate) never passes this row silently: whether
  // it stopped while hidden is unknown, so I decide with the details.
  const unchecked = micUncheckedText([run, ...voiceRuns]);
  // Settings checks that belong to this row (they ask for "Do nothing" and a re-run, and fail nothing by
  // themselves): the tone's level, and the voice's level in CABLE Output in a delay run on the normal route.
  const quiet = delayRuns(results)
    .counted.filter((r) => isNum(r.levelDiffDb) && r.levelDiffDb < LIMITS.CABLE_QUIET_DB)
    .reduce((a, b) => (a && a.levelDiffDb <= b.levelDiffDb ? a : b), null);
  if (run.verdict === "fix-setting" || quiet) {
    const notes = run.verdict === "fix-setting" && Array.isArray(run.reasons) ? run.reasons.filter((x) => typeof x === "string") : [];
    if (quiet) {
      notes.push(`In “Measure the delay” the voice arrived ${(-quiet.levelDiffDb).toFixed(1)} dB quieter in CABLE Output: ${QUIET_ADVICE}`);
    }
    return row(name, "note", `No gaps in ${phases}, but a setting needs changing.${notes.length ? ` ${notes.join(" ")}` : ""}${unchecked}${meet}`);
  }
  if (unchecked) return row(name, "note", `No gaps in ${phases}.${unchecked}${meet}`);
  return row(name, "pass", `No gaps in ${phases}.${meet}`);
}

function ticksRow(results) {
  const name = "No regular clicks";
  const longEnough = list(results.checks?.long).filter((r) => r.mode === "tone" && (r.recordedSec ?? 0) >= 30 * 60);
  const counted = longEnough.filter((r) => !isComparison(r));
  // Session B step 7.6's checks through the audio element: their meeting's side is listed beside the row.
  const compared = longEnough.filter((r) => isComparison(r) && !measuredNothing(r));
  const perRun = (r) => (isNum(r.tonePath?.ticksPer30Min) ? `about ${per30(r.tonePath.ticksPer30Min)} per 30 min` : "not measured");
  const comparedText = compared.length ? ` Through the audio element (not counted): ${compared.map(perRun).join(", ")}.` : "";
  const run = lastOf(counted, (r) => !measuredNothing(r));
  if (!run) {
    const latest = counted[counted.length - 1];
    const extra = latest && measuredNothing(latest) ? NOTHING_MEASURED : "";
    return row(name, "todo", `Needs a long check with the test tone of at least 30 minutes (Session B step 7).${extra}${comparedText}`);
  }
  const tone = run.tonePath?.ticksPer30Min;
  const mp = run.micPath ?? null;
  let mic = null;
  let atLeast = false; // a noise gate hides a slower clock's clicks: mic is only a lower bound
  if (mp && mp.noiseGate === true) {
    // As in the check's own verdict: the holes seen count, but only as a lower bound unless the buffer's slope
    // shows a faster clock.
    const road = gatedMicRoad(mp);
    mic = road ? road.ticks : null;
    atLeast = road !== null && road.atLeast;
  } else if (mp && (isNum(mp.ppm) || (mp.holes ?? 0) > 0)) {
    mic = isNum(mp.ticksPer30Min) ? mp.ticksPer30Min : null;
  }
  const tooMany = (x) => isNum(x) && x > LIMITS.TICKS_PER_30_MIN;
  const toneText = isNum(tone) ? `about ${per30(tone)} per 30 min` : "not measured";
  const micText = !isNum(mic)
    ? "not measured"
    : !atLeast
      ? `about ${per30(mic)} per 30 min`
      : tooMany(mic)
        ? `at least ${per30(mic)} per 30 min`
        : `not measured${mic > 0 ? `, at least ${per30(mic)} per 30 min` : ""}`;
  const gate = atLeast && !tooMany(mic) ? " Your microphone's noise gate hides the clicks a slower clock makes: I decide with the details." : "";
  const sibling = results.voice?.devices?.defaultOutputIsMicSibling === true
    ? " Windows' default playback device is your headset's own earpiece."
    : "";
  // A check that ended early still counts: it recorded 30 minutes or more, and the rate comes from what it recorded.
  const early = earlyNote(run) ? ` That check ended early: these come from its first ${minutesOf(run.recordedSec)} min.` : "";
  const text = `The meeting's side: ${toneText}; your microphone's side: ${micText} (6 at most each).${gate}${sibling}${early}${comparedText}`;
  if (tooMany(tone) || tooMany(mic)) {
    return row(name, "fail", compared.length ? text : `${text} Run the comparison through the audio element (Session B step 7.6).`);
  }
  if (!isNum(tone) || !isNum(mic) || atLeast) return row(name, "note", text);
  return row(name, "pass", text);
}

function restartRow(results) {
  const name = "Windows Audio restart: back within 2 s";
  const rec = lastOf(list(results.voice?.recoveries), (r) => r.micToo === true);
  if (!rec) return row(name, "todo", "Restart Windows Audio (Session B step 9), then wait for a new line under Recoveries in step 2 of this page.");
  const v = rec.restart && typeof rec.restart === "object" && rec.restart.verdict ? rec.restart : restartVerdict(rec);
  const back = isNum(rec.outageMs) ? `Back after ${(rec.outageMs / 1000).toFixed(1)} s: ` : "";
  return row(name, v.verdict === "pass" ? "pass" : "fail", `${back}${v.text}.`);
}

function connectRow(results) {
  const ok = results.sanas?.ok;
  if (ok === true) return row("Connect only", "pass", "Sanas accepted the key and this app's address.");
  if (ok === false) return row("Connect only", "fail", "Sanas did not accept the connection: see step 5 of this page.");
  return row("Connect only", "todo", "Press “Connect only” in step 5 of this page (Session B step 10).");
}

/**
 * The Gate 1 checklist from the collected results (schema 2), in order:
 * secure page; the microphone with its processing off (a note, never a
 * pass: whether anything asked at the 1st and 3rd start is the user's note;
 * a first open of the launch (voice.start) that took more than 1.5 s hints
 * at a prompt); the voice into CABLE Input (the route method and its
 * changes; "sink-refused" fails); Zoom's Test Mic (the user's note); the
 * delay (the highest estimate of the runs on the normal route; runs forced
 * onto the audio element are listed, not counted); no gaps while minimized
 * and hidden (the latest tone check on the normal route with 25 min of
 * each, or in Edge, which cannot tell them apart, 50 min not on screen;
 * plus the user's note that the Meet call stayed open; the tone check's
 * gaps, drop-outs, outages, rendering pauses, recoveries and other sound in
 * the tone fail it, and so do the checks with your voice on the normal
 * route: missing words, every long drop-out, outages, rendering pauses and
 * recoveries; a microphone that sent only digital silence, or dropped out
 * by itself for 20 to 100 ms, fails it too (in a tone check as well: the
 * voice would carry it); a check that ended early for a reason nobody
 * chose (its endedEarly, as its own verdict does; a stop is not one: it is
 * judged on what it recorded) fails it with that reason first; with
 * nothing failing, the tone check's "fix-setting", a delay run on the
 * normal route whose voice arrived more than 3 dB quieter in CABLE Output,
 * and a check that could not judge the microphone's own silences
 * (micSilence.checked false, or a noise gate) make it a note); no regular
 * clicks (the latest tone check of 30 minutes or more on the normal route,
 * each road at most 6 per 30 minutes; with a noise gate the microphone's
 * road is gatedMicRoad's, as in the check's own verdict: unless its
 * buffer's slope shows a faster clock it is a lower bound, which fails
 * above 6 and is a note otherwise, never a pass; a check that ended early
 * still counts, and the row says so; tone checks forced onto the audio
 * element, Session B step 7.6, are listed with their meeting's side, not
 * counted); the Windows Audio restart (the latest recovery that involved
 * both the microphone and the context); Connect only. A long check whose
 * verdict is "no-signal" measured nothing and counts for no row. Step
 * numbers in the texts are Session B's (README); the page's own steps are
 * named as "step N of this page".
 * → [{ row, status: "pass" | "fail" | "todo" | "note", text }]
 */
export function gateSummary(results) {
  const r = results && typeof results === "object" ? results : {};
  return [
    securePageRow(r),
    microphoneRow(r),
    cableRow(r),
    row("Zoom's Test Mic hears you", "todo", "Your note from Session B step 5: did Zoom's Test Mic play your voice back?"),
    delayRow(r),
    gapsRow(r),
    ticksRow(r),
    restartRow(r),
    connectRow(r),
  ];
}
