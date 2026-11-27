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

/** A level in dB with a real minus sign: "−12.0 dB". */
const dbText = (v) => `${v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)} dB`;

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
    notes.push(
      `The voice arrives ${(-r.levelDiffDb).toFixed(1)} dB quieter in CABLE Output: check that CABLE Input and CABLE Output are at 100 % in Windows sound settings, and that Communications is set to “Do nothing”.`,
    );
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
 * many does.
 *  1. base = the median of the first 3 lags; saturatedAtSec = the time of the
 *     first reading 40 ms or more above it (the buffer is full and drops
 *     10 ms at a time from then on), or null.
 *  2. ppm = the Theil–Sen slope of the readings before saturation (ms/s ×
 *     1000) when they span 600 s or more and number 4 or more; else, once
 *     saturated, 40 ms over the time it took to get there, as a lower bound;
 *     else null.
 *  3. direction: ppm above 3 → "faster" (the buffer fills, then drops 10 ms
 *     per 10 ms of drift); else holes → "slower" (it inserts 10 ms of zeros
 *     per 10 ms of drift and its fill only saw-tooths, so the holes are the
 *     evidence: ppm = −holes × 10 ms / durationSec); else "same" when ppm is
 *     known; else null.
 *  4. dropsPer30Min = max(0, ppm) × 0.18; holesPer30Min = holes × 1800 /
 *     durationSec; ticksPer30Min = their sum.
 * → { ppm, ppmIsLowerBound, direction, saturatedAtSec, holes, holesPer30Min,
 * dropsPer30Min, ticksPer30Min, readings (the run used: [{atSec, lagMs}]) }
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
  if (readings.length) {
    const base = median(readings.slice(0, 3).map((s) => s.lagMs));
    const saturated = readings.find((s) => s.lagMs - base >= 40);
    saturatedAtSec = saturated ? saturated.atSec : null;
    const before = saturated ? readings.filter((s) => s.atSec < saturated.atSec) : readings;
    const spanSec = before.length ? before[before.length - 1].atSec - before[0].atSec : 0;
    if (before.length >= 4 && spanSec >= 600) {
      ppm = theilSen(before) * 1000;
    } else if (saturated) {
      // 40 ms gathered in at most this long (from the first reading of this run, else from the start).
      const tookSec = saturated.atSec - readings[0].atSec > 0 ? saturated.atSec - readings[0].atSec : saturated.atSec;
      if (tookSec > 0) {
        ppm = (40 / tookSec) * 1000;
        ppmIsLowerBound = true;
      }
    }
  }
  const holeCount = isNum(holes) && holes > 0 ? holes : 0;
  const duration = isNum(durationSec) && durationSec > 0 ? durationSec : null;
  let direction = null;
  if (ppm !== null && ppm > 3) {
    direction = "faster";
  } else if (holeCount > 0) {
    direction = "slower";
    ppm = duration ? -((holeCount * 0.01) / duration) * 1e6 : null;
    ppmIsLowerBound = false;
  } else if (ppm !== null) {
    direction = "same";
  }
  const dropsPer30Min = Math.max(0, ppm ?? 0) * 0.18;
  const holesPer30Min = duration ? (holeCount * 1800) / duration : 0;
  return {
    ppm,
    ppmIsLowerBound,
    direction,
    saturatedAtSec,
    holes: holeCount,
    holesPer30Min,
    dropsPer30Min,
    ticksPer30Min: dropsPer30Min + holesPer30Min,
    readings,
  };
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
 * summary (its own clock stamp on the page's timeline); wallMs is when the
 * message arrived. offset = producedMs − frame / 48 moves only when frames
 * stop while time goes on (the context did not render), never because the
 * main thread was late. A pause at point i: the offset steps up by more than
 * PAUSE_STEP_MS from point i − 1, and the median offset of points i …
 * i + PAUSE_CONFIRM − 1 is above the median of the PAUSE_CONFIRM points before
 * i by more than PAUSE_STEP_MS (a real pause shifts every later point; one odd
 * stamp does not). Slow drift between the audio clock and the system clock
 * never forms a step. Main-thread lateness (wallMs − producedMs) above
 * PAUSE_STEP_MS is a late delivery, never a pause.
 * → { pauses: [{index, atFrame, producedMs, ms}] (index, frame and time of
 * point i), late: {count, maxMs} }
 */
export function renderPauses(syncPoints) {
  const pts = syncTimes(syncPoints);
  const offsets = pts.map((p) => p.t - p.frame / FRAMES_PER_MS);
  const C = LIMITS.PAUSE_CONFIRM;
  const STEP = LIMITS.PAUSE_STEP_MS;
  const pauses = [];
  for (let i = 1; i < pts.length; i++) {
    const step = offsets[i] - offsets[i - 1];
    if (!(step > STEP)) continue;
    const after = median(offsets.slice(i, i + C));
    const before = median(offsets.slice(Math.max(0, i - C), i));
    if (after - before > STEP) pauses.push({ index: pts[i].index, atFrame: pts[i].frame, producedMs: pts[i].t, ms: step });
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
 * maxEndSec (plannedEndSec + EXTEND_MAX_SEC by default). → seconds since the
 * check started.
 */
export function stopAfterHide({ plannedEndSec, hideEndSec, tailSec = LIMITS.HIDE_TAIL_SEC, maxEndSec }) {
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
 * (short microphone zero runs: n), micSilentSec }
 */
export function analyzeSpeech({ refDb, sigDb, hopMs = 5, refRuns = [], sigRuns = [], sampleRate = 48000 } = {}) {
  const runs = classifyZeroRuns(refRuns, sigRuns, { sampleRate });
  const msOf = (frames) => (frames / sampleRate) * 1000;
  const dropouts = runs.dropouts.map((r) => ({ startFrame: r.startFrame, frames: r.frames, ms: round(msOf(r.frames), 2) }));
  const micSilentSec = runs.micSilent.reduce((s, r) => s + r.frames, 0) / sampleRate;
  const ref = refDb && typeof refDb.length === "number" ? refDb : new Float32Array(0);
  const sig = sigDb && typeof sigDb.length === "number" ? sigDb : new Float32Array(0);
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
  return { lagMs, lagScore, gaps, speechSec, dropouts, micHoles: runs.micHoles.length, micSilentSec };
}

/** An event's time in seconds: atSec, else atFrame at 48 kHz; null without either. */
const eventSec = (e) => (isNum(e.atSec) ? e.atSec : isNum(e.atFrame) ? e.atFrame / 48000 : null);

/**
 * The clock offset of the tone road from the tone's events. A clock
 * crossing gives one event of one kind per 10 ms of drift (skips: the
 * tone's clock is faster than CABLE's; holes: slower). With 3 or more events
 * of one kind: ppm = 10 ms / the median interval (+ for skips, − for holes)
 * and ticksPer30Min = 1800 s / the median interval; else ticksPer30Min =
 * ticks × 1800 / durationSec and ppm = ticks × 10 ms / durationSec (a bound
 * when there are none). → { ppm, direction: "faster" | "slower" | null, ticksPer30Min }
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
  const regular = skips.length >= 3 && skips.length >= holes.length ? { at: skips, sign: 1 } : holes.length >= 3 ? { at: holes, sign: -1 } : null;
  if (regular) {
    const gaps = [];
    for (let i = 1; i < regular.at.length; i++) if (regular.at[i] > regular.at[i - 1]) gaps.push(regular.at[i] - regular.at[i - 1]);
    const every = median(gaps);
    if (isNum(every) && every > 0) {
      return {
        ppm: (regular.sign * 0.01 * 1e6) / every,
        direction: regular.sign > 0 ? "faster" : "slower",
        ticksPer30Min: 1800 / every,
      };
    }
  }
  const skipCount = evs.filter((e) => e.kind === "skip").length;
  const holeCount = evs.filter((e) => e.kind === "hole").length;
  const ticks = skipCount + holeCount + evs.filter((e) => e.kind === "click").length;
  if (!isNum(durationSec) || !(durationSec > 0)) return { ppm: null, direction: null, ticksPer30Min: null };
  const direction = skipCount > holeCount ? "faster" : holeCount > skipCount ? "slower" : null;
  const ppm = ((ticks * 0.01) / durationSec) * 1e6;
  return { ppm: direction === "slower" ? -ppm : ppm, direction, ticksPer30Min: (ticks * 1800) / durationSec };
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
 * Long-check verdict. input: { mode: "tone" | "mic", durationSec, phases
 * (spans()), counts (tone: ToneCheck counts), events (tone events with
 * atSec or atFrame, and phase), tone: {lockDb, minStableDb} (tone mode),
 * speech (analyzeSpeech(), mic mode), outages: [{phase, ms, cause, atSec?}]
 * (recoveries during the run and rendering pauses), recoveries: n, micPath
 * (micClock()), micZeroFraction (the microphone's digital silence / all
 * frames), late (renderPauses().late), levelChanges ([{atSec, fromDb, toDb}];
 * taken from the tone's "level" events when absent), refRuns (the
 * microphone's zero runs; optional) }.
 * It fails on: any gap (a tone gap, every outage); a drop-out (tone), or an
 * unexplained CABLE Output zero run of DROPOUT_MS or more (mic); more than
 * 6 clicks per 30 minutes on the tone's road (tone mode) or on the
 * microphone's road; more than 6 short drop-outs per 30 minutes (mic mode);
 * missing words (findGaps, mic mode); any recovery; the microphone itself
 * silent for GAP_MS or more ("capture paused"). The microphone's holes and
 * "capture paused" count only when it has no noise gate (micZeroFraction <
 * NOISE_GATE_FRACTION); otherwise a line says so and the microphone's road
 * uses only its slope. With nothing failing, a tone quieter than
 * TONE_LEVEL_MIN_DB or a drop in volume of 3 dB or more needs a setting
 * changed ("fix-setting"). No tone found, or no voice in CABLE Output, is
 * "no-signal". Late deliveries never fail: a line reports them.
 * → { verdict: "pass" | "fix-setting" | "fail" | "no-signal", reasons, tonePath:
 * {ticksPer30Min, ppm, direction} | null, micPath, lines (at most 10) }
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
  const noiseGate = isNum(inp.micZeroFraction) && inp.micZeroFraction >= LIMITS.NOISE_GATE_FRACTION;
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

  // Gaps: the tone's gap events and every outage (recoveries, rendering pauses).
  const gapEvents = events.filter((e) => e.kind === "gap");
  const gapCount = (mode === "tone" && counts && isNum(counts.gaps) ? Math.max(counts.gaps, gapEvents.length) : gapEvents.length) + outages.length;
  if (gapCount > 0) {
    const longest = [
      ...gapEvents.map((e) => ({ ms: e.holeMs ?? e.ms ?? 0, atSec: eventSec(e), phase: e.phase })),
      ...outages.map((o) => ({ ms: o.ms ?? 0, atSec: o.atSec, phase: o.phase })),
    ].reduce((a, b) => (b.ms > a.ms ? b : a), { ms: 0, atSec: null, phase: null });
    const where = whereText(longest.atSec, longest.phase);
    fails.push(`The sound stopped ${times(gapCount)} (the longest for ${Math.round(longest.ms)} ms${where}).`);
    lines.push(`Gaps: ${gapCount} (the longest ${Math.round(longest.ms)} ms${where}).`);
  } else {
    lines.push("Gaps: none.");
  }
  if (recoveries > 0) fails.push(`The app had to bring your voice back ${times(recoveries)}.`);

  // The tone's road: Windows' default playback device → VB-CABLE.
  let tonePath = null;
  if (mode === "tone") {
    const dropouts = counts && isNum(counts.dropouts) ? counts.dropouts : events.filter((e) => e.kind === "dropout").length;
    if (dropouts > 0) {
      const longest = Math.max(0, ...events.filter((e) => e.kind === "dropout").map((e) => e.holeMs ?? e.ms ?? 0));
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
  if (micPath) {
    // A "slower" direction comes from the holes: with a noise gate the holes say nothing, so only a slope counts.
    const slope = isNum(micPath.ppm) && micPath.direction !== "slower";
    const holesCount = isNum(micPath.holes) ? micPath.holes : 0;
    const measured = noiseGate ? slope : isNum(micPath.ppm) || holesCount > 0;
    if (!measured) {
      lines.push("The microphone's clock could not be measured (the check was too short).");
    } else {
      const ticks = noiseGate ? micPath.dropsPer30Min ?? 0 : micPath.ticksPer30Min ?? 0;
      if (ticks > LIMITS.TICKS_PER_30_MIN) {
        fails.push(`Too many clicks from your microphone's side: about ${per30(ticks)} per 30 minutes (6 at most).`);
      }
      const ppm = isNum(micPath.ppm) ? Math.round(Math.abs(micPath.ppm)) : null;
      const how =
        micPath.direction === "faster" && ppm !== null
          ? `its clock runs ${ppm} ppm faster than VB-CABLE's`
          : micPath.direction === "slower" && ppm !== null
            ? `its clock runs ${ppm} ppm slower than VB-CABLE's`
            : "its clock keeps time with VB-CABLE's";
      lines.push(`Clicks from your microphone's side: about ${per30(ticks)} per 30 minutes (${how}).`);
    }
  } else {
    lines.push("The microphone's clock was not measured on this output route.");
  }

  // The microphone itself: silent for GAP_MS or more while the app was capturing.
  const refRuns = runList(inp.refRuns);
  if (!noiseGate) {
    const paused = refRuns.filter((r) => r.frames >= (LIMITS.GAP_MS * 48000) / 1000);
    if (paused.length) {
      const longest = Math.max(...paused.map((r) => r.frames)) / 48;
      fails.push(`The microphone itself stopped ${times(paused.length)} (the longest for ${Math.round(longest)} ms): Windows paused it.`);
    }
  }

  // Mic mode: words, drop-outs.
  if (mode === "mic" && speech) {
    const gaps = list(speech.gaps);
    if (gaps.length) {
      const longest = Math.max(...gaps.map((g) => g.holeMs ?? 0));
      fails.push(`Words went missing ${times(gaps.length)} (the longest ${Math.round(longest)} ms).`);
    }
    const drops = list(speech.dropouts).map((d) => ({ ...d, ms: isNum(d.ms) ? d.ms : (d.frames ?? 0) / 48 }));
    const long = drops.filter((d) => d.ms >= LIMITS.DROPOUT_MS);
    const short = drops.filter((d) => d.ms < LIMITS.DROPOUT_MS);
    if (long.length) {
      const longest = Math.max(...long.map((d) => d.ms));
      fails.push(`CABLE Output dropped out ${times(long.length)} (the longest for ${Math.round(longest)} ms).`);
    }
    if (rate(short.length) > LIMITS.TICKS_PER_30_MIN) {
      fails.push(`Too many short drop-outs in CABLE Output: about ${per30(rate(short.length))} per 30 minutes (6 at most).`);
    }
    lines.push(
      isNum(speech.lagMs)
        ? `Speech heard: ${lengthText(speech.speechSec ?? 0, (speech.speechSec ?? 0) >= 90)}; your voice reached CABLE Output about ${Math.round(speech.lagMs)} ms later.`
        : "No speech was heard, so only the silence was checked.",
    );
    lines.push(drops.length ? `Drop-outs in CABLE Output: ${drops.length} (the longest ${Math.round(Math.max(...drops.map((d) => d.ms)))} ms).` : "Drop-outs in CABLE Output: none.");
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

  const noSignal =
    mode === "tone"
      ? !isNum(tone.lockDb)
      : !speech || (!isNum(speech.lagMs) && (speech.speechSec ?? 0) > 0);
  let verdict;
  let reasons;
  if (noSignal) {
    verdict = "no-signal";
    reasons = [mode === "tone" ? "The test tone never reached “CABLE Output”." : "Your voice never reached “CABLE Output”."];
  } else if (fails.length) {
    verdict = "fail";
    reasons = fails;
  } else if (fixes.length) {
    verdict = "fix-setting";
    reasons = fixes;
  } else {
    verdict = "pass";
    reasons = [];
  }
  return { verdict, reasons, tonePath, micPath, lines: lines.slice(0, 10) };
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
  const note = "Your notes from step 4 say whether Windows or the app asked anything on the 1st and 3rd start.";
  const slow = [mic?.unlockMs, mic?.openedInMs].filter((ms) => isNum(ms) && ms > 1500);
  if (slow.length) {
    const ms = Math.max(...slow);
    return row(name, "note", `Processing is off. The microphone took ${(ms / 1000).toFixed(1)} s to open: was there a prompt? ${note}`);
  }
  return row(name, "pass", `Processing is off. ${note}`);
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

function delayRow(results) {
  const name = "Delay at most 120 ms";
  const runs = list(results.checks?.delay).filter(
    (r) => isNum(r.estimateMs) && ["good", "borderline", "slow"].includes(r.verdict),
  );
  const counted = runs.filter((r) => r.routePreference !== "element");
  const element = runs.filter((r) => r.routePreference === "element");
  const elementText = element.length
    ? ` Through the audio element (not counted): ${element.map((r) => `${Math.round(r.estimateMs)} ms`).join(", ")}.`
    : "";
  if (!counted.length) return row(name, "todo", `Press “Measure the delay” (step 6).${elementText}`);
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

function gapsRow(results) {
  const name = "No gaps while minimized and hidden";
  const meet = " Meet call still open at the end: your note (step 7.5).";
  const long = list(results.checks?.long);
  const toneRuns = long.filter((r) => r.mode === "tone");
  const enough = (r) => (r.phases?.minimizedSec ?? 0) >= LIMITS.MIN_PHASE_SEC && (r.phases?.hiddenSec ?? 0) >= LIMITS.MIN_PHASE_SEC;
  const run = lastOf(toneRuns, enough);
  if (!run) {
    const latest = toneRuns[toneRuns.length - 1];
    const sofar = latest
      ? ` The last one had ${Math.round((latest.phases?.minimizedSec ?? 0) / 60)} min minimized and ${Math.round((latest.phases?.hiddenSec ?? 0) / 60)} min hidden.`
      : "";
    return row(name, "todo", `Run the long check (step 7): it needs 25 min minimized and 25 min hidden.${sofar}${meet}`);
  }
  const problems = [];
  const gaps = run.tone?.counts?.gaps ?? 0;
  const dropouts = run.tone?.counts?.dropouts ?? 0;
  const outages = list(run.outages).length;
  const pauses = list(run.renderPauses).length;
  const recoveries = isNum(run.recoveries) ? run.recoveries : 0;
  if (gaps) problems.push(`${gaps} gap${gaps === 1 ? "" : "s"}`);
  if (dropouts) problems.push(`${dropouts} drop-out${dropouts === 1 ? "" : "s"}`);
  if (outages) problems.push(`${outages} outage${outages === 1 ? "" : "s"}`);
  if (pauses) problems.push(`${pauses} rendering pause${pauses === 1 ? "" : "s"}`);
  if (recoveries) problems.push(`${recoveries} recover${recoveries === 1 ? "y" : "ies"}`);
  for (const m of long.filter((r) => r.mode === "mic")) {
    const words = list(m.speech?.gaps).length;
    const drops = list(m.speech?.dropouts).filter((d) => (d.ms ?? 0) >= LIMITS.DROPOUT_MS).length;
    if (words) problems.push(`missing words ${times(words)} in the check with your voice`);
    if (drops) problems.push(`${drops} drop-out${drops === 1 ? "" : "s"} in the check with your voice`);
  }
  const phases = `${Math.round(run.phases.minimizedSec / 60)} min minimized and ${Math.round(run.phases.hiddenSec / 60)} min hidden`;
  if (problems.length) return row(name, "fail", `In ${phases}: ${problems.join(", ")}.${meet}`);
  if (run.verdict === "fix-setting") {
    const reasons = Array.isArray(run.reasons) ? run.reasons.filter((x) => typeof x === "string") : [];
    return row(name, "note", `No gaps in ${phases}, but a setting needs changing.${reasons.length ? ` ${reasons.join(" ")}` : ""}${meet}`);
  }
  return row(name, "pass", `No gaps in ${phases}.${meet}`);
}

function ticksRow(results) {
  const name = "No clock-crossing clicks";
  const run = lastOf(
    list(results.checks?.long),
    (r) => r.mode === "tone" && (r.recordedSec ?? 0) >= 30 * 60,
  );
  if (!run) return row(name, "todo", "Needs a long check with the test tone of at least 30 minutes (step 7).");
  const tone = run.tonePath?.ticksPer30Min;
  const mp = run.micPath ?? null;
  const gate = mp?.noiseGate === true;
  const micMeasured = Boolean(mp) && (isNum(mp.ppm) || (!gate && (mp.holes ?? 0) > 0));
  const mic = micMeasured ? (gate ? mp.dropsPer30Min : mp.ticksPer30Min) : null;
  const toneText = isNum(tone) ? `about ${per30(tone)} per 30 min` : "not measured";
  const micText = isNum(mic) ? `about ${per30(mic)} per 30 min` : "not measured";
  const sibling = results.voice?.devices?.defaultOutputIsMicSibling === true
    ? " Windows' default playback device is your headset's own earpiece."
    : "";
  const text = `The meeting's side: ${toneText}; your microphone's side: ${micText} (6 at most each).${sibling}`;
  if ((isNum(tone) && tone > LIMITS.TICKS_PER_30_MIN) || (isNum(mic) && mic > LIMITS.TICKS_PER_30_MIN)) {
    return row(name, "fail", `${text} Run the comparison through the audio element (step 7.6).`);
  }
  if (!isNum(tone) || !isNum(mic)) return row(name, "note", text);
  return row(name, "pass", text);
}

function restartRow(results) {
  const name = "Windows Audio restart: back within 2 s";
  const rec = lastOf(list(results.voice?.recoveries), (r) => r.micToo === true);
  if (!rec) return row(name, "todo", "Restart Windows Audio (step 9), then wait for a new line under Recoveries.");
  const v = rec.restart && typeof rec.restart === "object" && rec.restart.verdict ? rec.restart : restartVerdict(rec);
  const back = isNum(rec.outageMs) ? `Back after ${(rec.outageMs / 1000).toFixed(1)} s: ` : "";
  return row(name, v.verdict === "pass" ? "pass" : "fail", `${back}${v.text}.`);
}

function connectRow(results) {
  const ok = results.sanas?.ok;
  if (ok === true) return row("Connect only", "pass", "Sanas accepted the key and this app's address.");
  if (ok === false) return row("Connect only", "fail", "Sanas did not accept the connection: see the Connect step.");
  return row("Connect only", "todo", "Press “Connect only” (step 10).");
}

/**
 * The Gate 1 checklist from the collected results (schema 2), in order:
 * secure page; the microphone with its processing off (and the user's note
 * on prompts at the 1st and 3rd start; a microphone that took more than
 * 1.5 s to open hints at a prompt); the voice into CABLE Input (the route
 * method and its changes; "sink-refused" fails); Zoom's Test Mic (the user's
 * note); the delay (the highest estimate of the runs on the normal route;
 * runs forced onto the audio element are listed, not counted); no gaps
 * while minimized and hidden (25 min of each needed, plus the user's note
 * that the Meet call stayed open); no clock-crossing clicks (each road at
 * most 6 per 30 minutes); the Windows Audio restart (the latest recovery
 * that involved both the microphone and the context); Connect only.
 * → [{ row, status: "pass" | "fail" | "todo" | "note", text }]
 */
export function gateSummary(results) {
  const r = results && typeof results === "object" ? results : {};
  return [
    securePageRow(r),
    microphoneRow(r),
    cableRow(r),
    row("Zoom's Test Mic hears you", "todo", "Your note from step 5: did Zoom's Test Mic play your voice back?"),
    delayRow(r),
    gapsRow(r),
    ticksRow(r),
    restartRow(r),
    connectRow(r),
  ];
}
