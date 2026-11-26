import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, SECRET_MESSAGE, normalizeHotkey, validateSettings } from "../src/core/settings.js";

const VOICE_MISSING = /voice type/i;

/** Every setting given, all of them different from the defaults. */
const complete = () => ({
  version: 1,
  micDeviceId: "5f0c3a9de1b24c7a8e6f0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e",
  micLabel: "Headset Microphone (Jabra EVOLVE 20 MS)",
  cableDeviceId: "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b",
  cableLabel: "CABLE Input (VB-Audio Virtual Cable)",
  modelName: "AT5.2_Masculine",
  voiceType: "masculine",
  sampleRate: 16000,
  mode: "practice",
  hotkeyOwn: "Ctrl+Alt+O",
  hotkeyConvert: "Ctrl+Shift+F9",
  startWithWindows: false,
  lipSync: { enabled: true, totalMs: 420, obsOffsetMs: -40 },
  budget: { capUsd: 25, keyExpiresOn: "2027-11-26" },
  obsPath: "C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe",
});

/** validateSettings on the defaults with some settings changed. */
const withSettings = (changes) => validateSettings({ ...complete(), ...changes });

test("DEFAULTS are the spec's values and frozen all the way down", () => {
  assert.deepEqual(DEFAULTS, {
    version: 1,
    micDeviceId: "",
    micLabel: "",
    cableDeviceId: "",
    cableLabel: "",
    modelName: "AT5.2",
    voiceType: null,
    sampleRate: 48000,
    mode: "interview",
    hotkeyOwn: "Ctrl+Alt+B",
    hotkeyConvert: "Ctrl+Alt+N",
    startWithWindows: true,
    lipSync: { enabled: false, totalMs: null, obsOffsetMs: 0 },
    budget: { capUsd: 10, keyExpiresOn: null },
    obsPath: "",
  });
  assert.ok(Object.isFrozen(DEFAULTS) && Object.isFrozen(DEFAULTS.lipSync) && Object.isFrozen(DEFAULTS.budget));
  assert.throws(() => {
    DEFAULTS.lipSync.enabled = true;
  }, TypeError);
});

test("no settings yet: the defaults, not ready until the voice type is chosen", () => {
  for (const input of [undefined, null, {}]) {
    const { settings, errors, ready } = validateSettings(input);
    assert.deepEqual(settings, DEFAULTS);
    assert.equal(ready, false);
    assert.equal(errors.length, 1, String(input));
    assert.match(errors[0], VOICE_MISSING);
  }
  const chosen = validateSettings({ voiceType: "feminine" });
  assert.deepEqual(chosen.errors, []);
  assert.equal(chosen.ready, true);
  assert.deepEqual(chosen.settings, { ...DEFAULTS, voiceType: "feminine" });
});

test("a complete, valid file comes back the same, with no errors", () => {
  const { settings, errors, ready } = validateSettings(complete());
  assert.deepEqual(errors, []);
  assert.equal(ready, true);
  assert.deepEqual(settings, complete());
  // Partial groups are filled in from the defaults.
  const partial = validateSettings({ voiceType: "masculine", lipSync: { enabled: true }, budget: { capUsd: 5 } });
  assert.deepEqual(partial.settings.lipSync, { enabled: true, totalMs: null, obsOffsetMs: 0 });
  assert.deepEqual(partial.settings.budget, { capUsd: 5, keyExpiresOn: null });
  assert.deepEqual(partial.errors, []);
});

test("the result is a new object: changing it changes neither the input nor the defaults", () => {
  const input = complete();
  const { settings } = validateSettings(input);
  settings.lipSync.totalMs = 1;
  settings.budget.capUsd = 1;
  settings.micLabel = "changed";
  assert.deepEqual(input, complete());
  const fresh = validateSettings(undefined).settings;
  fresh.lipSync.enabled = true;
  fresh.budget.keyExpiresOn = "2030-01-01";
  assert.equal(DEFAULTS.lipSync.enabled, false);
  assert.equal(DEFAULTS.budget.keyExpiresOn, null);
  assert.notEqual(validateSettings(undefined).settings.lipSync, validateSettings(undefined).settings.lipSync);
});

