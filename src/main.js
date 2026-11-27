/**
 * The app's page: the Session B test build (plan Step 2).
 * From launch it sends the microphone into VB-CABLE's "CABLE Input", so that
 * Zoom, Teams or Meet can use "CABLE Output" as the microphone, and keeps it
 * going through device changes and errors (src/audio/graph.js). Step 3 of
 * the page runs the Session B checks: the delay, the long check of what the
 * meeting hears, and Hide (src/audio/measure.js). Step 1's checks stay: the
 * key in Windows Credential Manager and Sanas accepting this app's address.
 * "Copy results" gives a summary with no key, token, device id or device
 * name in it (names pass through reportLabel). The results live in this
 * page's memory only (nothing is saved), so the app forgets them when it
 * closes: the page says to copy them before that. The log file gets codes
 * and numbers only (platform.log).
 */
import { platform } from "./platform/index.js";
import { configureSanas, connectSanas, disconnectSanas } from "./engines/sanas.js";
import { DEFAULTS as SETTINGS_DEFAULTS, validateSettings } from "./core/settings.js";
import { redact, redactObject } from "./core/redact.js";
import { gateSummary } from "./core/cable-check.js";
import { VoiceGraph } from "./audio/graph.js";
import { Monitor } from "./audio/monitor.js";
import { Checks } from "./audio/measure.js";
import { CHOICE_TEXTS, VoiceView, changeOutcome, clockText, fillList } from "./ui/voice.js";
import { ChecksView, delayKind } from "./ui/checks.js";

const $ = (id) => document.getElementById(id);

const results = {
  tool: "accent-changer diagnostics",
  schema: 2,
  at: null,
  shell: platform.name,
  app: null,
  page: null,
  key: null,
  sanas: null,
  errors: [],
  microphone: null,
  settings: null,
  voice: null,
  checks: { delay: [], long: [], hide: [], beep: [] },
  gate: [],
  csp: [],
};

/** How often the results are drawn again while only the levels change (the debug counts, the holes). */
const RESULTS_EVERY_MS = 1000;
const NOT_STARTED = "The app is still starting. Try again in a moment.";

configureSanas({ tokenProvider: platform.tokenProvider, where: platform.name === "app" ? "app" : "probe" });

/** The validated settings (the defaults until the saved ones are read). */
let settings = validateSettings(null).settings;
let graph = null;
let monitor = null;
let checks = null;
let voiceView = null;
const checksView = new ChecksView({ $ });
/** The long check that runs (its handle), or null. */
let longHandle = null;
let lastRenderMs = 0;
/** Counts the status lines shown: an outcome that comes late never replaces a newer line. */
let statusCount = 0;
/** Ends the listeners of a status line that waits to be replaced (whenRunningAgain, clearWhenHeadsetBack). */
let statusWatch = null;

function recordError(message) {
  results.errors.push({ at: new Date().toISOString(), message });
}

/**
 * The status line. An "error" line goes into results.errors too, unless
 * `record` is false: a check's own verdict ("Delay measured.", "Long check
 * done.") takes the error colour when it did not pass, but it is no error of
 * the app (the verdicts are in checks.delay and checks.long).
 */
function setStatus(message, kind = "info", { record = true } = {}) {
  statusCount += 1;
  // A newer line ends any wait to replace the one before it.
  statusWatch?.abort();
  statusWatch = null;
  const el = $("status");
  el.textContent = message;
  el.dataset.kind = kind;
  if (kind === "error" && record) recordError(message);
  renderResults();
}

/**
 * `fn` once the voice runs again, unless a newer status line came first
 * (statusCount moved on from `mine`). For a status that said the voice is not
 * reaching the meeting yet: once it does, the line says so.
 */
function whenRunningAgain(mine, fn) {
  if (!graph) return;
  const controller = new AbortController();
  statusWatch = controller;
  graph.addEventListener(
    "state",
    () => {
      if (statusCount !== mine) {
        controller.abort();
        return;
      }
      if (graph.state !== "running") return;
      controller.abort();
      fn();
    },
    { signal: controller.signal },
  );
}

/** Part of the results' text is selected: someone is copying it by hand (or the copy fallback selected it). */
function resultsSelected(pre) {
  const selection = document.getSelection();
  return Boolean(selection && selection.rangeCount > 0 && !selection.isCollapsed && selection.containsNode(pre, true));
}

