import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  APP_ORIGINS,
  CONTROL_ORIGIN,
  CSP,
  checkKey,
  checkOrigin,
  cleanKeyInput,
  originReport,
  portFromArgs,
  runOriginCheck,
  startSpikeServer,
} from "../spike/serve.mjs";

const KEY = "sk_test_DO_NOT_LEAK_123";

/** Raw request (no URL normalisation, any Host / Origin). */
function request(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function withServer(options, fn) {
  const logs = [];
  const server = await startSpikeServer({ port: 0, log: (m) => logs.push(m), ...options });
  try {
    await fn(server.port, logs);
  } finally {
    await server.close();
  }
}

test("serves the probe page with a strict CSP, and the shared core code", async () => {
  await withServer({}, async (port) => {
    const page = await request(port, { path: "/spike/" });
    assert.equal(page.status, 200);
    assert.match(page.headers["content-type"], /text\/html/);
    assert.equal(page.headers["content-security-policy"], CSP);
    assert.match(page.body, /<title>Sanas Check<\/title>/);
    const core = await request(port, { path: "/src/core/wav.js" });
    assert.equal(core.status, 200);
    assert.match(core.headers["content-type"], /text\/javascript/);
    assert.equal(core.headers["x-content-type-options"], "nosniff");
    const root = await request(port, { path: "/" });
    assert.equal(root.status, 302);
    assert.equal(root.headers.location, "/spike/");
  });
});

test("only spike/ and src/ are reachable: no traversal, no other files", async () => {
  await withServer({}, async (port) => {
    for (const path of [
      "/package.json",
      "/.git/config",
      "/tests/serve.test.js",
      "/spike/../package.json",
      "/spike/%2e%2e/package.json",
      "/spike/..%2f..%2fpackage.json",
      "/spike/..%5c..%5cpackage.json",
      "/src/%00wav.js",
      "/spike/nothing-here.js",
      "/src/core/", // directory index that does not exist
    ]) {
      const r = await request(port, { path });
      assert.ok([400, 404].includes(r.status), `${path} → ${r.status}`);
    }
    const bad = await request(port, { path: "/spike/%E0%A4%A" });
    assert.equal(bad.status, 400);
  });
});

test("refuses other Host names (DNS rebinding) and non-GET methods for files", async () => {
  await withServer({}, async (port) => {
    const r = await request(port, { path: "/spike/", headers: { host: `evil.example:${port}` } });
    assert.equal(r.status, 421);
    const post = await request(port, { method: "POST", path: "/spike/" });
    assert.equal(post.status, 405);
    const ok = await request(port, { path: "/spike/", headers: { host: `127.0.0.1:${port}` } });
    assert.equal(ok.status, 200);
  });
});

test("/token needs POST, the page's own origin and the marker header", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response(JSON.stringify({ access_token: "t", user_id: "u", group_id: "g" }), { status: 200 });
  };
  await withServer({ getApiKey: () => KEY, fetchImpl }, async (port) => {
    const origin = `http://localhost:${port}`;
    assert.equal((await request(port, { path: "/token" })).status, 405);
    assert.equal((await request(port, { method: "POST", path: "/token" })).status, 403);
    assert.equal((await request(port, { method: "POST", path: "/token", headers: { origin: "https://evil.example" } })).status, 403);
    assert.equal((await request(port, { method: "POST", path: "/token", headers: { origin } })).status, 403);
    assert.equal(calls, 0);
  });
});

test("/token swaps the key for a token and never logs either", async () => {
  let sent = null;
  const fetchImpl = async (url, init) => {
    sent = { url, init };
    return new Response(JSON.stringify({ access_token: "secret-token", user_id: "u1", group_id: "g1", expires_in: 3600 }), { status: 200 });
  };
  await withServer({ getApiKey: () => KEY, fetchImpl }, async (port, logs) => {
    const r = await request(port, { method: "POST", path: "/token", headers: { origin: `http://localhost:${port}`, "x-accent-changer": "1" } });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).access_token, "secret-token");
    assert.equal(r.headers["access-control-allow-origin"], undefined, "no CORS for other sites");
    assert.equal(sent.url, "https://identity.sanas.ai/oauth2/api-key/login");
    assert.equal(sent.init.method, "POST");
    assert.deepEqual(JSON.parse(sent.init.body), { apiKey: KEY });
    const again = await request(port, { method: "POST", path: "/token", headers: { origin: `http://localhost:${port}`, "x-accent-changer": "1" } });
    assert.equal(again.status, 429, "second token within a second is refused");
    const joined = logs.join("\n");
    assert.ok(!joined.includes(KEY), "key must not be logged");
    assert.ok(!joined.includes("secret-token"), "token must not be logged");
    assert.match(joined, /HTTP 200/);
  });
});

