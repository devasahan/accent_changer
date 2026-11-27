/**
 * Step 2 of the page, "Your voice to the meeting": what the voice graph is
 * doing (its state in words, two level meters, the warnings, the route and
 * the devices' rates, the recoveries), the device choices, and the voice's
 * part of "Copy results".
 *
 * The page itself shows the devices' real names: it stays on this PC.
 * Everything that goes into the results passes through reportLabel(), which
 * keeps only VB-CABLE's own names and Windows' generic words. No device id
 * or group id is ever put there.
 *
 * Text goes in through textContent only. Nothing touches the page when this
 * module is imported: main.js makes the view once the page has loaded.
 */
import { headphonesFor, pseudoTarget, reportLabel, siblingOutput, virtualOutputs } from "../core/device-choice.js";
import { isCableInput, isCableOutput } from "../core/devices-match.js";
import { restartVerdict } from "../core/cable-check.js";
import { captureLatencyMs } from "../audio/measure.js";

/** Texts of this part of the page (plain English, no device names). */
export const VOICE_TEXTS = Object.freeze({
  autoCable: "Automatic: CABLE Input",
  autoMissing: "Automatic: not found",
  forNow: " (for now)",
  noName: "(no name)",
  notYet: "not yet",
  unknown: "unknown",
  noRecoveries: "None so far.",
  cableFound: "installed (CABLE Input found)",
  cableMissing: "not installed yet (needed for Session B)",
  slowOpen: " (slow: did a question appear?)",
  permissionFix: " + the permission fix",
  bringingBack: "bringing it back…",
});

/** Why the voice stopped, in words (the recovery log; the same words as the status line). */
const CAUSE_WORDS = Object.freeze({
  "render-error": "the audio device reported an error",
  "render-stalled": "the audio stopped moving",
  "context-suspended": "the audio was paused",
  "context-closed": "the audio engine closed",
  "sink-changed": "the playback device changed",
  "mic-ended": "the microphone stopped",
  "change-failed": "the change you made did not work",
});

const PSEUDO_IDS = ["default", "communications"];
const LEVEL_FLOOR_DB = -60;
const MAX_LOG_LINES = 20;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const roundTo = (x, digits = 0) => {
  if (!isNum(x)) return null;
  const k = 10 ** digits;
  return Math.round(x * k) / k;
};
const pad2 = (n) => String(n).padStart(2, "0");

/** A device the app can use by its id: not a pseudo-device, not an id-less entry. */
const isReal = (d) => Boolean(d) && typeof d.deviceId === "string" && d.deviceId !== "" && !PSEUDO_IDS.includes(d.deviceId);

/** The epoch ms of a time on the page's performance.now() timeline. */
export const epochOf = (perfMs) => Date.now() - (performance.now() - perfMs);

/** "14:03:12" (seconds true) or "14:03", in local time. */
export function clockText(epochMs, { seconds = true } = {}) {
  const d = new Date(isNum(epochMs) ? epochMs : Date.now());
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return seconds ? `${hm}:${pad2(d.getSeconds())}` : hm;
}

/** 48000 → "48 kHz", 44100 → "44.1 kHz"; "unknown" when not known. */
export function kHz(hz) {
  return isNum(hz) && hz > 0 ? `${hz / 1000} kHz` : VOICE_TEXTS.unknown;
}

/** A processing switch as the page shows it: false → "off"; true or a mode such as "all" → "ON". */
const offText = (v) => (v === false ? "off" : v === true || (typeof v === "string" && v) ? "ON" : VOICE_TEXTS.unknown);

/** The route method in words: "the app's audio engine", "an audio element (fallback)", "… + the permission fix". */
export function routeWords(method) {
  if (typeof method !== "string" || !method) return VOICE_TEXTS.notYet;
  const base = method.startsWith("element") ? "an audio element (fallback)" : "the app's audio engine";
  return method.endsWith("-after-permission") ? base + VOICE_TEXTS.permissionFix : base;
}

/** The cause of an outage in words. */
export const causeWords = (cause) => CAUSE_WORDS[cause] ?? "a problem with the sound";