/**
 * The results as "Copy results" gives them: drawn afresh, then passed
 * through redactObject. Their text under "Show the results" is not rewritten
 * while part of it is selected, or the selection would go; nor by the
 * redraws that only follow the levels (`periodic`) while it is open, so it
 * does not change under the reader's eyes every second. `force` rewrites it
 * anyway (Copy results).
 */
function renderResults({ force = false, periodic = false } = {}) {
  results.at = new Date().toISOString();
  if (voiceView) {
    try {
      results.voice = voiceView.results();
    } catch (err) {
      results.voice = { error: err?.name ?? "Error" };
    }
  }
  results.gate = gateSummary(results);
  checksView.renderGate(results.gate);
  lastRenderMs = performance.now();
  const pre = $("results");
  if (!force && (resultsSelected(pre) || (periodic && pre.closest("details")?.open))) return;
  pre.textContent = JSON.stringify(redactObject(results), null, 2);
}

const messageOf = (err) => (typeof err?.message === "string" && err.message ? err.message : String(err));

/**
 * Run a button's action once at a time, errors shown in the status line.
 * The button is off while the action runs (data-busy marks that), and
 * afterwards only if `usable()` says so: an action can leave its own button
 * off, as Remove key does once the key is gone.
 */
function action(id, fn, { usable = () => true } = {}) {
  const button = $(id);
  button.addEventListener("click", async () => {
    if (button.dataset.busy) return;
    button.dataset.busy = "yes";
    button.disabled = true;
    try {
      await fn();
    } catch (err) {
      console.error(err);
      setStatus(messageOf(err), "error");
    } finally {
      delete button.dataset.busy;
      button.disabled = !usable();
      renderResults();
    }
  });
}

/** A select's change, with errors in the status line (the selects stay usable while the voice recovers). */
function onSelect(id, fn) {
  const select = $(id);
  select.addEventListener("change", async () => {
    try {
      await fn(select);
    } catch (err) {
      console.error(err);
      setStatus(messageOf(err), "error");
    } finally {
      renderResults();
    }
  });
}

function browserName() {
  const brands = navigator.userAgentData?.brands ?? [];
  const brand = brands.find((b) => !/not.?a.?brand|chromium/i.test(b.brand)) ?? brands.find((b) => /chromium/i.test(b.brand));
  if (brand) return `${brand.brand} ${brand.version}`;
  const m = /(Edg|Chrome|Firefox)\/(\d+)/.exec(navigator.userAgent);
  return m ? `${m[1] === "Edg" ? "Edge" : m[1]} ${m[2]}` : "unknown";
}

// ---------- 1 · this app ----------

async function showApp() {
  results.page = { origin: location.origin, secureContext: window.isSecureContext, browser: browserName() };
  const t0 = performance.now();
  try {
    const info = await platform.appInfo();
    // Every test build has the same version, so the build (its tag or branch
    // and commit; "local" or "dev" off CI) tells which one sent the results.
    results.app = { name: info.name, version: info.version, build: info.build ?? null, roundTripMs: Math.round(performance.now() - t0) };
  } catch (err) {
    results.app = { error: err.message };
  }
  fillList($("appInfo"), [
    ["Version", results.app.version ? `${results.app.name} ${results.app.version} (build ${results.app.build ?? "unknown"})` : `error: ${results.app.error}`],
    ["Runs as", platform.name === "app" ? "the installed app" : "Edge dev mode (a browser tab)"],
    ["Page address", results.page.origin],
    ["Secure page", results.page.secureContext ? "yes" : "NO: the microphone and Sanas won't work"],
    ["Engine", results.page.browser],
    [
      "Talks to its own Rust side",
      platform.name !== "app" ? "not in Edge dev mode" : results.app.roundTripMs != null ? `yes (${results.app.roundTripMs} ms)` : "no",
    ],
  ]);
}

// ---------- settings ----------

/**
 * What validateSettings says about the defaults themselves: readiness
 * messages for later steps (today the voice type, which this build has no
 * way to set). They say nothing about the saved settings, so the results
 * leave them out.
 */
const NOT_FOR_THIS_BUILD = new Set(validateSettings(SETTINGS_DEFAULTS).errors);

