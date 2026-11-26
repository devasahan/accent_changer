import test from "node:test";
import assert from "node:assert/strict";
import { REDACTED, redact, redactObject } from "../src/core/redact.js";
import { rng } from "./helpers/synth.js";

const rand = rng(7);
const pick = (chars, n) => Array.from({ length: n }, () => chars[Math.floor(rand() * chars.length)]).join("");
const B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const B64URL = `${B62}-_`;

// A realistic HS256 token: {"alg":"HS256","typ":"JWT"} . {"sub":"…","iat":…} . signature
const JWT = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1XzQ4MTUxNjIzNDIiLCJpYXQiOjE3OTU2MDAwMDB9.${pick(B64URL, 43)}`;
const DEVICE_ID = pick("0123456789abcdef", 64);

/** Every secret gone, and redacting again changes nothing. */
function scrubbed(text, secrets) {
  const out = redact(text);
  for (const s of secrets) assert.ok(!out.includes(s), `"${s}" still in: ${out}`);
  assert.ok(out.includes(REDACTED), out);
  assert.equal(redact(out), out, "redacting twice changes nothing more");
  return out;
}

test("JWTs, in text, URLs and unsigned", () => {
  assert.equal(scrubbed(`token ${JWT} expires soon`, [JWT.slice(0, 20), JWT.slice(-20)]), `token ${REDACTED} expires soon`);
  scrubbed(`wss://example.test/ws?jwt=${JWT}&x=1`, [JWT.slice(-20)]);
  assert.equal(redact("eyJhbGciOiJub25lIn0.eyJzdWIiOiJhIn0."), REDACTED, "alg none: empty signature");
});

test('"Bearer <token>" and Authorization headers keep the scheme, lose the credentials', () => {
  assert.equal(redact(`Authorization: Bearer ${JWT}`), `Authorization: Bearer ${REDACTED}`);
  assert.equal(redact('{"Authorization":"Bearer secret-token"}'), `{"Authorization":"Bearer ${REDACTED}"}`);
  assert.equal(redact("headers: authorization=Basic dXNlcjpwYXNzd29yZA=="), `headers: authorization=Basic ${REDACTED}`);
  assert.equal(redact("sent with bearer abcDEF123456"), `sent with bearer ${REDACTED}`);
  assert.equal(redact("Authorization: ab12"), `Authorization: ${REDACTED}`, "short credentials too, in a header");
  // English is not a token.
  for (const line of ["the bearer of bad news", "Authorization header missing", "authorization failed"]) assert.equal(redact(line), line);
});

test("API keys: sk_/pk_ keys and any run of 32 or more key characters", () => {
  for (const key of ["sk_test_DO_NOT_LEAK_123", "sk_live_AbC123xyz0987654321", "pk_live_51HqLyjWDarjtT1zdp7dc", "sk-proj-abcdEFGH1234"]) {
    assert.equal(scrubbed(`key ${key}.`, [key]), `key ${REDACTED}.`);
  }
  for (let n = 0; n < 200; n++) {
    const key = pick(B64URL, 32 + Math.floor(rand() * 40));
    assert.equal(redact(`"${key}"`), `"${REDACTED}"`, key);
  }
  const short = pick(B62, 31); // a 31-character word is left alone
  assert.equal(redact(`id ${short}`), `id ${short}`);
  for (const line of ["task_force_alpha", "disk_usage_percent_high", "-".repeat(60), "_".repeat(40)]) assert.equal(redact(line), line);
});

test("device ids (64 hex) and UUIDs", () => {
  assert.equal(scrubbed(`mic ${DEVICE_ID} opened`, [DEVICE_ID]), `mic ${REDACTED} opened`);
  assert.equal(redact(`{"deviceId":"${DEVICE_ID}"}`), `{"deviceId":"${REDACTED}"}`);
  assert.equal(redact("session 123e4567-e89b-12d3-a456-426614174000 up"), `session ${REDACTED} up`);
  assert.equal(redact("call {9F2C4A10-3B7D-4E21-A6C8-0D1E2F3A4B5C}"), `call {${REDACTED}}`);
});