test("/token explains a missing key and an unreachable Sanas", async () => {
  await withServer({ getApiKey: () => "" }, async (port) => {
    const r = await request(port, { method: "POST", path: "/token", headers: { origin: `http://localhost:${port}`, "x-accent-changer": "1" } });
    assert.equal(r.status, 503);
    assert.match(JSON.parse(r.body).error, /No Sanas API key/);
    const health = await request(port, { path: "/health" });
    assert.deepEqual(JSON.parse(health.body), { ok: true, keyLoaded: false });
  });
  const failing = async () => {
    throw new TypeError("fetch failed");
  };
  await withServer({ getApiKey: () => KEY, fetchImpl: failing }, async (port, logs) => {
    const r = await request(port, { method: "POST", path: "/token", headers: { origin: `http://localhost:${port}`, "x-accent-changer": "1" } });
    assert.equal(r.status, 502);
    assert.match(JSON.parse(r.body).error, /Could not reach identity\.sanas\.ai/);
    assert.ok(!logs.join("\n").includes(KEY));
  });
});

test("passes Sanas's own error answer through (e.g. a revoked key)", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ errorCode: "UNAUTHORIZED", message: "Invalid API key" }), { status: 401 });
  await withServer({ getApiKey: () => KEY, fetchImpl }, async (port) => {
    const r = await request(port, { method: "POST", path: "/token", headers: { origin: `http://localhost:${port}`, "x-accent-changer": "1" } });
    assert.equal(r.status, 401);
    assert.match(r.body, /Invalid API key/);
  });
});

test("the key prompt drops escape sequences and control keys, and undoes a double paste", () => {
  const key = "sk_live_AbC123xyz0987654321";
  assert.deepEqual(cleanKeyInput(key), { value: key, ignored: 0, doubled: false });
  // Classic console: Ctrl+V arrives as ^V (U+0016), then a right-click paste.
  assert.equal(cleanKeyInput(`\u0016${key}`).value, key);
  assert.equal(cleanKeyInput(`\u0016${key}`).ignored, 1);
  // Bracketed paste markers and a stray arrow key.
  assert.equal(cleanKeyInput(`\x1b[200~${key}\x1b[201~\x1b[D`).value, key);
  assert.equal(cleanKeyInput(`${key}\x1bOA`).value, key);
  // Windows Terminal: Ctrl+V and a right-click paste the key twice.
  const twice = cleanKeyInput(key + key);
  assert.equal(twice.value, key);
  assert.equal(twice.doubled, true);
  // Backspace deletes; spaces at the ends go.
  assert.equal(cleanKeyInput(`  ${key}x\u007f `).value, key);
  assert.equal(cleanKeyInput("").value, "");
});

test("the start-up key check tells accepted, refused and unknown apart", async () => {
  const answer = (status, body) => async () => new Response(JSON.stringify(body), { status });
  assert.deepEqual(await checkKey({ key: KEY, fetchImpl: answer(200, { access_token: "t", user_id: "u1", group_id: "g1" }) }), {
    ok: true,
    session: { accessToken: "t", userId: "u1", groupId: "g1" },
  });
  assert.deepEqual(await checkKey({ key: KEY, fetchImpl: answer(200, { access_token: "t" }) }), { ok: true, session: null });
  assert.deepEqual(await checkKey({ key: KEY, fetchImpl: answer(401, { message: "Invalid API key" }) }), { refused: true, status: 401 });
  assert.equal((await checkKey({ key: KEY, fetchImpl: answer(503, {}) })).unknown, true);
  const offline = async () => {
    throw new TypeError("fetch failed");
  };
  assert.match((await checkKey({ key: KEY, fetchImpl: offline })).message, /could not reach/);
  let sent = null;
  await checkKey({
    key: KEY,
    fetchImpl: async (url, init) => {
      sent = { url, body: JSON.parse(init.body) };
      return new Response("{}", { status: 401 });
    },
  });
  assert.equal(sent.url, "https://identity.sanas.ai/oauth2/api-key/login");
  assert.deepEqual(sent.body, { apiKey: KEY });
});