/** The settings file came from a newer build: this one leaves it as it is (choices last until the app closes). */
let settingsFromNewerBuild = false;
const NEWER_SETTINGS =
  "These settings come from a newer version of the app: the defaults are used, and the file is left as it is.";
const NEWER_NOT_SAVED = "they come from a newer version of the app, which this one leaves as they are";

/** Read the saved settings (never fails: unreadable settings mean the defaults, and the results say so). */
async function loadSettings() {
  let loaded;
  try {
    loaded = await platform.loadSettings();
  } catch (err) {
    loaded = { raw: null, error: messageOf(err) };
  }
  const raw = loaded?.raw ?? null;
  const error = loaded?.error ?? null;
  const plain = raw !== null && typeof raw === "object" && !Array.isArray(raw);
  const newer = !error && plain && typeof raw.version === "number" && raw.version > SETTINGS_DEFAULTS.version;
  const checked = validateSettings(newer ? null : raw);
  settings = checked.settings;
  settingsFromNewerBuild = newer;
  const source = error ? "unreadable" : raw === null ? "none" : newer ? "newer" : plain ? "saved" : "unreadable";
  const errors = checked.errors.filter((e) => !NOT_FOR_THIS_BUILD.has(e));
  results.settings = { source, errors: error ? [error, ...errors] : newer ? [NEWER_SETTINGS, ...errors] : errors };
  platform.log("info", `settings ${source}`);
}

/**
 * Change and save the settings. A failure to save does not stop the change:
 * it applies until the app closes. Settings from a newer build are never
 * written over. → null, or why the settings could not be saved
 */
async function saveSettings(changes) {
  settings = validateSettings({ ...settings, ...changes }).settings;
  if (settingsFromNewerBuild) return NEWER_NOT_SAVED;
  try {
    await platform.saveSettings(settings);
    return null;
  } catch (err) {
    platform.log("warn", "settings save failed");
    return messageOf(err);
  }
}

/**
 * The status after a change of device or route. `taken` comes from what the
 * graph uses now, not from its answer: the graph also answers "not ok" for a
 * change it made while the voice does not run (no VB-CABLE yet, say). The
 * status also says whether the voice reaches the meeting, and whether the
 * choice could be saved (the app keeps going either way).
 */
function changeStatus(taken, done, failed, notSaved = null) {
  const running = graph?.state === "running";
  const { text, kind } = changeOutcome({ taken, running, done, failed, notSaved });
  setStatus(text, kind);
  if (taken && !running) {
    // "…is not reaching the meeting yet": once the voice is back, the line says what really happened.
    whenRunningAgain(statusCount, () => {
      const now = changeOutcome({ taken, running: true, done, failed, notSaved });
      setStatus(now.text, now.kind);
    });
  }
}

/**
 * A choice of microphone ("mic"), output ("output") or route ("route"):
 * `save()` saves it (→ why it could not be saved, or null), then `ask()`
 * asks the voice graph for it. The graph answers within 10 s, but a switch
 * can take longer (opening a microphone may take 15 s, and a change can
 * wait behind another one). While the graph is still on it, the status line
 * says so, and the outcome follows once the graph has settled the choice.
 * A newer status line (another choice, a button) is never replaced by it.
 */
async function makeChoice(kind, value, { save = async () => null, ask }) {
  const texts = CHOICE_TEXTS[kind];
  const choice = voiceView.follow(kind, value);
  setStatus(texts.switching);
  let mine = statusCount;
  let notSaved = null;
  let now = null;
  try {
    notSaved = await save();
    await ask();
  } finally {
    now = choice.answered();
  }
  if (now === "pending") {
    if (statusCount !== mine) return;
    setStatus(texts.still);
    mine = statusCount;
    now = await choice.settled;
  }
  if (now === null || statusCount !== mine) return;
  changeStatus(now === "taken", texts.done, texts.failed, notSaved);
}

/** The user's choices as the graph reads them before every operation. */
const getSaved = () => ({
  mic: { deviceId: settings.micDeviceId, label: settings.micLabel },
  output: { deviceId: settings.cableDeviceId, label: settings.cableLabel },
});

// ---------- 2 · your voice to the meeting ----------

