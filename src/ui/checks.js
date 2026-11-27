/**
 * Step 3 of the page, "Checks for the meeting (Session B)": what the delay
 * measurement, the long check and Hide say while they run and when they are
 * done, and the Session B checklist (gateSummary's rows).
 *
 * The texts are made by small pure functions (exported, so they can be
 * checked on their own); the view only puts them on the page, through
 * textContent. Nothing touches the page when this module is imported.
 */
import { formatClock } from "../core/cable-check.js";
import { clockText } from "./voice.js";

/** Texts of this part of the page (plain English, no device names). */
export const CHECKS_TEXTS = Object.freeze({
  measuring: (secondsLeft) => `Say “pa-ta-ka” over and over… ${secondsLeft} s left`,
  starting: "Starting the long check…",
  passed: "Long check done: passed.",
  fixSetting: "Long check done: needs a setting change:",
  notPassed: "Long check done: not passed:",
  noSignal: "Long check done: nothing measured:",
  toneNotFound: "tone not found yet",
  hidden: (at, back) =>
    `Hidden at ${at}. The app comes back by itself at ${back} (look for it on the taskbar), or open Accent Changer from the Start menu to bring it back sooner.`,
  longEnds: (at) => ` The long check now ends at ${at}.`,
});

/** The window's phase in words, as the long check's lines say it. */
const PHASE_WORDS = Object.freeze({ visible: "open", minimized: "minimized", hidden: "hidden", unknown: "unknown" });

/** The checklist's marks and the page's kinds, by gateSummary status. */
const GATE_MARKS = Object.freeze({
  pass: ["✓", "ok"],
  fail: ["✗", "error"],
  todo: ["…", "info"],
  note: ["!", "warn"],
});

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** A level in dB with a real minus sign: "−12.0 dB". */
const dbText = (v) => `${v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)} dB`;

/** An ISO time (or epoch ms) as "14:02" in local time. */
const hhmm = (when) => clockText(typeof when === "string" ? Date.parse(when) : when, { seconds: false });

/** The status kind of a delay verdict. */
export function delayKind(verdict) {
  if (verdict === "good") return "ok";
  if (verdict === "slow" || verdict === "silent-cable") return "error";
  return "warn";
}

/** The delay's result in words: its verdict text, then its notes. */
export function delayText(result) {
  const notes = Array.isArray(result?.notes) ? result.notes.filter((n) => typeof n === "string" && n) : [];
  return [result?.text ?? "", ...notes].filter(Boolean).join(" ");
}

/**
 * One line while the long check runs: "Long check: 12:30 of 65:00 · now
 * minimized · minimized so far 10:02 · hidden so far 0:00 · tone −12.0 dB ·
 * clicks 1 · gaps 0" (mic mode: dropouts in place of the tone and clicks).
 * The total includes an extension ("of 1:12:30"). While the mic-mode
 * analysis runs: its own text ("Analysing (about 5 s)…").
 * @param {object} p the progress of Checks.startLong
 */
export function longProgressText(p) {
  if (!p || typeof p !== "object") return "";
  if (p.analysing) return typeof p.text === "string" && p.text ? p.text : `Analysing (about ${p.analysingSec ?? 1} s)…`;
  const so = p.phasesSoFar ?? {};
  const parts = [
    `Long check: ${formatClock(p.elapsedSec)} of ${formatClock(p.totalSec)}`,
    `now ${PHASE_WORDS[p.phase] ?? PHASE_WORDS.unknown}`,
    `minimized so far ${formatClock(so.minimizedSec)}`,
    `hidden so far ${formatClock(so.hiddenSec)}`,
  ];
  if (p.mode === "mic") {
    parts.push(`dropouts ${p.dropouts ?? 0}`);
  } else {
    parts.push(isNum(p.levelDb) ? `tone ${dbText(p.levelDb)}` : CHECKS_TEXTS.toneNotFound);
    parts.push(`clicks ${p.ticks ?? 0}`);
  }
  parts.push(`gaps ${p.gaps ?? 0}`);
  return parts.join(" · ");
}