test("unknown names are dropped without fuss; version is always 1", () => {
  const { settings, errors } = withSettings({
    theme: "dark",
    windowX: 120,
    version: 7,
    lipSync: { ...complete().lipSync, autoTune: true },
    budget: { ...complete().budget, currency: "INR" },
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(settings, complete());
});

test("anything that looks like a key, token or password is dropped and reported, at any depth", () => {
  const secret = "sk_live_DO_NOT_SAVE_1234567890";
  const { settings, errors, ready } = withSettings({
    apiKey: secret,
    sanasToken: "tok-123",
    password: "hunter2",
    credentials: { user: "me" },
    lipSync: { ...complete().lipSync, secret: "x" },
    budget: { ...complete().budget, apiKey: secret },
    sanas: { nested: [{ access_token: "eyJhbGciOi.eyJzdWIi.c2ln" }] },
  });
  assert.equal(ready, true, "a dropped key does not stop the app");
  assert.deepEqual(settings, complete(), "nothing key-like is kept");
  const reported = errors.map((e) => /^Removed "([^"]+)"/.exec(e)?.[1]).sort();
  const expected = ["apiKey", "sanasToken", "password", "credentials", "lipSync.secret", "budget.apiKey", "sanas.nested.0.access_token"];
  assert.deepEqual(reported, expected.sort());
  for (const e of errors) {
    assert.ok(e.includes(SECRET_MESSAGE), e);
    assert.ok(!e.includes(secret) && !e.includes("hunter2") && !e.includes("tok-123"), `no value in: ${e}`);
  }
  assert.equal(SECRET_MESSAGE, "API keys are kept in Windows Credential Manager, not in settings");
  // The three known names with "key" in them are settings, not secrets.
  const known = withSettings({ hotkeyOwn: "Ctrl+Alt+K", hotkeyConvert: "Ctrl+Alt+J", budget: { capUsd: 10, keyExpiresOn: "2027-01-31" } });
  assert.deepEqual(known.errors, []);
  assert.equal(known.settings.hotkeyOwn, "Ctrl+Alt+K");
  assert.equal(known.settings.budget.keyExpiresOn, "2027-01-31");
  // A key pasted into the model name (both come from the Sanas Console) is not saved either.
  const pasted = withSettings({ modelName: secret });
  assert.equal(pasted.settings.modelName, "AT5.2");
  assert.equal(pasted.errors.length, 1);
  assert.ok(pasted.errors[0].includes("Credential Manager") && !pasted.errors[0].includes(secret), pasted.errors[0]);
});

test("a key pasted into the OBS path or a device label is not kept either; ordinary paths and labels are", () => {
  const secret = "sk_live_DO_NOT_SAVE_1234567890";
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1In0.abcdefghijklmnopqrstuvwxyz012345678901234";
  const base64Key = "q7Wz/9Kd+3LmNp2Rs8Tv4Xy6Ab1Cd5Ef7Gh9Ij+Kl0M=";
  for (const [name, value] of [
    ["obsPath", secret],
    ["obsPath", `C:\\obs\\${jwt}`],
    ["obsPath", base64Key],
    ["micLabel", `Bearer ${jwt}`],
    ["micLabel", secret],
    ["cableLabel", secret],
    ["cableLabel", `CABLE Input ${base64Key}`],
  ]) {
    const r = withSettings({ [name]: value });
    assert.equal(r.settings[name], "", `${name}: ${value}`);
    assert.equal(r.errors.length, 1, `${name}: ${value}`);
    assert.ok(r.errors[0].startsWith(`${name} looks like an API key`) && r.errors[0].includes(SECRET_MESSAGE), r.errors[0]);
    for (const part of [secret, jwt.slice(-20), base64Key.slice(5, 20)]) assert.ok(!r.errors[0].includes(part), `no value in: ${r.errors[0]}`);
    assert.equal(r.ready, true);
  }
  // Ordinary paths (backslashes or forward slashes, a Microsoft Store install, a portable copy) and labels stay.
  for (const obsPath of [
    "C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe",
    "C:/Program Files/obs-studio/bin/64bit/obs64.exe",
    "C:\\Program Files\\WindowsApps\\OBSProject.OBSStudio_30.2.3.0_x64__qyxnjnmr4kv5c\\bin\\64bit\\obs64.exe",
    "D:\\Tools\\OBS-Studio-30.2.3-Portable\\bin\\64bit\\obs64.exe",
    "\\\\studio-pc\\Shared\\OBS\\bin\\64bit\\obs64.exe",
  ]) {
    const r = withSettings({ obsPath });
    assert.deepEqual(r.errors, [], obsPath);
    assert.equal(r.settings.obsPath, obsPath);
  }
  for (const label of [
    "Default - Headset Microphone (Jabra EVOLVE 20 MS)",
    "Microphone Array (Realtek(R) Audio)",
    "Microphone (HD Pro Webcam C920) (046d:082d)",
    "Headset (WH-1000XM4 Hands-Free AG Audio)",
    "CABLE Input (VB-Audio Virtual Cable)",
  ]) {
    const r = withSettings({ micLabel: label, cableLabel: label });
    assert.deepEqual(r.errors, [], label);
    assert.equal(r.settings.micLabel, label);
  }
  // Device ids are 64 hex digits, which redact() hides in logs: as settings they are kept.
  assert.deepEqual(validateSettings(complete()).settings.micDeviceId, complete().micDeviceId);
});

test("the known names in other capitalisations are unknown names, not keys", () => {
  // "API keys are kept in Windows Credential Manager" would tell the user a key was in their file.
  for (const name of ["HotkeyOwn", "hotkeyown", "HOTKEYCONVERT", "KeyExpiresOn"]) {
    const r = withSettings({ [name]: "Ctrl+Alt+K", budget: { ...complete().budget, [name]: "2027-01-01" } });
    assert.deepEqual(r.errors, [], name);
    assert.deepEqual(r.settings, complete(), `${name} is dropped quietly, like any unknown name`);
  }
  assert.equal(withSettings({ ApiKey: "x" }).errors.length, 1, "a real key-like name is still reported");
});

test("hotkeys that would take a shortcut from Windows or other apps are refused", () => {
  // A hotkey is global: the meeting app, its chat and every other app stop seeing it.
  for (const taken of ["Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+Z", "Ctrl+Y", "Ctrl+A", "Ctrl+S", "ctrl+b", "Alt+F", "Win+L", "Super+D", "Shift+1", "Alt+F4", "Alt+Tab", "Alt+Space", "Ctrl+Esc", "Ctrl+Alt+Del", "Ctrl+Shift+Esc"]) {
    assert.equal(normalizeHotkey(taken), null, taken);
  }
  // Two modifiers with a letter, or a key that no app needs, are fine.
  for (const [given, canonical] of [
    ["Ctrl+Alt+V", "Ctrl+Alt+V"],
    ["Ctrl+Shift+C", "Ctrl+Shift+C"],
    ["Alt+Win+L", "Alt+Super+L"],
    ["Ctrl+F9", "Ctrl+F9"],
    ["Alt+F5", "Alt+F5"],
    ["Ctrl+Space", "Ctrl+Space"],
  ]) {
    assert.equal(normalizeHotkey(given), canonical, given);
  }
  const paste = withSettings({ hotkeyOwn: "Ctrl+V", hotkeyConvert: "Alt+F4" });
  assert.equal(paste.settings.hotkeyOwn, "Ctrl+Alt+B");
  assert.equal(paste.settings.hotkeyConvert, "Ctrl+Alt+N");
  assert.equal(paste.errors.length, 2);
  assert.match(paste.errors[0], /^hotkeyOwn must be keys no other app needs: .*Ctrl\+V would be taken .*two of Ctrl, Alt, Shift and Win.*using Ctrl\+Alt\+B\.$/);
  assert.match(paste.errors[1], /^hotkeyConvert must be keys no other app needs: .*Alt\+F4 would be taken .*Windows uses it.*using Ctrl\+Alt\+N\.$/);
});

test("voiceType must be masculine or feminine for ready", () => {
  for (const [value, expected] of [
    ["masculine", "masculine"],
    ["feminine", "feminine"],
    [" Feminine ", "feminine"],
    ["MASCULINE", "masculine"],
  ]) {
    const r = withSettings({ voiceType: value });
    assert.equal(r.settings.voiceType, expected);
    assert.equal(r.ready, true);
    assert.deepEqual(r.errors, []);
  }
  for (const value of ["male", "neutral", 1, true, {}]) {
    const r = withSettings({ voiceType: value });
    assert.equal(r.settings.voiceType, null, String(value));
    assert.equal(r.ready, false);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /voiceType must be "masculine" or "feminine"/);
  }
  for (const value of [null, ""]) {
    const r = withSettings({ voiceType: value });
    assert.equal(r.ready, false);
    assert.match(r.errors[0], VOICE_MISSING);
  }
});