/** The voice graph, the monitor (beeps, the test tone) and the checks, wired to the page. */
function startVoice() {
  const shell = platform.name === "app" ? "app" : "browser";
  graph = new VoiceGraph({ getSaved, allowPermission: platform.allowMicPermission, log: platform.log, where: shell, shell });
  monitor = new Monitor({ getSnapshot: () => graph.snapshot, getMic: () => graph.mic, log: platform.log });
  graph.addEventListener("devices", () => monitor.refresh());
  graph.addEventListener("tap-error", (ev) => {
    recordError(`A check's recorder failed: ${ev.detail?.message ?? "unknown"}`);
    renderResults();
  });
  checks = new Checks({ graph, monitor, platform, log: platform.log });
  checks.addEventListener("busy", () => {
    syncCheckControls();
    renderResults();
  });
  voiceView = new VoiceView({
    $,
    graph,
    getSettings: () => settings,
    onChange: () => renderResults(),
    onLevels: () => {
      if (performance.now() - lastRenderMs >= RESULTS_EVERY_MS) renderResults({ periodic: true });
    },
  });
  voiceView.attach();
  voiceView.started();
  const starting = graph.start();
  voiceView.renderAll();
  return starting;
}

// Edge dev mode only: the page may play sound after one click (the app never needs it).
// Step 2's status line shows how the start goes.
$("btnStartVoice").addEventListener("click", () => {
  graph?.resumeFromGesture();
});

onSelect("micSelect", async (select) => {
  if (!graph) return;
  const id = select.value;
  const entry = (graph.snapshot?.usable ?? []).find((d) => d.deviceId === id);
  if (!entry) return;
  platform.log("info", "user mic");
  await makeChoice("mic", id, {
    save: () => saveSettings({ micDeviceId: id, micLabel: entry.label }),
    ask: () => graph.setMic(id),
  });
});

onSelect("outSelect", async (select) => {
  if (!graph) return;
  const id = select.value;
  const entry = id ? (graph.snapshot?.outputs ?? []).find((d) => d.deviceId === id) : null;
  if (id && !entry) return;
  platform.log("info", `user output ${id ? "chosen" : "auto"}`);
  await makeChoice("output", id, {
    save: () => saveSettings({ cableDeviceId: id, cableLabel: entry?.label ?? "" }),
    ask: () => graph.setOutput(id || null),
  });
});

// Advanced (diagnostics only, not saved): the audio element route.
onSelect("routeSelect", async (select) => {
  if (!graph) return;
  const value = select.value === "element" ? "element" : "auto";
  platform.log("info", `user route ${value}`);
  await makeChoice("route", value, { ask: () => graph.setRoutePreference(value) });
});

// "Check the microphone": a fresh look at the devices; no new microphone request when one is open.
action("btnMic", async () => {
  if (!graph) throw new Error(NOT_STARTED);
  setStatus("Checking the microphone…");
  await graph.retry();
  const mic = voiceView.microphoneCheck();
  if (mic) {
    results.microphone = mic;
    setStatus("Microphone checked.", "ok");
  } else {
    results.microphone = { ok: false, error: graph.state };
    setStatus(graph.stateInfo.text, "error");
  }
});

action("btnBeep", async () => {
  if (!monitor) throw new Error(NOT_STARTED);
  setStatus("Playing a test beep…");
  const at = new Date().toISOString();
  try {
    const r = await monitor.beep("test");
    results.checks.beep.push({ at, ok: true, sink: r.sink });
    setStatus("Beep played in your headphones. The meeting can't hear it.", "ok");
  } catch (err) {
    if (err?.name !== "MonitorError") {
      results.checks.beep.push({ at, ok: false, error: err?.name ?? "Error" });
      throw err;
    }
    results.checks.beep.push({ at, ok: false, error: err.code });
    setStatus(err.message, "warn");
    // A refusal while the headset is unplugged ends when the microphone is back: the line does not stay.
    if (err.code === "STAND_IN_QUIET") clearWhenHeadsetBack(statusCount);
  }
});

/** After a beep refused while the headset was unplugged: clear the line once no microphone stands in any more. */
function clearWhenHeadsetBack(mine) {
  if (!graph) return;
  const controller = new AbortController();
  statusWatch = controller;
  const check = () => {
    if (statusCount !== mine) {
      controller.abort();
      return;
    }
    if (graph.mic && !graph.mic.standIn) {
      controller.abort();
      setStatus("Your headset is back: sounds play in your headphones again.", "ok");
    }
  };
  graph.addEventListener("mic", check, { signal: controller.signal });
  graph.addEventListener("warnings", check, { signal: controller.signal });
}

