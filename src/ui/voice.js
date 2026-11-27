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
import {
  PSEUDO_IDS,
  causeText,
  headphonesFor,
  pseudoTarget,
  reportLabel,
  routeWords as routeWordsOf,
  siblingOutput,
  virtualOutputs,
} from "../core/device-choice.js";
import { isCableInput, isCableOutput } from "../core/devices-match.js";
import { restartVerdict } from "../core/cable-check.js";
import { captureLatencyMs, epochOf } from "../audio/measure.js";

/** Texts of this part of the page (plain English, no device names). */
export const VOICE_TEXTS = Object.freeze({
  autoCable: "Automatic: CABLE Input",
  autoMissing: "Automatic: CABLE Input not found",
  forNow: " (for now)",
  noName: "(no name)",
  notYet: "not yet",
  unknown: "unknown",
  noRecoveries: "None so far.",
  cableFound: "installed (CABLE Input found)",
  cableMissing: "not installed yet (needed for Session B)",
  slowOpen: " (slow: did a question appear?)",
  bringingBack: "bringing it back…",
  waitingForYou: "waiting for you (see step 2)",
  notReaching: " Your voice is not reaching the meeting yet: see step 2.",
  notSaved: (why) => ` Could not save the settings: ${why}`,
});

/**
 * The status line of a device or route choice: while it is made, while the
 * voice graph is still on it, and how it ended.
 */
export const CHOICE_TEXTS = Object.freeze({
  mic: Object.freeze({
    switching: "Switching the microphone…",
    still: "Still switching the microphone…",
    done: "Microphone switched.",
    failed: "The microphone could not be switched: see step 2.",
  }),
  output: Object.freeze({
    switching: "Switching where your voice goes…",
    still: "Still switching where your voice goes…",
    done: "Switched where your voice goes.",
    failed: "That device could not be used: see step 2.",
  }),
  route: Object.freeze({
    switching: "Switching the output route…",
    still: "Still switching the output route…",
    done: "Output route switched.",
    failed: "The output route could not be switched: see step 2.",
  }),
});

/** States in which the voice graph waits for the user (a refusal; in Edge, a click): it does not try by itself. */
const WAITING_STATES = Object.freeze(["mic-blocked", "sink-refused", "needs-gesture"]);

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

/** The epoch ms of a time on the page's performance.now() timeline (measure.js's, one for the page). */
export { epochOf };

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

/**
 * The route method in plain words: "the normal route" (the app's own audio
 * context on CABLE Input), "a slower backup route" (an audio element), and
 * ", after a permission fix" when WebView2's saved permission had to be set
 * first; "not yet" without a route. The words are device-choice.js's
 * routeWords, which the warnings and the checklist use too. Only the results
 * keep the method's own name.
 */
export function routeWords(method) {
  return routeWordsOf(method, VOICE_TEXTS.notYet);
}

/** The cause of an outage in words: device-choice.js's causeText, as the status line says it. */
export const causeWords = causeText;

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

/**
 * The line of an outage that is not over: "14:03:12 · the audio was paused:
 * bringing it back…", or "… still trying (12 s)". With `waiting`, the app
 * waits for the user (the microphone or VB-CABLE was refused: it does not try
 * by itself until the user acts), and the line says so: "… waiting for you
 * (see step 2)".
 */