/**
 * One line of the recovery log for a record of OutputRecovery.log:
 * "14:03:12 · the audio was paused: back after 1.4 s", plus " · Windows Audio
 * restart? " and restartVerdict's text when the microphone was lost too.
 */
export function recoveryLine(record) {
  const at = clockText(epochOf(record.lostAtMs));
  const back = isNum(record.outageMs) ? `back after ${(record.outageMs / 1000).toFixed(1)} s` : "back";
  const restart = record.micToo ? ` · Windows Audio restart? ${restartVerdict(record).text}` : "";
  return `${at} · ${causeWords(record.cause)}: ${back}${restart}`;
}

/** The line of an outage that is not over: "14:03:12 · the audio was paused: still trying (12 s)". */
export function openRecoveryLine({ lostAtMs, cause, sinceMs = null }) {
  const at = clockText(epochOf(lostAtMs));
  const how = isNum(sinceMs) ? `still trying (${Math.round(sinceMs / 1000)} s)` : VOICE_TEXTS.bringingBack;
  return `${at} · ${causeWords(cause)}: ${how}`;
}

/** A fault record as the results keep it (times as ISO text and whole ms; no device names). */
export function recoveryResult(r) {
  const out = {
    cause: r.cause ?? null,
    at: isNum(r.lostAtMs) ? new Date(epochOf(r.lostAtMs)).toISOString() : null,
    outageMs: roundTo(r.outageMs),
    serviceBackAfterMs: isNum(r.serviceBackAtMs) && isNum(r.lostAtMs) ? roundTo(r.serviceBackAtMs - r.lostAtMs) : null,
    appMs: roundTo(r.appMs),
    waitMs: roundTo(r.waitMs),
    afterDevicesBackMs: roundTo(r.afterDevicesBackMs),
    attempts: isNum(r.attempts) ? r.attempts : null,
    steps: Array.isArray(r.steps) ? r.steps.slice() : [],
    micToo: Boolean(r.micToo),
  };
  if (out.micToo) out.restart = restartVerdict(r);
  return out;
}

/**
 * Fill a <dl> with term/value pairs. An array value becomes a list ("none"
 * when empty). Text only (textContent).
 * @param {HTMLElement} dl
 * @param {Array<[string, string|number|string[]]>} pairs
 */
export function fillList(dl, pairs) {
  const doc = dl.ownerDocument;
  dl.replaceChildren(
    ...pairs.flatMap(([term, value]) => {
      const dt = doc.createElement("dt");
      dt.textContent = term;
      const dd = doc.createElement("dd");
      if (Array.isArray(value)) {
        const ul = doc.createElement("ul");
        ul.append(...value.map((v) => Object.assign(doc.createElement("li"), { textContent: v })));
        dd.append(value.length ? ul : "none");
      } else dd.textContent = String(value);
      return [dt, dd];
    }),
  );
}

/**
 * Set a select's options ([value, text] pairs). The options are made again
 * only when they changed: an open list would close on every new device list.
 */
const shownOptions = new WeakMap(); // select → the options it shows (as JSON)
function setOptions(select, pairs) {
  const key = JSON.stringify(pairs);
  if (shownOptions.get(select) === key) return;
  const doc = select.ownerDocument;
  select.replaceChildren(
    ...pairs.map(([value, text]) => {
      const o = doc.createElement("option");
      o.value = value;
      o.textContent = text;
      return o;
    }),
  );
  shownOptions.set(select, key);
}

/** Step 2 of the page, drawn from the voice graph's state and events. */
export class VoiceView {
  /**
   * @param {object} options
   * @param {(id: string) => HTMLElement} options.$ the page's elements by id
   * @param {object} options.graph the VoiceGraph
   * @param {() => object} options.getSettings the validated settings
   * @param {() => void} [options.onChange] something the results hold has changed
   * @param {() => void} [options.onLevels] new levels (ten times a second)
   */
  constructor({ $, graph, getSettings, onChange = () => {}, onLevels = () => {} }) {
    this.$ = $;
    this.graph = graph;
    this.getSettings = getSettings;
    this.onChange = onChange;
    this.onLevels = onLevels;
    this.since = new Date().toISOString();
    this.lastState = null;
    this.startedAtMs = null;
    /** The microphone the user just picked, until the graph has switched (the list shows it meanwhile). */
    this.pendingMic = null;
    /** The fault outage that is not over: { lostAtMs, cause, sinceMs }. */
    this.open = null;
    this.checksBusy = false;
  }