test("sampleRate is 16000 or 48000, mode interview or practice", () => {
  assert.equal(withSettings({ sampleRate: 48000 }).settings.sampleRate, 48000);
  for (const sampleRate of [44100, 8000, "48000", 0, NaN]) {
    const r = withSettings({ sampleRate });
    assert.equal(r.settings.sampleRate, 48000, String(sampleRate));
    assert.deepEqual(r.errors, ["sampleRate must be 16000 or 48000; using 48000."]);
  }
  assert.equal(withSettings({ mode: "interview" }).settings.mode, "interview");
  assert.equal(withSettings({ mode: "Practice" }).settings.mode, "practice");
  for (const mode of ["karaoke", 1, ""]) {
    const r = withSettings({ mode });
    assert.equal(r.settings.mode, "interview");
    assert.equal(r.errors.length, 1);
  }
});

test("lipSync: totalMs empty or 0..800, a true/false switch, an OBS offset within a second", () => {
  const lip = (changes) => withSettings({ lipSync: { ...complete().lipSync, ...changes } });
  for (const totalMs of [null, 0, 800, 312.5]) {
    const r = lip({ totalMs });
    assert.equal(r.settings.lipSync.totalMs, totalMs);
    assert.deepEqual(r.errors, []);
  }
  for (const totalMs of [801, -1, "300", NaN, Infinity]) {
    const r = lip({ totalMs });
    assert.equal(r.settings.lipSync.totalMs, null, String(totalMs));
    assert.deepEqual(r.errors, ["lipSync.totalMs must be empty or 0 to 800 ms; it was cleared."]);
  }
  const notBool = lip({ enabled: "yes" });
  assert.equal(notBool.settings.lipSync.enabled, false);
  assert.deepEqual(notBool.errors, ["lipSync.enabled must be true or false; using false."]);
  assert.equal(lip({ obsOffsetMs: 1000 }).settings.lipSync.obsOffsetMs, 1000);
  const far = lip({ obsOffsetMs: -1001 });
  assert.equal(far.settings.lipSync.obsOffsetMs, 0);
  assert.equal(far.errors.length, 1);
  const notGroup = withSettings({ lipSync: "on" });
  assert.deepEqual(notGroup.settings.lipSync, DEFAULTS.lipSync);
  assert.deepEqual(notGroup.errors, ["lipSync must be a group of settings; using the defaults."]);
});