test("access_token, user_id, group_id and apiKey values, however short, in JSON and in log text", () => {
  // The identity service's answer (the shape the app's token provider returns).
  const response = '{"access_token":"t","user_id":"u1","group_id":"g1","expires_in":3600}';
  const hidden = redact(response);
  assert.deepEqual(JSON.parse(hidden), { access_token: REDACTED, user_id: REDACTED, group_id: REDACTED, expires_in: 3600 });
  // Numbers stay valid JSON; null, booleans and empty strings are not secrets.
  assert.deepEqual(JSON.parse(redact('{"user_id": 12345, "group_id": null, "apiKey": "", "ok": true}')), {
    user_id: REDACTED,
    group_id: null,
    apiKey: "",
    ok: true,
  });
  assert.deepEqual(JSON.parse(redact('{"apiKey":"sk_test_DO_NOT_LEAK_123","userId":"me","accessToken":"abc"}')), {
    apiKey: REDACTED,
    userId: REDACTED,
    accessToken: REDACTED,
  });
  // The SDK's own log line, a SIP parameter list, JS object text, a query string, JSON inside JSON.
  assert.equal(
    redact("Portal: session established (user_id=u1, group_id=g1)"),
    `Portal: session established (user_id=${REDACTED}, group_id=${REDACTED})`,
  );
  assert.equal(
    redact("X-Sanas-Params: model_file=AT5.2_Masculine;access_token=abc.def;group_id=g1"),
    `X-Sanas-Params: model_file=AT5.2_Masculine;access_token=${REDACTED};group_id=${REDACTED}`,
  );
  assert.equal(redact("{ access_token: 'abc', user_id: 'u1' }"), `{ access_token: '${REDACTED}', user_id: '${REDACTED}' }`);
  assert.equal(redact("http://localhost:8080/cb?access_token=abc&state=ok"), `http://localhost:8080/cb?access_token=${REDACTED}&state=ok`);
  const nested = JSON.stringify({ log: '{"access_token":"t1","user_id":"u1"}' });
  assert.deepEqual(JSON.parse(JSON.parse(redact(nested)).log), { access_token: REDACTED, user_id: REDACTED });
  // Passwords in URLs.
  assert.equal(redact("proxy https://alice:hunter2@proxy.example.test:8080/"), `proxy https://${REDACTED}@proxy.example.test:8080/`);
});

test("ordinary log lines are unchanged", () => {
  const lines = [
    "Run 3 · sanas 48 kHz",
    "D = 312 ms (score 0.82, onsets), p95 341 ms, 0 gaps",
    "delay 287.5 ms → lip sync 371 ms (p95 + 30)",
    "state converting → own-fault (stall at 4.27 s, healthy 3.1 s)",
    "2026-11-26T10:15:30.123Z engine media flowing, jitter 60 ms",
    "Sanas time this session: 12.4 min ≈ $0.112",
    "https://developer.sanas.ai/Docs/Resources/Pricing",
    "http://localhost:8080/spike/?run=3&rate=48000",
    "Allowed origins: http://tauri.localhost, https://tauri.localhost",
    "Microphone: Headset Microphone (Jabra EVOLVE 20 MS) · 48000 Hz · echo cancellation off",
    "Playback: CABLE Input (VB-Audio Virtual Cable)",
    "model AT5.2_Masculine at 16000 Hz",
    "Sanas could not start the call: Media connection lost [network_error].",
    "authentication_failed: Sanas refused the saved key (HTTP 401).",
    "token request failed (HTTP 503), retrying in 2 s",
    "user_id missing from the answer",
    "Got a 23-character key ending in …1234 (doubled).",
    "Error: NotAllowedError: Permission denied by system",
    "C:\\Users\\asha\\AppData\\Roaming\\com.accent-changer.app\\settings.json",
    "",
  ];
  for (const line of lines) assert.equal(redact(line), line);
  assert.equal(redact(lines.join("\n")), lines.join("\n"), "multi-line text too");
});

test("large and odd inputs stay fast (no quadratic search)", () => {
  // Each of these took 15-30 s with unbounded patterns; now a few ms each.
  const inputs = [
    "x." + "a.".repeat(100000), // a long dotted text (URL scheme search)
    "eyJ".repeat(100000), // "eyJ" over and over inside one run
    "sk-".repeat(100000),
    "token=".repeat(50000),
    "2026-11-26T10:15:30.123Z D = 312 ms user_id=u1 Bearer abcdefgh12345\n".repeat(10000),
  ];
  const t0 = performance.now();
  for (const s of inputs) redact(s);
  const ms = performance.now() - t0;
  assert.ok(ms < 2000, `${ms.toFixed(0)} ms`);
  assert.equal(redact("eyJ".repeat(20)), REDACTED, "the run itself is still hidden");
});

test("anything that is not text is made text first", () => {
  assert.equal(redact(null), "");
  assert.equal(redact(undefined), "");
  assert.equal(redact(42), "42");
  assert.equal(redact(new Error("key sk_live_AbC123xyz0987654321 refused")), `Error: key ${REDACTED} refused`);
});