  /** Follow the graph's events (call renderAll() once the graph has started, so it never shows "stopped" first). */
  attach() {
    const g = this.graph;
    const changed = () => {
      try {
        this.onChange();
      } catch {
        // The page's own problem: the view stays drawn.
      }
    };
    g.addEventListener("state", (ev) => {
      if (ev.detail?.state !== this.lastState) {
        this.lastState = ev.detail?.state ?? null;
        this.since = new Date().toISOString();
      }
      this.renderStatus();
      changed();
    });
    g.addEventListener("levels", (ev) => {
      this.renderMeters(ev.detail);
      try {
        this.onLevels();
      } catch {
        // As above.
      }
    });
    for (const type of ["devices", "mic", "output"]) {
      g.addEventListener(type, () => {
        this.renderSelects();
        this.renderInfo();
        changed();
      });
    }
    g.addEventListener("warnings", () => {
      this.renderWarnings();
      changed();
    });
    g.addEventListener("recovery", (ev) => {
      this.onRecovery(ev.detail);
      changed();
    });
  }

  /** The graph is starting now (the time base of the microphone's holes per 30 minutes). */
  started() {
    this.startedAtMs = performance.now();
  }

  renderAll() {
    this.renderStatus();
    this.renderSelects();
    this.renderWarnings();
    this.renderInfo();
    this.renderRecoveries();
  }

  renderStatus() {
    const info = this.graph.stateInfo;
    const el = this.$("voiceStatus");
    el.textContent = info.text;
    el.dataset.kind = info.kind;
    this.$("btnStartVoice").hidden = info.state !== "needs-gesture";
  }

  /**
   * The microphone list (usable microphones, real names; a stand-in marked
   * "(for now)") and the "Send your voice to" list (Automatic, then the
   * playback devices that look like a virtual cable). Nothing is listed
   * before the first device list.
   */
  renderSelects() {
    const snap = this.graph.snapshot;
    const micSelect = this.$("micSelect");
    const outSelect = this.$("outSelect");
    micSelect.disabled = this.checksBusy;
    outSelect.disabled = this.checksBusy;
    if (!snap) return;
    const settings = this.getSettings() ?? {};
    const mic = this.graph.mic;
    const usable = Array.isArray(snap.usable) ? snap.usable : [];
    setOptions(
      micSelect,
      usable.map((d) => {
        const standIn = Boolean(mic?.standIn && mic.entry?.deviceId === d.deviceId);
        return [d.deviceId, (d.label || VOICE_TEXTS.noName) + (standIn ? VOICE_TEXTS.forNow : "")];
      }),
    );
    const live = mic && mic.track?.readyState === "live" ? mic.entry?.deviceId : null;
    const wanted = [this.pendingMic, live, settings.micDeviceId].find((id) => id && usable.some((d) => d.deviceId === id));
    if (wanted) micSelect.value = wanted;

    const outs = virtualOutputs(Array.isArray(snap.outputs) ? snap.outputs : []);
    setOptions(outSelect, [
      ["", snap.cableIn ? VOICE_TEXTS.autoCable : VOICE_TEXTS.autoMissing],
      ...outs.map((d) => [d.deviceId, d.label || VOICE_TEXTS.noName]),
    ]);
    const chosen = settings.cableDeviceId;
    outSelect.value = chosen && outs.some((d) => d.deviceId === chosen) ? chosen : "";
  }

  /** A check runs: the device choices wait until it is over. */
  setChecksBusy(busy) {
    this.checksBusy = Boolean(busy);
    for (const id of ["micSelect", "outSelect", "routeSelect"]) this.$(id).disabled = this.checksBusy;
  }

  renderMeters(levels) {
    const level = (db) => Math.max(LEVEL_FLOOR_DB, Math.min(0, isNum(db) ? db : LEVEL_FLOOR_DB));
    this.$("micMeter").value = level(levels?.micPeakDb);
    this.$("outMeter").value = level(levels?.outPeakDb);
  }