test("--port takes both spellings and refuses nonsense instead of falling back", () => {
  assert.deepEqual(portFromArgs([], {}), { port: 8080, from: "default" });
  assert.deepEqual(portFromArgs(["--port", "8090"], {}), { port: 8090, from: "--port" });
  assert.deepEqual(portFromArgs(["--port=8091"], {}), { port: 8091, from: "--port" });
  assert.deepEqual(portFromArgs([], { PORT: "9000" }), { port: 9000, from: "PORT" });
  assert.match(portFromArgs(["--port", "eighty"], {}).error, /not a port number/);
  assert.match(portFromArgs(["--port"], {}).error, /needs a number/);
});

// ---------- origin check ----------

const SESSION = { accessToken: "secret-token", userId: "u1", groupId: "g/1" };
const PAGE = "http://localhost:8080";

/**
 * A fake Sanas portal. `allowed` lists the origins on the project's list;
 * `cors` decides what CORS headers an allowed origin gets.
 */
function fakePortal({ allowed = [PAGE, ...APP_ORIGINS], cors = "echo", allowHeaders = "authorization, content-type", status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const origin = init.headers.Origin;
    calls.push({ url, method: init.method, headers: init.headers });
    const ok = allowed.includes(origin);
    const corsHeaders = {};
    if (ok && cors === "echo") corsHeaders["access-control-allow-origin"] = origin;
    if (ok && cors === "star") corsHeaders["access-control-allow-origin"] = "*";
    if (init.method === "OPTIONS") {
      if (ok && cors !== "none") corsHeaders["access-control-allow-headers"] = allowHeaders;
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (!ok) {
      return new Response(JSON.stringify({ errorCode: "FORBIDDEN", message: "Origin not allowed for this group" }), { status: 403, headers: corsHeaders });
    }
    if (status !== 200) return new Response(JSON.stringify({ message: "nope" }), { status, headers: corsHeaders });
    return new Response(JSON.stringify({ data: { groupName: "me", settings: {} } }), { status: 200, headers: corsHeaders });
  };
  return { fetchImpl, calls };
}

test("the origin check asks like the SDK does: preflight, then GET with the token", async () => {
  const portal = fakePortal();
  const r = await checkOrigin({ origin: APP_ORIGINS[0], session: SESSION, fetchImpl: portal.fetchImpl });
  assert.equal(r.verdict, "accepted");
  assert.equal(portal.calls.length, 2);
  const [pre, get] = portal.calls;
  assert.equal(pre.url, "https://portal-api.sanas.ai/api/v1/sdk/groups/g%2F1/entitlements");
  assert.equal(pre.method, "OPTIONS");
  assert.equal(pre.headers.Origin, "http://tauri.localhost");
  assert.equal(pre.headers["Access-Control-Request-Method"], "GET");
  assert.equal(pre.headers["Access-Control-Request-Headers"], "authorization");
  assert.equal(pre.headers.Authorization, undefined, "a preflight carries no token");
  assert.equal(get.method, "GET");
  assert.equal(get.headers.Authorization, "Bearer secret-token");
  assert.equal(get.url, pre.url);
});

test("the origin check tells accepted, refused, CORS-blocked and unknown apart", async () => {
  const check = (origin, portal) => checkOrigin({ origin, session: SESSION, fetchImpl: portal.fetchImpl });
  assert.equal((await check(APP_ORIGINS[0], fakePortal())).verdict, "accepted");
  assert.equal((await check(APP_ORIGINS[0], fakePortal({ cors: "star" }))).verdict, "accepted");
  const refused = await check(APP_ORIGINS[0], fakePortal({ allowed: [PAGE] }));
  assert.equal(refused.verdict, "refused");
  assert.equal(refused.get.status, 403);
  // Sanas answers, but a browser would block it.
  assert.equal((await check(APP_ORIGINS[0], fakePortal({ cors: "none" }))).verdict, "no-cors");
  const wildcard = await check(APP_ORIGINS[0], fakePortal({ allowHeaders: "*" }));
  assert.equal(wildcard.verdict, "accepted", "Edge and WebView2 let a * through for requests without credentials");
  assert.match(wildcard.note, /Allow-Headers: \*/);
  assert.equal((await check(APP_ORIGINS[0], fakePortal({ allowHeaders: "content-type" }))).verdict, "no-cors");
  // Other answers can't tell anything.
  const expired = await check(APP_ORIGINS[0], fakePortal({ status: 401 }));
  assert.equal(expired.verdict, "error");
  assert.match(expired.note, /HTTP 401/);
  const otherForbidden = await checkOrigin({
    origin: APP_ORIGINS[0],
    session: SESSION,
    fetchImpl: async (url, init) =>
      init.method === "OPTIONS"
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify({ errorCode: "FORBIDDEN", message: "API key revoked" }), { status: 403 }),
  });
  assert.equal(otherForbidden.verdict, "error", "a 403 that is not about the origin is not a refusal");
  const offline = await checkOrigin({
    origin: APP_ORIGINS[0],
    session: SESSION,
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });
  assert.equal(offline.verdict, "error");
  assert.match(offline.note, /could not reach portal-api/);
});