test("redactObject: secret fields hidden, other strings scrubbed, a deep copy", () => {
  const input = {
    tool: "accent-changer diagnostics",
    schema: 1,
    key: { saved: true, heldBy: "credential manager", keyExpiresOn: "2027-11-26" },
    session: { access_token: "t", accessToken: "t2", refresh_token: "r", user_id: "u1", userId: 7, groupId: "g1", group_id: "g2" },
    more: { apiKey: "k", api_key: "k", "x-api-key": "k", clientSecret: "s", password: "p", credentials: { user: "me" }, cookie: "c" },
    secrets: { list: ["a", "b"] }, // a secret name hides the whole group
    devices: [{ deviceId: DEVICE_ID, label: "Headset Microphone (Jabra EVOLVE 20 MS)", micDeviceId: "m", groupLabel: "USB" }],
    headers: { Authorization: "Bearer secret-token", Accept: "application/json" },
    notes: `pasted by mistake: ${JWT}`,
    delays: [312, 298.5, 301],
    hotkeyOwn: "Ctrl+Alt+B",
    errors: [{ at: "2026-11-26T10:00:00.000Z", message: "token=abc expired" }],
  };
  const before = structuredClone(input);
  const out = redactObject(input);
  assert.deepEqual(input, before, "the input is not changed");
  assert.deepEqual(out, {
    tool: "accent-changer diagnostics",
    schema: 1,
    key: { saved: true, heldBy: "credential manager", keyExpiresOn: "2027-11-26" },
    session: { access_token: REDACTED, accessToken: REDACTED, refresh_token: REDACTED, user_id: REDACTED, userId: REDACTED, groupId: REDACTED, group_id: REDACTED },
    more: { apiKey: REDACTED, api_key: REDACTED, "x-api-key": REDACTED, clientSecret: REDACTED, password: REDACTED, credentials: REDACTED, cookie: REDACTED },
    secrets: REDACTED,
    devices: [{ deviceId: REDACTED, label: "Headset Microphone (Jabra EVOLVE 20 MS)", micDeviceId: REDACTED, groupLabel: "USB" }],
    headers: { Authorization: REDACTED, Accept: "application/json" },
    notes: `pasted by mistake: ${REDACTED}`,
    delays: [312, 298.5, 301],
    hotkeyOwn: "Ctrl+Alt+B",
    errors: [{ at: "2026-11-26T10:00:00.000Z", message: `token=${REDACTED} expired` }],
  });
  assert.notEqual(out.delays, input.delays);
  const json = JSON.stringify(out);
  for (const s of ["secret-token", DEVICE_ID, JWT.slice(-20), '"u1"', '"g1"']) assert.ok(!json.includes(s), s);
});

test("redactObject: empty values stay visible, odd values are copied safely", () => {
  assert.deepEqual(redactObject({ token: null, apiKey: "", deviceId: undefined, tokenSaved: false }), {
    token: null,
    apiKey: "",
    deviceId: undefined,
    tokenSaved: false,
  });
  const err = Object.assign(new Error("Sanas refused sk_live_AbC123xyz0987654321"), { code: "authentication_failed", token: "t" });
  assert.deepEqual(redactObject(err), { name: "Error", message: `Sanas refused ${REDACTED}`, code: "authentication_failed", token: REDACTED });
  assert.equal(redactObject(new Date(Date.UTC(2026, 10, 26))), "2026-11-26T00:00:00.000Z");
  assert.equal(redactObject(new URL("https://example.test/a?access_token=abc")), `https://example.test/a?access_token=${REDACTED}`);
  assert.deepEqual(redactObject(new Map([["user_id", "u1"], ["label", "Jabra"]])), [["user_id", REDACTED], ["label", "Jabra"]]);
  assert.deepEqual(redactObject(new Set(["ok", "sk_live_AbC123xyz0987654321"])), ["ok", REDACTED]);
  const levels = Float32Array.from([-30, -42]);
  const copied = redactObject({ levels });
  assert.deepEqual(copied.levels, levels);
  assert.notEqual(copied.levels, levels);
  assert.deepEqual(redactObject({ onState() {}, n: 1n }), { onState: undefined, n: 1n });
  // Cycles end; a shared (not circular) object is copied twice; "__proto__" stays a plain key.
  const loop = { name: "a" };
  loop.self = loop;
  assert.deepEqual(redactObject(loop), { name: "a", self: "[circular]" });
  const shared = { v: 1 };
  assert.deepEqual(redactObject({ a: shared, b: shared }), { a: { v: 1 }, b: { v: 1 } });
  const proto = redactObject(JSON.parse('{"__proto__": {"polluted": true}}'));
  assert.equal(Object.getPrototypeOf(proto), Object.prototype);
  assert.deepEqual(Object.keys(proto), ["__proto__"]);
  assert.equal({}.polluted, undefined);
  // A key that is itself a secret is scrubbed too.
  assert.deepEqual(Object.keys(redactObject({ [DEVICE_ID]: "Jabra" })), [REDACTED]);
  for (const v of [undefined, null, 3, "plain", true]) assert.equal(redactObject(v), v);
});
