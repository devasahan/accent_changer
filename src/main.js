/**
 * The app's first page: diagnostics for the test build (plan Step 1).
 * It checks, without spending Sanas minutes, what the rest of the app
 * depends on: a secure page, the microphone without a prompt, the key in
 * Windows Credential Manager, and Sanas accepting this app's address.
 * "Copy results" gives a summary with no key, token or device ids in it.
 */
import { platform } from "./platform/index.js";
import { configureSanas, connectSanas, disconnectSanas } from "./engines/sanas.js";

const $ = (id) => document.getElementById(id);

const results = {
  tool: "accent-changer diagnostics",
  schema: 1,
  at: null,
  shell: platform.name,
  app: null,
  page: null,
  microphone: null,
  key: null,
  sanas: null,
  errors: [],
};

configureSanas({ tokenProvider: platform.tokenProvider, where: platform.name === "app" ? "app" : "probe" });

function setStatus(message, kind = "info") {
  const el = $("status");
  el.textContent = message;
  el.dataset.kind = kind;
  if (kind === "error") results.errors.push({ at: new Date().toISOString(), message });
  renderResults();
}

function renderResults() {
  results.at = new Date().toISOString();
  $("results").textContent = JSON.stringify(results, null, 2);
}

function fillList(dl, pairs) {
  dl.replaceChildren(
    ...pairs.flatMap(([term, value]) => {
      const dt = document.createElement("dt");
      dt.textContent = term;
      const dd = document.createElement("dd");
      if (Array.isArray(value)) {
        const ul = document.createElement("ul");
        ul.append(...value.map((v) => Object.assign(document.createElement("li"), { textContent: v })));
        dd.append(value.length ? ul : "none");
      } else dd.textContent = String(value);
      return [dt, dd];
    }),
  );
}

/** Run a button's action once at a time, errors shown in the status line. */
function action(id, fn) {
  const button = $(id);
  button.addEventListener("click", async () => {
    if (button.disabled) return;
    button.disabled = true;
    try {
      await fn();
    } catch (err) {
      console.error(err);
      setStatus(err?.message ?? String(err), "error");
    } finally {
      button.disabled = false;
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
    results.app = await platform.appInfo();
    results.app.roundTripMs = Math.round(performance.now() - t0);
  } catch (err) {
    results.app = { error: err.message };
  }
  fillList($("appInfo"), [
    ["Version", results.app.version ? `${results.app.name} ${results.app.version}` : `error: ${results.app.error}`],
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

// ---------- 2 · microphone ----------

function micErrorText(err) {
  const name = err?.name ?? "";
  const message = err?.message ?? String(err);
  if (name === "NotAllowedError" && /system/i.test(message)) {
    return "Windows blocked the microphone: Settings → Privacy & security → Microphone → turn on microphone access and “Let desktop apps access your microphone”, then try again.";
  }
  if (name === "NotAllowedError") return "The microphone was refused for this app. Write that in your notes.";
  if (name === "NotReadableError" || name === "AbortError") {
    return "The microphone could not be opened: another app may be holding it. Close apps that use it and try again.";
  }
  if (name === "NotFoundError") return "No microphone was found. Plug in your headset and try again.";
  return `Microphone error: ${message}`;
}

action("btnMic", async () => {
  setStatus("Opening the microphone…");
  const t0 = performance.now();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (err) {
    results.microphone = { ok: false, error: err?.name ?? "error" };
    throw new Error(micErrorText(err));
  }
  const ms = Math.round(performance.now() - t0);
  const track = stream.getAudioTracks()[0];
  const s = track.getSettings();
  stream.getTracks().forEach((t) => t.stop());
  const devices = await navigator.mediaDevices.enumerateDevices();
  const labels = (kind) => devices.filter((d) => d.kind === kind && !["default", "communications"].includes(d.deviceId)).map((d) => d.label || "(no name)");
  const microphones = labels("audioinput");
  const outputs = labels("audiooutput");
  results.microphone = {
    ok: true,
    openedInMs: ms,
    used: track.label,
    echoCancellation: s.echoCancellation ?? null,
    noiseSuppression: s.noiseSuppression ?? null,
    autoGainControl: s.autoGainControl ?? null,
    sampleRate: s.sampleRate ?? null,
    microphones,
    outputs,
    cableInputFound: outputs.some((l) => /cable input/i.test(l)),
  };
  const off = (v) => (v === false ? "off" : v === true ? "ON" : "unknown");
  fillList($("micInfo"), [
    ["Opened in", `${ms} ms${ms > 1500 ? " (slow: did a question appear?)" : ""}`],
    ["Microphone used", track.label || "(no name)"],
    ["Echo cancellation / noise suppression / auto gain", `${off(s.echoCancellation)} / ${off(s.noiseSuppression)} / ${off(s.autoGainControl)}`],
    ["Microphones", microphones],
    ["Playback devices", outputs],
    ["VB-CABLE", results.microphone.cableInputFound ? "installed (CABLE Input found)" : "not installed yet (needed later)"],
  ]);
  setStatus("Microphone checked.", "ok");
});

// ---------- 3 · key ----------

async function showKey() {
  try {
    const status = await platform.keyStatus();
    results.key = { saved: status.saved, heldBy: status.heldBy ?? "credential manager" };
    $("keyInfo").textContent = status.saved
      ? status.heldBy === "server"
        ? "The dev server holds a key."
        : `A key is saved (ending in ${status.tail.replace("…", "")}).`
      : "No key saved yet.";
    $("btnDeleteKey").disabled = !status.saved || status.heldBy === "server";
  } catch (err) {
    results.key = { error: err.message };
    $("keyInfo").textContent = `Could not read the key status: ${err.message}`;
  }
}

action("btnSaveKey", async () => {
  const input = $("key");
  const raw = input.value;
  input.value = ""; // the page doesn't keep it
  if (!raw.trim()) throw new Error("Paste the key from the Sanas Console into the box first.");
  setStatus("Checking the key with Sanas…");
  const saved = await platform.saveKey(raw);
  results.key = { saved: true, checked: saved.checked };
  await showKey();
  if (saved.checked === "accepted") setStatus("Sanas accepted the key. It is saved in Windows Credential Manager.", "ok");
  else setStatus(`Saved, but Sanas could not be asked right now (${saved.note}). Step 4 will tell whether it works.`, "warn");
});

action("btnDeleteKey", async () => {
  await platform.deleteKey();
  await disconnectSanas();
  await showKey();
  setStatus("The key was removed from Windows Credential Manager.", "ok");
});

// ---------- 4 · connect only ----------

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

// ---------- 5 · copy ----------

action("btnCopy", async () => {
  renderResults();
  const text = $("results").textContent;
  try {
    await navigator.clipboard.writeText(text);
    $("copyInfo").textContent = "Copied. Paste it into your message.";
  } catch {
    $("results").closest("details").open = true;
    $("copyInfo").textContent = "Could not copy by itself: select the text below and copy it (Ctrl+A, Ctrl+C).";
  }
});

// ---------- start ----------

window.addEventListener("pagehide", () => disconnectSanas());

await showApp();
await showKey();
renderResults();
if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
  setStatus("This page is not a secure page, so the microphone can't work here. Write that in your notes.", "error");
} else {
  setStatus("Ready. Start with step 2.", "info");
}