  renderWarnings() {
    const ul = this.$("voiceWarnings");
    const doc = ul.ownerDocument;
    ul.replaceChildren(...this.graph.warnings.map((w) => Object.assign(doc.createElement("li"), { textContent: w.text })));
  }

  /** The microphone, its processing and rate, the route, the rates and the delay on the way out. */
  renderInfo() {
    const g = this.graph;
    const mic = g.mic;
    const out = g.output;
    const rates = g.rates;
    const s = mic?.settings ?? null;
    fillList(this.$("voiceInfo"), [
      ["Microphone", mic ? (mic.entry?.label || VOICE_TEXTS.noName) + (mic.standIn ? VOICE_TEXTS.forNow : "") : VOICE_TEXTS.notYet],
      [
        "Echo cancellation / noise suppression / auto gain",
        s ? `${offText(s.echoCancellation)} / ${offText(s.noiseSuppression)} / ${offText(s.autoGainControl)}` : VOICE_TEXTS.unknown,
      ],
      ["Microphone runs at", kHz(s?.sampleRateHz)],
      ["Sent through", routeWords(out?.method)],
      ["CABLE Input runs at", kHz(rates.cableInputHz)],
      ["Default playback device runs at", kHz(rates.defaultOutputHz)],
      ["Delay on the way out", isNum(out?.outputLatencyMs) ? `${Math.round(out.outputLatencyMs)} ms` : VOICE_TEXTS.unknown],
    ]);
  }

  onRecovery(d) {
    if (!d) return;
    if (d.kind === "lost") {
      this.open = { lostAtMs: d.outage?.lostAtMs ?? performance.now(), cause: d.outage?.cause ?? null, sinceMs: null };
    } else if (d.kind === "still-trying") {
      const o = d.outage ?? {};
      if (!this.open || this.open.lostAtMs !== o.lostAtMs) this.open = { lostAtMs: o.lostAtMs ?? performance.now(), cause: o.cause ?? null, sinceMs: null };
      this.open.sinceMs = d.sinceMs ?? null;
    } else if (d.kind === "back" || d.kind === "started" || d.kind === "applied") {
      this.open = null;
    }
    this.renderRecoveries();
  }

  /** The recovery log: every outage that is over (newest last), then the one that is not. */
  renderRecoveries() {
    const ul = this.$("recoveryLog");
    const doc = ul.ownerDocument;
    const lines = this.graph.recoveries.slice(-MAX_LOG_LINES).map(recoveryLine);
    if (this.open) lines.push(openRecoveryLine(this.open));
    if (!lines.length) lines.push(VOICE_TEXTS.noRecoveries);
    ul.replaceChildren(...lines.map((text) => Object.assign(doc.createElement("li"), { textContent: text })));
  }

  /**
   * After "Check the microphone": fill the microphone's details (real names,
   * on the page) and return results.microphone (names masked), or null when
   * no microphone is open.
   */
  microphoneCheck() {
    const g = this.graph;
    const mic = g.mic;
    if (!mic || mic.track?.readyState !== "live") return null;
    const snap = g.snapshot;
    const s = mic.settings ?? {};
    const usable = Array.isArray(snap?.usable) ? snap.usable : [];
    const outputs = (Array.isArray(snap?.outputs) ? snap.outputs : []).filter(isReal);
    const name = (d) => d.label || VOICE_TEXTS.noName;
    const ms = mic.openedInMs;
    fillList(this.$("micInfo"), [
      ["Opened in", isNum(ms) ? `${ms} ms${ms > 1500 ? VOICE_TEXTS.slowOpen : ""}` : VOICE_TEXTS.unknown],
      ["Microphone used", (mic.entry?.label || VOICE_TEXTS.noName) + (mic.standIn ? VOICE_TEXTS.forNow : "")],
      [
        "Echo cancellation / noise suppression / auto gain",
        `${offText(s.echoCancellation)} / ${offText(s.noiseSuppression)} / ${offText(s.autoGainControl)}`,
      ],
      ["Microphones", usable.map(name)],
      ["Playback devices", outputs.map(name)],
      ["VB-CABLE", snap?.cableIn ? VOICE_TEXTS.cableFound : VOICE_TEXTS.cableMissing],
    ]);
    return {
      ok: true,
      openedInMs: isNum(ms) ? ms : null,
      used: reportLabel(mic.entry?.label),
      echoCancellation: s.echoCancellation ?? null,
      noiseSuppression: s.noiseSuppression ?? null,
      autoGainControl: s.autoGainControl ?? null,
      sampleRate: s.sampleRateHz ?? null,
      microphones: usable.map((d) => reportLabel(d.label)),
      outputs: outputs.map((d) => reportLabel(d.label)),
      cableInputFound: Boolean(snap?.cableIn),
    };
  }

