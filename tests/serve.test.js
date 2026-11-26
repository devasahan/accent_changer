import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { CSP, startSpikeServer } from "../spike/serve.mjs";

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
    const r = await request(port, { method: "POST", path: "/token", headers: { origin: `http://localhost:${port}`, "x-accent-switch": "1" } });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).access_token, "secret-token");
    assert.equal(r.headers["access-control-allow-origin"], undefined, "no CORS for other sites");
    assert.equal(sent.url, "https://identity.sanas.ai/oauth2/api-key/login");
    assert.equal(sent.init.method, "POST");
    assert.deepEqual(JSON.parse(sent.init.body), { apiKey: KEY });
    const again = await request(port, { method: "POST", path: "/token", headers: { origin: `http://localhost:${port}`, "x-accent-switch": "1" } });
    assert.equal(again.status, 429, "second token within a second is refused");
    const joined = logs.join("\n");
    assert.ok(!joined.includes(KEY), "key must not be logged");
    assert.ok(!joined.includes("secret-token"), "token must not be logged");
    assert.match(joined, /HTTP 200/);
  });
});

test("/token explains a missing key and an unreachable Sanas", async () => {
  await withServer({ getApiKey: () => "" }, async (port) => {
    const r = await request(port, { method: "POST", path: "/token", headers: { origin: `http://localhost:${port}`, "x-accent-switch": "1" } });
    assert.equal(r.status, 503);
    assert.match(JSON.parse(r.body).error, /No Sanas API key/);
    const health = await request(port, { path: "/health" });
    assert.deepEqual(JSON.parse(health.body), { ok: true, keyLoaded: false });
  });
  const failing = async () => {
    throw new TypeError("fetch failed");
  };
  await withServer({ getApiKey: () => KEY, fetchImpl: failing }, async (port, logs) => {
    const r = await request(port, { method: "POST", path: "/token", headers: { origin: `http://localhost:${port}`, "x-accent-switch": "1" } });
    assert.equal(r.status, 502);
    assert.match(JSON.parse(r.body).error, /Could not reach identity\.sanas\.ai/);
    assert.ok(!logs.join("\n").includes(KEY));
  });
});

test("passes Sanas's own error answer through (e.g. a revoked key)", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ errorCode: "UNAUTHORIZED", message: "Invalid API key" }), { status: 401 });
  await withServer({ getApiKey: () => KEY, fetchImpl }, async (port) => {
    const r = await request(port, { method: "POST", path: "/token", headers: { origin: `http://localhost:${port}`, "x-accent-switch": "1" } });
    assert.equal(r.status, 401);
    assert.match(r.body, /Invalid API key/);
  });
});