// ---------- 3 · checks for the meeting ----------

/** The check buttons and the device choices follow the check that runs (one at a time). */
function syncCheckControls() {
  const busy = checks?.busy ?? null;
  voiceView?.setChecksBusy(busy);
  $("longSource").disabled = Boolean(busy);
  $("longMinutes").disabled = Boolean(busy);
  for (const [id, usable] of [
    ["btnMeasure", canStartCheck],
    ["btnLongStart", canStartCheck],
    ["btnLongStop", canStopLong],
  ]) {
    const button = $(id);
    if (!button.dataset.busy) button.disabled = !usable();
  }
}
const canStartCheck = () => !checks?.busy;
const canStopLong = () => checks?.busy === "long" && longHandle !== null;

action(
  "btnMeasure",
  async () => {
    if (!checks) throw new Error(NOT_STARTED);
    setStatus("Measuring the delay…");
    let r;
    try {
      r = await checks.measureDelay({ onProgress: (secondsLeft) => checksView.delayProgress(secondsLeft) });
    } catch (err) {
      checksView.delayFailed(messageOf(err));
      throw err;
    }
    results.checks.delay.push(r);
    checksView.delayDone(r);
    setStatus("Delay measured.", delayKind(r.verdict), { record: false });
  },
  { usable: canStartCheck },
);

action(
  "btnLongStart",
  async () => {
    if (!checks) throw new Error(NOT_STARTED);
    const mode = $("longSource").value === "mic" ? "mic" : "tone";
    const minutes = Number($("longMinutes").value);
    setStatus("Starting the long check…");
    checksView.longStarting();
    let handle;
    try {
      handle = await checks.startLong({ mode, minutes, onProgress: (p) => checksView.longProgress(p) });
    } catch (err) {
      checksView.longFailed(messageOf(err));
      throw err;
    }
    longHandle = handle;
    syncCheckControls();
    handle.done.then((result) => {
      try {
        if (longHandle === handle) longHandle = null;
        results.checks.long.push(result);
        setStatus("Long check done.", checksView.longDone(result), { record: false });
      } catch (err) {
        recordError(`The long check's result could not be shown: ${err?.name ?? "Error"}`);
      } finally {
        syncCheckControls();
        renderResults();
      }
    });
    setStatus("Long check running…", "info");
  },
  { usable: canStartCheck },
);

action(
  "btnLongStop",
  async () => {
    const handle = longHandle;
    if (!handle) return;
    setStatus("Stopping the long check…");
    await handle.stop(); // its result is shown by the start's done handler
  },
  { usable: canStopLong },
);

action("btnHide", async () => {
  if (!checks) throw new Error(NOT_STARTED);
  setStatus("Hiding the app…");
  const r = await checks.hideFor(30);
  results.checks.hide.push(r);
  checksView.hideDone(r);
  // What happened, with its times: a line that stays true after the window is back.
  const hm = (iso) => clockText(Date.parse(iso), { seconds: false });
  setStatus(`The app hid itself at ${hm(r.at)}; it comes back by ${hm(r.showAt)}.`, "ok");
});

// ---------- 4 · key ----------

// Whether Remove key has something to remove: a key the app holds (in Edge
// dev mode the server holds it, and only the server can drop it).
let keyRemovable = false;

function updateRemoveButton() {
  const button = $("btnDeleteKey");
  button.disabled = Boolean(button.dataset.busy) || !keyRemovable;
}

/**
 * Show whether a key is saved. Only `saved` and `heldBy` are refreshed in
 * the results: what Save key learned (`checked`, `note`) stays, so the
 * copied results still say whether Sanas accepted the key.
 */