test("budget: a cap above $0, the key's expiry as YYYY-MM-DD or empty", () => {
  const budget = (changes) => withSettings({ budget: { ...complete().budget, ...changes } });
  assert.equal(budget({ capUsd: 0.5 }).settings.budget.capUsd, 0.5);
  for (const capUsd of [0, -5, "10", Infinity, NaN]) {
    const r = budget({ capUsd });
    assert.equal(r.settings.budget.capUsd, 10, String(capUsd));
    assert.deepEqual(r.errors, ["budget.capUsd must be more than $0; using $10."]);
  }
  assert.equal(budget({ keyExpiresOn: " 2028-02-29 " }).settings.budget.keyExpiresOn, "2028-02-29");
  for (const keyExpiresOn of [null, ""]) {
    const r = budget({ keyExpiresOn });
    assert.equal(r.settings.budget.keyExpiresOn, null);
    assert.deepEqual(r.errors, []);
  }
  for (const keyExpiresOn of ["2027-02-29", "2027-13-01", "26/11/2027", "2027-11-26T00:00:00Z", 20271126]) {
    const r = budget({ keyExpiresOn });
    assert.equal(r.settings.budget.keyExpiresOn, null, String(keyExpiresOn));
    assert.deepEqual(r.errors, ["budget.keyExpiresOn must be a date like 2027-11-26; it was cleared."]);
  }
  assert.deepEqual(withSettings({ budget: 10 }).settings.budget, DEFAULTS.budget);
});