  /** results.voice (schema 2): no device ids, group ids or unmasked names. */
  results() {
    const g = this.graph;
    const snap = g.snapshot;
    const mic = g.mic;
    const out = g.output;
    const rates = g.rates;
    const start = g.startRecord;
    const total = g.levels?.micHolesTotal ?? 0;
    const elapsedSec = this.startedAtMs === null ? 0 : (performance.now() - this.startedAtMs) / 1000;
    const outputs = Array.isArray(snap?.outputs) ? snap.outputs : [];
    const sibling = snap && mic?.entry ? siblingOutput(outputs, mic.entry) : null;
    const defaultTarget = snap ? pseudoTarget(outputs, "default") : null;
    const phones = headphonesFor(snap, { mic: mic?.entry ?? null, standIn: Boolean(mic?.standIn) });
    return {
      state: g.state,
      since: this.since,
      processor: out?.processor ?? null,
      start: start ? { ms: roundTo(start.ms), attempts: start.attempts, steps: (start.steps ?? []).slice() } : null,
      mic: mic
        ? {
            label: reportLabel(mic.entry?.label),
            how: mic.how ?? null,
            standIn: Boolean(mic.standIn),
            settings: mic.settings ?? null,
            openedInMs: mic.openedInMs ?? null,
            unlockMs: mic.unlockMs ?? null,
            captureLatencyMs: captureLatencyMs(mic.track),
            mutedCount: mic.mutedCount ?? 0,
          }
        : null,
      micHoles: { total, per30Min: elapsedSec >= 1 ? roundTo((total * 1800) / elapsedSec, 2) : null },
      output: out
        ? {
            label: out.entry ? reportLabel(out.entry.label) : null,
            how: out.how ?? null,
            method: out.method ?? null,
            routePreference: out.routePreference ?? "auto",
            tried: Array.isArray(out.tried) ? out.tried : [],
            routeChanges: Array.isArray(out.routeChanges) ? out.routeChanges : [],
            contextSink: out.contextSink ?? null,
            sinkRateHz: out.sinkRateHz ?? null,
            contextRateHz: out.contextRateHz ?? null,
            baseLatencyMs: out.baseLatencyMs ?? null,
            outputLatencyMs: out.outputLatencyMs ?? null,
          }
        : null,
      devices: snap
        ? {
            microphones: Array.isArray(snap.usable) ? snap.usable.length : 0,
            outputs: outputs.filter(isReal).length,
            cableInput: Boolean(snap.cableIn),
            cableOutput: Boolean(snap.cableOut),
            cableEndpoints: (snap.cableEndpoints ?? []).map(reportLabel),
            labelsVisible: Boolean(snap.labelsVisible),
            defaultOutputRateHz: rates.defaultOutputHz ?? null,
            defaultOutputIsCable: isCableInput(snap.defaultOutputLabel ?? ""),
            defaultInputIsCable: isCableOutput(snap.defaultInputLabel ?? ""),
            commsOutputIsCable: isCableInput(snap.commsOutputLabel ?? ""),
            commsInputIsCable: isCableOutput(snap.commsInputLabel ?? ""),
            micHasSiblingOutput: Boolean(sibling),
            defaultOutputIsMicSibling: Boolean(sibling && defaultTarget && sibling.deviceId === defaultTarget.deviceId),
          }
        : null,
      monitor: { sink: phones.how ?? null, refusal: phones.refusal ?? null },
      debug: g.debugCounts(),
      warnings: g.warningsWith(reportLabel),
      recoveries: g.recoveries.map(recoveryResult),
    };
  }
}