async function showKey() {
  try {
    const status = await platform.keyStatus();
    const earlier = { ...results.key };
    delete earlier.error; // the status could be read this time
    results.key = { ...earlier, saved: status.saved, heldBy: status.heldBy ?? "credential manager" };
    keyRemovable = status.saved && status.heldBy !== "server";
    $("keyInfo").textContent = status.saved
      ? status.heldBy === "server"
        ? "The dev server holds a key."
        : `A key is saved (ending in ${status.tail.replace("…", "")}).`
      : "No key saved yet.";
  } catch (err) {
    results.key = { ...results.key, error: err.message };
    // Also in errors, which keep it: a later read that works drops key.error.
    recordError(`Could not read the key status: ${err.message}`);
    // Unknown status: in the app, Remove key stays on, as removing an unreadable key may be the fix.
    keyRemovable = platform.name === "app";
    $("keyInfo").textContent = `Could not read the key status: ${err.message}`;
  }
  updateRemoveButton();
}

action("btnSaveKey", async () => {
  const input = $("key");
  const raw = input.value;
  input.value = ""; // the page doesn't keep it
  if (!raw.trim()) throw new Error("Paste your Sanas key into the box first, from where you saved it (for example your password manager).");
  setStatus("Checking the key with Sanas…");
  const saved = await platform.saveKey(raw);
  await showKey();
  // Added after showKey, which keeps it from then on: the copied results say
  // whether Sanas accepted this key or it was saved unchecked, and why.
  results.key = { ...results.key, checked: saved.checked, note: saved.note ?? null };
  if (saved.checked === "accepted") setStatus("Sanas accepted the key. It is saved in Windows Credential Manager.", "ok");
  else {
    const why = saved.note ? ` (${saved.note})` : "";
    setStatus(`Saved, but Sanas could not be asked right now${why}. Step 5 will tell whether it works.`, "warn");
  }
});

action(
  "btnDeleteKey",
  async () => {
    await platform.deleteKey();
    await disconnectSanas();
    results.key = null; // checked and note were about the key that is gone
    await showKey();
    setStatus("The key was removed from Windows Credential Manager.", "ok");
  },
  { usable: () => keyRemovable },
);

// ---------- 5 · connect only ----------

action("btnConnect", async () => {
  setStatus("Connecting to Sanas (no audio)…");
  $("connectInfo").textContent = "";
  await disconnectSanas(); // a fresh check every time
  try {
    const { initMs } = await connectSanas();
    results.sanas = { ok: true, initMs, origin: location.origin };
    $("connectInfo").textContent = `Connected in ${initMs} ms: Sanas accepts the key and this app's address (${location.origin}).`;
    $("connectInfo").dataset.kind = "ok";
    setStatus("Sanas: connect only worked.", "ok");
  } catch (err) {
    results.sanas = { ok: false, code: err.code ?? null, message: err.message, origin: location.origin };
    $("connectInfo").textContent = err.message;
    $("connectInfo").dataset.kind = "error";
    throw err;
  } finally {
    await disconnectSanas();
  }
});

// ---------- 6 · copy ----------

action("btnCopy", async () => {
  renderResults({ force: true });
  const pre = $("results");
  try {
    await navigator.clipboard.writeText(pre.textContent);
    platform.log("info", "results copied");
    $("copyInfo").textContent = "Copied. Paste it into your message.";
  } catch {
    // Select the results alone. Ctrl+A would take the whole page, and step 2 shows the devices' real names.
    platform.log("warn", "results copy failed");
    pre.closest("details").open = true;
    const range = document.createRange();
    range.selectNodeContents(pre);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    $("copyInfo").textContent = "Could not copy by itself. The results below are selected: press Ctrl+C to copy them.";
  }
});

// ---------- start ----------

// The CSP blocked something: kept in the results (redacted), and its directive in the log.
document.addEventListener("securitypolicyviolation", (e) => {
  results.csp.push(redact(`${e.violatedDirective} ${e.blockedURI}`));
  platform.log("warn", `csp ${e.violatedDirective}`);
  renderResults();
});

window.addEventListener("pagehide", () => {
  const quietly = (fn) => {
    try {
      Promise.resolve(fn()).catch(() => {});
    } catch {
      // The page is going away: nothing more to do.
    }
  };
  quietly(() => checks?.stop());
  quietly(() => graph?.stop());
  quietly(() => monitor?.close());
  quietly(() => disconnectSanas());
});

await showApp();
await showKey();
await loadSettings();
renderResults();
if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
  setStatus("This page is not a secure page, so the microphone can't work here. Write that in your notes.", "error");
} else {
  await startVoice();
  syncCheckControls();
  setStatus("Ready. Step 2 shows where your voice goes; step 3 has the Session B checks.", "info");
}