test("hotkeys: modifiers and one key, written the same way every time", () => {
  const same = {
    "Ctrl+Alt+B": "Ctrl+Alt+B",
    "ctrl + alt + b": "Ctrl+Alt+B",
    "Alt+Ctrl+F9": "Ctrl+Alt+F9",
    "Control+Shift+space": "Ctrl+Shift+Space",
    "CmdOrCtrl+Alt+KeyM": "Ctrl+Alt+M",
    "Win+Shift+M": "Shift+Super+M",
    "Shift+F9": "Shift+F9",
    "Ctrl+Alt+Digit1": "Ctrl+Alt+1",
    "Alt+PgUp": "Alt+PageUp",
    "Ctrl+Alt+ArrowLeft": "Ctrl+Alt+Left",
    "Ctrl+Alt+Num5": "Ctrl+Alt+Numpad5",
    "Ctrl+-": "Ctrl+Minus",
    "Super+Esc": "Super+Escape",
  };
  for (const [given, canonical] of Object.entries(same)) assert.equal(normalizeHotkey(given), canonical, given);
  const wrong = [
    "B", // no modifier: it would fire while typing
    "Shift+B", // Shift alone with a typing key: a capital B
    "Shift+Space",
    "Ctrl+Alt", // no key
    "Ctrl+A+B", // two keys
    "Ctrl+Ctrl+B",
    "Ctrl+Alt+Foo",
    "Ctrl+Alt+F25",
    "Ctrl++B",
    "Ctrl+Alt+",
    "",
    42,
    null,
  ];
  for (const given of wrong) assert.equal(normalizeHotkey(given), null, String(given));

  const tidy = withSettings({ hotkeyOwn: "alt + ctrl + o", hotkeyConvert: "ctrl+shift+f9" });
  assert.deepEqual(tidy.errors, []);
  assert.equal(tidy.settings.hotkeyOwn, "Ctrl+Alt+O");
  assert.equal(tidy.settings.hotkeyConvert, "Ctrl+Shift+F9");
  const bad = withSettings({ hotkeyOwn: "Shift+B" });
  assert.equal(bad.settings.hotkeyOwn, "Ctrl+Alt+B");
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0], /^hotkeyOwn must be .*using Ctrl\+Alt\+B\.$/);
  // The same keys for both can't work: both go back to the defaults (which differ).
  const clash = withSettings({ hotkeyOwn: "Ctrl+Alt+X", hotkeyConvert: "Alt+Ctrl+x" });
  assert.equal(clash.settings.hotkeyOwn, "Ctrl+Alt+B");
  assert.equal(clash.settings.hotkeyConvert, "Ctrl+Alt+N");
  assert.equal(clash.errors.length, 1);
  assert.match(clash.errors[0], /same keys/);
  const swapped = withSettings({ hotkeyOwn: "Ctrl+Alt+N", hotkeyConvert: "Ctrl+Alt+B" });
  assert.deepEqual(swapped.errors, [], "swapping the two defaults is fine");
});

test("text settings, the model name and the start-up switch", () => {
  const wrongType = withSettings({ micDeviceId: 42, cableLabel: ["CABLE Input"] });
  assert.equal(wrongType.settings.micDeviceId, "");
  assert.equal(wrongType.settings.cableLabel, "");
  assert.deepEqual(wrongType.errors, ["micDeviceId must be text; it was cleared.", "cableLabel must be text; it was cleared."]);
  assert.deepEqual(withSettings({ micLabel: null }).errors, [], "null text is just empty");
  assert.equal(withSettings({ modelName: " AT5.2_Feminine " }).settings.modelName, "AT5.2_Feminine");
  assert.equal(withSettings({ modelName: "" }).settings.modelName, "AT5.2");
  assert.deepEqual(withSettings({ modelName: "" }).errors, []);
  for (const modelName of ["AT5.2; rm -rf /", "AT 5.2", 5.2, ".hidden"]) {
    const r = withSettings({ modelName });
    assert.equal(r.settings.modelName, "AT5.2", String(modelName));
    assert.equal(r.errors.length, 1);
  }
  const yes = withSettings({ startWithWindows: "yes" });
  assert.equal(yes.settings.startWithWindows, true);
  assert.deepEqual(yes.errors, ["startWithWindows must be true or false; using true."]);
});

test("input that is not a settings object gives the defaults and says so", () => {
  for (const input of [[], "{\"voiceType\":\"masculine\"}", 42, true]) {
    const { settings, errors, ready } = validateSettings(input);
    assert.deepEqual(settings, DEFAULTS);
    assert.equal(ready, false);
    assert.equal(errors[0], "The settings could not be read, so the defaults are used.");
    assert.match(errors[1], VOICE_MISSING);
  }
  // A cycle (only possible from code, not from a file) does not hang the key search.
  const loop = { voiceType: "masculine" };
  loop.self = loop;
  assert.equal(validateSettings(loop).ready, true);
});