/**
 * The long check's result in words: { head, lines, kind }. head says
 * whether it passed (and why not); lines are its own lines, then its notes.
 * @param {object} result a LongResult
 */
export function longDone(result) {
  const reasons = (Array.isArray(result?.reasons) ? result.reasons : []).filter((r) => typeof r === "string" && r);
  const why = reasons.length ? ` ${reasons.join(" ")}` : "";
  let head;
  let kind;
  switch (result?.verdict) {
    case "pass":
      head = CHECKS_TEXTS.passed;
      kind = "ok";
      break;
    case "fix-setting":
      head = CHECKS_TEXTS.fixSetting + why;
      kind = "warn";
      break;
    case "no-signal":
      head = CHECKS_TEXTS.noSignal + why;
      kind = "error";
      break;
    default:
      head = CHECKS_TEXTS.notPassed + why;
      kind = "error";
  }
  const lines = [...(Array.isArray(result?.lines) ? result.lines : []), ...(Array.isArray(result?.notes) ? result.notes : [])];
  return { head, lines: lines.filter((l) => typeof l === "string" && l), kind };
}

/** What the page says after Hide (a HideResult). */
export function hideText(r) {
  let text = CHECKS_TEXTS.hidden(hhmm(r?.at ?? Date.now()), hhmm(r?.showAt ?? Date.now()));
  if (r?.longEndsAt) text += CHECKS_TEXTS.longEnds(hhmm(r.longEndsAt));
  return text;
}

/** A checklist row as the page shows it: { text: "✓ · row · text", kind }. */
export function gateItem(row) {
  const [mark, kind] = GATE_MARKS[row?.status] ?? GATE_MARKS.todo;
  return { text: `${mark} · ${row?.row ?? ""} · ${row?.text ?? ""}`, kind };
}

/** Put lines into an element: text, then each further line after a line break. */
function setLines(el, lines, kind = null) {
  const doc = el.ownerDocument;
  const parts = [];
  lines.forEach((line, i) => {
    if (i > 0) parts.push(doc.createElement("br"));
    parts.push(doc.createTextNode(line));
  });
  el.replaceChildren(...parts);
  if (kind) el.dataset.kind = kind;
  else delete el.dataset.kind;
}

/** Step 3 of the page. */
export class ChecksView {
  /** @param {{$: (id: string) => HTMLElement}} options */
  constructor({ $ }) {
    this.$ = $;
  }

  delayProgress(secondsLeft) {
    setLines(this.$("measureInfo"), [CHECKS_TEXTS.measuring(Math.max(0, Math.round(secondsLeft)))]);
  }

  delayDone(result) {
    setLines(this.$("measureInfo"), [delayText(result)], delayKind(result?.verdict));
  }

  /** A delay measurement that could not run or was cut short: its message. */
  delayFailed(message) {
    setLines(this.$("measureInfo"), [String(message ?? "")], "error");
  }

  longStarting() {
    setLines(this.$("longInfo"), [CHECKS_TEXTS.starting]);
  }

  longProgress(p) {
    const text = longProgressText(p);
    if (text) setLines(this.$("longInfo"), [text]);
  }

  /** The long check is over: its verdict, then its lines. → the status kind */
  longDone(result) {
    const { head, lines, kind } = longDone(result);
    setLines(this.$("longInfo"), [head, ...lines], kind);
    return kind;
  }

  longFailed(message) {
    setLines(this.$("longInfo"), [String(message ?? "")], "error");
  }

  hideDone(result) {
    setLines(this.$("hideInfo"), [hideText(result)]);
  }

  /** The Session B checklist from gateSummary(results). */
  renderGate(rows) {
    const ul = this.$("gateList");
    const doc = ul.ownerDocument;
    ul.replaceChildren(
      ...(Array.isArray(rows) ? rows : []).map((row) => {
        const { text, kind } = gateItem(row);
        const li = doc.createElement("li");
        li.textContent = text;
        li.dataset.kind = kind;
        return li;
      }),
    );
  }
}