test("the origin report needs both controls before it says anything about the app", async () => {
  const run = (portal) => runOriginCheck({ session: SESSION, pageOrigin: PAGE, fetchImpl: portal.fetchImpl });
  const good = await run(fakePortal());
  assert.equal(good.appReady, true);
  assert.match(good.conclusion, /the app can load its page from http:\/\/tauri\.localhost and https:\/\/tauri\.localhost/);
  assert.equal(good.results.length, 4);
  assert.equal(good.lines.length, 4);
  assert.match(good.lines[3], /refused, as it should be/);

  const httpsOnly = await run(fakePortal({ allowed: [PAGE, APP_ORIGINS[1]] }));
  assert.equal(httpsOnly.appReady, true);
  assert.match(httpsOnly.conclusion, /from https:\/\/tauri\.localhost\./);
  assert.match(httpsOnly.lines[1], /refused: not in Allowed origins/);

  const noApp = await run(fakePortal({ allowed: [PAGE] }));
  assert.equal(noApp.appReady, false);
  assert.match(noApp.conclusion, /refused both app addresses/);

  const pageRefused = await run(fakePortal({ allowed: APP_ORIGINS }));
  assert.equal(pageRefused.appReady, null);
  assert.match(pageRefused.conclusion, /Add exactly  http:\/\/localhost:8080/);

  const noCheck = await run(fakePortal({ allowed: [PAGE, ...APP_ORIGINS, CONTROL_ORIGIN] }));
  assert.equal(noCheck.appReady, null, "Sanas accepting an unlisted address makes the check meaningless");
  assert.match(noCheck.conclusion, /Inconclusive/);
  assert.match(noCheck.lines[3], /accepted, though it is on no list/);

  const report = originReport([], PAGE);
  assert.equal(report.appReady, null);
  assert.match(report.lines[0], /not checked/);
});

test("the origin report says inconclusive, not refused, when the app addresses couldn't be checked", () => {
  const r = (origin, verdict, note = "") => ({ origin, verdict, note, preflight: null, get: null });
  const base = [r(PAGE, "accepted"), r(CONTROL_ORIGIN, "refused")];
  const errors = originReport([...base, r(APP_ORIGINS[0], "error", "Sanas answered HTTP 429"), r(APP_ORIGINS[1], "error", "no answer within 10 s")], PAGE);
  assert.equal(errors.appReady, null);
  assert.match(errors.conclusion, /Inconclusive: Sanas could not be asked/);
  assert.match(errors.lines[1], /could not check \(Sanas answered HTTP 429\)/);
  const mixed = originReport([...base, r(APP_ORIGINS[0], "error", "x"), r(APP_ORIGINS[1], "refused")], PAGE);
  assert.equal(mixed.appReady, null, "one refusal and one error is not 'both refused'");
  const cors = originReport([...base, r(APP_ORIGINS[0], "no-cors"), r(APP_ORIGINS[1], "no-cors")], PAGE);
  assert.equal(cors.appReady, false);
  assert.match(cors.conclusion, /without the CORS headers/);
  const refused = originReport([...base, r(APP_ORIGINS[0], "refused"), r(APP_ORIGINS[1], "refused")], PAGE);
  assert.equal(refused.appReady, false);
  assert.match(refused.conclusion, /refused both app addresses/);
});

test("the server shares the origin check with the page, without the token", async () => {
  const portal = fakePortal();
  const check = await runOriginCheck({ session: SESSION, pageOrigin: PAGE, fetchImpl: portal.fetchImpl });
  let current = null;
  await withServer({ getOriginCheck: () => current }, async (port) => {
    const before = await request(port, { path: "/origin-check" });
    assert.equal(before.status, 200);
    assert.deepEqual(JSON.parse(before.body), { ran: false });
    current = check;
    const after = await request(port, { path: "/origin-check" });
    const body = JSON.parse(after.body);
    assert.equal(body.ran, true);
    assert.equal(body.appReady, true);
    assert.ok(!after.body.includes("secret-token"), "the token stays in the server");
    assert.ok(!after.body.includes("g%2F1"), "no project ids either");
  });
});