export function openRecoveryLine({ lostAtMs, cause, sinceMs = null, waiting = false }) {
  const at = clockText(epochOf(lostAtMs));
  let how = VOICE_TEXTS.bringingBack;
  if (waiting) how = VOICE_TEXTS.waitingForYou;
  else if (isNum(sinceMs)) how = `still trying (${Math.round(sinceMs / 1000)} s)`;
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
 * The status line after the user picked a microphone, an output or a route.
 * taken: the voice graph now uses the choice. running: the voice reaches the
 * meeting. notSaved: why the choice could not be saved (it still applies
 * until the app closes), or null. A choice can be taken while the voice
 * does not run (no VB-CABLE yet, an outage): then the line says so.
 * → { text, kind }
 */
export function changeOutcome({ taken, running, done, failed, notSaved = null }) {
  const saveText = notSaved ? VOICE_TEXTS.notSaved(notSaved) : "";
  if (!taken) return { text: failed + saveText, kind: "warn" };
  if (!running) return { text: done + VOICE_TEXTS.notReaching + saveText, kind: "warn" };
  return { text: done + saveText, kind: notSaved ? "warn" : "ok" };
}

/**
 * Where a device or route choice stands, from what the voice graph shows
 * now: "taken" (the graph uses it), "pending" (the graph is still on it) or
 * "failed" (it is not used, and the graph has stopped trying it).
 * - While a change is in progress ("switching"), the choice is pending, even
 *   if it looks taken: the switch is not over yet.
 * - While the voice starts or recovers, every try uses the saved choice: a
 *   choice not in use yet is pending.
 * The graph answers a request within 10 s, but a switch can take longer
 * (opening a microphone may take 15 s, and a change can wait behind
 * another one), so the answer alone does not settle a choice.
 * @param {{ taken: boolean, state: string }} now
 */
export function choiceState({ taken, state }) {
  if (state === "switching") return "pending";
  if (taken) return "taken";
  return state === "starting" || state === "recovering" ? "pending" : "failed";
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
    /**
     * The device and route choices the graph has not settled yet, by kind
     * ("mic", "output", "route"). The microphone list shows a pending
     * microphone meanwhile.
     */
    this.choices = new Map();
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
      this.onState(ev.detail);
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
        this.checkChoices();
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

  /**
   * The graph's state changed: step 2's status, the open line under
   * Recoveries (it says when the app waits for the user), and the choices
   * the graph may have settled.
   */
  onState(detail) {
    if (detail?.state !== this.lastState) {
      this.lastState = detail?.state ?? null;
      this.since = new Date().toISOString();
    }
    this.renderStatus();
    this.renderRecoveries();
    this.checkChoices();
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
    // The status can become a warning's own text (no VB-CABLE, a stand-in microphone), or stop being it.
    this.renderWarnings();
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
    const pending = this.choices.get("mic")?.value ?? null;
    const wanted = [pending, live, settings.micDeviceId].find((id) => id && usable.some((d) => d.deviceId === id));
    if (wanted) micSelect.value = wanted;

    const outs = virtualOutputs(Array.isArray(snap.outputs) ? snap.outputs : []);
    setOptions(outSelect, [
      ["", snap.cableIn ? VOICE_TEXTS.autoCable : VOICE_TEXTS.autoMissing],
      ...outs.map((d) => [d.deviceId, d.label || VOICE_TEXTS.noName]),
    ]);
    const chosen = settings.cableDeviceId;
    outSelect.value = chosen && outs.some((d) => d.deviceId === chosen) ? chosen : "";
  }

  /** The microphone the voice graph has open now is `id`. */
  usesMic(id) {
    return Boolean(id) && this.graph.mic?.entry?.deviceId === id;
  }

  /**
   * The voice goes to the output the user chose: `id`, or "" for Automatic.
   * While the voice does not run, the choice counts as taken: every try
   * reads the saved choice, and a try that failed earlier (no microphone,
   * say) may not have reached the output yet.
   */
  usesOutput(id) {
    if (this.graph.state !== "running") return true;
    const out = this.graph.output;
    return id ? out?.entry?.deviceId === id : out?.how === "auto";
  }

  /** The route the user chose under Advanced ("auto" or "element") is the graph's (the same rule as usesOutput). */
  usesRoute(value) {
    if (this.graph.state !== "running") return true;
    return (this.graph.output?.routePreference ?? "auto") === value;
  }

  /** The graph uses the choice: usesMic, usesOutput or usesRoute by its kind. */
  uses(kind, value) {
    if (kind === "mic") return this.usesMic(value);
    if (kind === "output") return this.usesOutput(value);
    return this.usesRoute(value);
  }

  /**
   * Follow a choice of the user until the graph has settled it: a
   * microphone ("mic" and its id), the output ("output" and its id, "" for
   * Automatic) or the route under Advanced ("route" and "auto" or
   * "element"). A newer choice of the same kind replaces it.
   * Call answered() once the graph has answered the request: it says where
   * the choice stands then ("taken", "pending" or "failed"; null when a
   * newer choice replaced it). A pending choice is checked again on the
   * graph's next events; `settled` resolves with "taken" or "failed" once the
   * choice is settled, or with null when a newer one replaced it first.
   * → { answered(), settled }
   */
  follow(kind, value) {
    const older = this.choices.get(kind);
    let resolve = () => {};
    const choice = {
      kind,
      value,
      isAnswered: false,
      done: false,
      settled: new Promise((r) => {
        resolve = r;
      }),
      finish: (outcome) => {
        if (choice.done) return;
        choice.done = true;
        if (this.choices.get(kind) === choice) this.choices.delete(kind);
        resolve(outcome);
        if (kind === "mic") this.renderSelects(); // the list shows the microphone in use again
      },
      check: () => {
        const now = choiceState({ taken: this.uses(kind, value), state: this.graph.state });
        if (now !== "pending") choice.finish(now);
        return now;
      },
    };
    // The new choice first: the older one's end redraws the list, which must show the new one.
    this.choices.set(kind, choice);
    older?.finish(null);
    return {
      answered: () => {
        if (choice.done) return null;
        choice.isAnswered = true;
        return choice.check();
      },
      settled: choice.settled,
    };
  }

  /** Check the choices the graph has answered: it may have settled them by now. */
  checkChoices() {
    for (const choice of [...this.choices.values()]) if (choice.isAnswered) choice.check();
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

  /**
   * The warnings under the meters, except one that step 2's status line
   * already says word for word (no VB-CABLE yet; a stand-in microphone): each
   * sentence once. The results keep every warning.
   */
  renderWarnings() {
    const ul = this.$("voiceWarnings");
    const doc = ul.ownerDocument;
    const status = this.graph.stateInfo?.text ?? null;
    const all = Array.isArray(this.graph.warnings) ? this.graph.warnings : [];
    const shown = all.filter((w) => w.text !== status);
    ul.replaceChildren(...shown.map((w) => Object.assign(doc.createElement("li"), { textContent: w.text })));
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

  /**
   * The recovery log lists fault outages only (as the results do). The first
   * start also reports "still trying" while it waits (for VB-CABLE, say):
   * the status line above shows that, so it is not listed.
   */
  onRecovery(d) {
    if (!d) return;
    if ((d.kind === "lost" || d.kind === "still-trying") && d.outage?.kind !== "fault") return;
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

  /**
   * The recovery log: every outage that is over (newest last), then the one
   * that is not. While the graph waits for the user (a refused microphone,
   * say), that line says so: nothing is being brought back until the user
   * acts (step 2 says what to do).
   */
  renderRecoveries() {
    const ul = this.$("recoveryLog");
    const doc = ul.ownerDocument;
    const lines = this.graph.recoveries.slice(-MAX_LOG_LINES).map(recoveryLine);
    if (this.open) lines.push(openRecoveryLine({ ...this.open, waiting: WAITING_STATES.includes(this.graph.state) }));
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
      // The launch's first start, with its own microphone open time and label unlock: a later reopen (after a
      // fault, a stand-in, a change) replaces mic.openedInMs below, never these.
      start: start
        ? {
            ms: roundTo(start.ms),
            attempts: start.attempts,
            steps: (start.steps ?? []).slice(),
            openedInMs: isNum(start.openedInMs) ? start.openedInMs : null,
            unlockMs: isNum(start.unlockMs) ? start.unlockMs : isNum(mic?.unlockMs) ? mic.unlockMs : null,
          }
        : null,
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
