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
import { validateSettings } from "./core/settings.js";
import { redact, redactObject } from "./core/redact.js";
import { gateSummary } from "./core/cable-check.js";
import { VoiceGraph } from "./audio/graph.js";
import { Monitor } from "./audio/monitor.js";
import { Checks } from "./audio/measure.js";
import { VoiceView, fillList } from "./ui/voice.js";
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

function recordError(message) {
  results.errors.push({ at: new Date().toISOString(), message });
}

function setStatus(message, kind = "info") {
  const el = $("status");
  el.textContent = message;
  el.dataset.kind = kind;
  if (kind === "error") recordError(message);
  renderResults();
}

/** The results as "Copy results" gives them: drawn afresh, then passed through redactObject. */
function renderResults() {
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
  $("results").textContent = JSON.stringify(redactObject(results), null, 2);
  lastRenderMs = performance.now();
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
  const checked = validateSettings(raw);
  settings = checked.settings;
  const source = error ? "unreadable" : raw === null ? "none" : typeof raw === "object" && !Array.isArray(raw) ? "saved" : "unreadable";
  results.settings = { source, errors: error ? [error, ...checked.errors] : checked.errors };
  platform.log("info", `settings ${source}`);
}

/**
 * Change and save the settings. A failure to save does not stop the change:
 * it applies until the app closes. → null, or why the settings could not be saved
 */
async function saveSettings(changes) {
  settings = validateSettings({ ...settings, ...changes }).settings;
  try {
    await platform.saveSettings(settings);
    return null;
  } catch (err) {
    platform.log("warn", "settings save failed");
    return messageOf(err);
  }
}

/** The status after a change of device: done or not, and whether it could be saved (the app keeps going either way). */
function changeStatus(ok, done, failed, notSaved) {
  const saveText = notSaved ? ` Could not save the settings: ${notSaved}` : "";
  if (!ok) setStatus(failed + saveText, "warn");
  else setStatus(done + saveText, notSaved ? "warn" : "ok");
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
      if (performance.now() - lastRenderMs >= RESULTS_EVERY_MS) renderResults();
    },
  });
  voiceView.attach();
  voiceView.started();
  const starting = graph.start();
  voiceView.renderAll();
  return starting;
}

// Edge dev mode only: the page may play sound after one click (the app never needs it).
$("btnStartVoice").addEventListener("click", () => {
  graph?.resumeFromGesture();
  setStatus("Starting your voice…");
});

onSelect("micSelect", async (select) => {
  if (!graph) return;
  const id = select.value;
  const entry = (graph.snapshot?.usable ?? []).find((d) => d.deviceId === id);
  if (!entry) return;
  voiceView.pendingMic = id;
  setStatus("Switching the microphone…");
  platform.log("info", "user mic");
  try {
    const notSaved = await saveSettings({ micDeviceId: id, micLabel: entry.label });
    const r = await graph.setMic(id);
    changeStatus(r.ok, "Microphone switched.", "The microphone could not be switched: see step 2.", notSaved);
  } finally {
    if (voiceView.pendingMic === id) voiceView.pendingMic = null;
    voiceView.renderSelects();
  }
});

onSelect("outSelect", async (select) => {
  if (!graph) return;
  const id = select.value;
  const entry = id ? (graph.snapshot?.outputs ?? []).find((d) => d.deviceId === id) : null;
  if (id && !entry) return;
  setStatus("Switching where your voice goes…");
  platform.log("info", `user output ${id ? "chosen" : "auto"}`);
  const notSaved = await saveSettings({ cableDeviceId: id, cableLabel: entry?.label ?? "" });
  const r = await graph.setOutput(id || null);
  changeStatus(r.ok, "Switched where your voice goes.", "That device could not be used: see step 2.", notSaved);
});

// Advanced (diagnostics only, not saved): the audio element route.
onSelect("routeSelect", async (select) => {
  if (!graph) return;
  const value = select.value === "element" ? "element" : "auto";
  setStatus("Switching the output route…");
  platform.log("info", `user route ${value}`);
  const r = await graph.setRoutePreference(value);
  setStatus(r.ok ? "Output route switched." : "The output route could not be switched: see step 2.", r.ok ? "ok" : "warn");
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
  }
});

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
    setStatus("Delay measured.", delayKind(r.verdict));
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
        setStatus("Long check done.", checksView.longDone(result));
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
  setStatus("The app was hidden for 30 minutes.", "ok");
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
  renderResults();
  const text = $("results").textContent;
  platform.log("info", "results copied");
  try {
    await navigator.clipboard.writeText(text);
    $("copyInfo").textContent = "Copied. Paste it into your message.";
  } catch {
    $("results").closest("details").open = true;
    $("copyInfo").textContent = "Could not copy by itself: select the text below and copy it (Ctrl+A, Ctrl+C).";
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
