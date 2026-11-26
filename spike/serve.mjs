#!/usr/bin/env node
/**
 * AccentSwitch spike server.
 *
 * Serves the probe page at http://localhost:8080/spike/ and swaps your Sanas
 * API key for short-lived access tokens (POST /token), so the key never
 * reaches the browser. The key lives only in this process's memory: it is
 * not written to disk and never logged. Listens on the loopback interface
 * only, so nothing else on your network can use it.
 *
 *   node spike/serve.mjs              asks for the key (typing stays hidden)
 *   node spike/serve.mjs --port 8090  another port (add that origin in Sanas)
 */
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SANAS_IDENTITY_URL = "https://identity.sanas.ai/oauth2/api-key/login";
const SERVED_DIRS = new Set(["spike", "src"]);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".md": "text/plain; charset=utf-8",
};
// The probe needs WebRTC and WebSockets to Sanas (hosts handed out at run time).
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "media-src 'self' blob: mediastream:",
  "connect-src 'self' https: wss:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), { "Content-Type": "application/json; charset=utf-8" });
}

/**
 * Request handler for a server on `port`. `getApiKey` returns the key (or
 * an empty string); `fetchImpl` is replaceable for tests.
 */
export function createHandler({ port, getApiKey, fetchImpl = globalThis.fetch, identityUrl = SANAS_IDENTITY_URL, log = () => {} }) {
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  const origins = new Set([...hosts].map((h) => `http://${h}`));
  let lastTokenAt = 0;

  async function token(req, res) {
    if (req.method !== "POST") return send(res, 405, "POST only", { Allow: "POST" });
    // Only the probe page itself may ask: other websites can't (no CORS
    // headers are ever sent, and both checks below need a same-origin call).
    if (!origins.has(req.headers.origin ?? "")) return send(res, 403, "Origin not allowed");
    if (req.headers["x-accent-switch"] !== "1") return send(res, 403, "Missing X-Accent-Switch header");
    const key = getApiKey();
    if (!key) {
      return sendJson(res, 503, {
        error: "No Sanas API key loaded. Stop the server (Ctrl+C), start it again and paste the key, or use the Mock engine.",
      });
    }
    const now = Date.now();
    if (now - lastTokenAt < 1000) return sendJson(res, 429, { error: "Token requested too often; try again in a second." });
    lastTokenAt = now;
    let upstream;
    try {
      upstream = await fetchImpl(identityUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: key }),
        signal: AbortSignal.timeout(20000),
      });
    } catch (err) {
      log(`token: could not reach Sanas (${err?.name ?? "error"})`);
      return sendJson(res, 502, { error: "Could not reach identity.sanas.ai. Check your internet connection." });
    }
    const body = await upstream.text();
    // The body holds the access token: log the status only.
    log(`token: Sanas answered HTTP ${upstream.status}`);
    send(res, upstream.status, body, { "Content-Type": "application/json; charset=utf-8" });
  }

  async function serveFile(pathname, req, res) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return send(res, 400, "Bad path");
    }
    if (rel.includes("\0")) return send(res, 400, "Bad path");
    if (rel.endsWith("/")) rel += "index.html";
    const full = path.resolve(ROOT, `.${rel}`);
    const inside = path.relative(ROOT, full);
    const top = inside.split(path.sep)[0];
    if (!inside || inside.startsWith("..") || path.isAbsolute(inside) || !SERVED_DIRS.has(top)) {
      return send(res, 404, "Not found");
    }
    let info;
    try {
      info = await stat(full);
    } catch {
      return send(res, 404, "Not found");
    }
    if (info.isDirectory()) return send(res, 301, "", { Location: `${pathname}/` });
    const type = TYPES[path.extname(full).toLowerCase()];
    if (!type) return send(res, 404, "Not found");
    const body = await readFile(full);
    const headers = {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "same-origin",
    };
    if (type.startsWith("text/html")) {
      headers["Content-Security-Policy"] = CSP;
      headers["Permissions-Policy"] = "microphone=(self), camera=()";
    }
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : body);
  }

  return async function handle(req, res) {
    try {
      // Refuse other host names (DNS-rebinding protection for /token).
      if (!hosts.has(req.headers.host ?? "")) return send(res, 421, `Open http://localhost:${port}/spike/`);
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (url.pathname === "/token") return await token(req, res);
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed", { Allow: "GET, HEAD" });
      if (url.pathname === "/health") return sendJson(res, 200, { ok: true, keyLoaded: Boolean(getApiKey()) });
      if (url.pathname === "/" || url.pathname === "/spike") return send(res, 302, "", { Location: "/spike/" });
      return await serveFile(url.pathname, req, res);
    } catch (err) {
      log(`error: ${err?.message ?? err}`);
      if (!res.headersSent) send(res, 500, "Server error");
      else res.end();
    }
  };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server.address().port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/**
 * Start listening on 127.0.0.1 (and ::1 when available) and return
 * { port, close }. Port 0 picks a free port (IPv4 only), for tests.
 */
export async function startSpikeServer({ port = 8080, getApiKey = () => "", fetchImpl, log } = {}) {
  const first = http.createServer();
  const actual = await listen(first, port, "127.0.0.1");
  const handler = createHandler({ port: actual, getApiKey, fetchImpl, log });
  first.on("request", handler);
  const servers = [first];
  if (port !== 0) {
    const second = http.createServer(handler);
    try {
      await listen(second, actual, "::1");
      servers.push(second);
    } catch {
      // No IPv6 loopback on this machine: browsers fall back to 127.0.0.1.
    }
  }
  return {
    port: actual,
    close: () => Promise.all(servers.map((s) => new Promise((resolve) => s.close(() => resolve())))),
  };
}

/** Read a line from the terminal without echoing it (for the API key). */
export function promptHidden(question, input = process.stdin, output = process.stdout) {
  if (!input.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    output.write(question);
    let value = "";
    const finish = () => {
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
      output.write("\n");
      resolve(value.replace(/\x1b\[20[01]~/g, "").trim());
    };
    const onData = (chunk) => {
      for (const c of String(chunk)) {
        if (c === "\r" || c === "\n" || c === "\u0004") return finish();
        if (c === "\u0003") {
          output.write("\n");
          process.exit(130);
        }
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else value += c;
      }
    };
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    input.on("data", onData);
  });
}

function portFromArgs(argv) {
  const i = argv.indexOf("--port");
  const raw = i >= 0 ? argv[i + 1] : process.env.PORT;
  const n = Number(raw ?? 8080);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 8080;
}

async function main() {
  const port = portFromArgs(process.argv.slice(2));
  let key = (process.env.SANAS_API_KEY ?? "").trim();
  if (!key) {
    key = await promptHidden(
      "Paste your Sanas API key and press Enter (typing stays hidden; right-click pastes in older consoles).\n" +
        "Leave it empty to try the page with the Mock engine only: ",
    );
  }
  if (/\s/.test(key)) {
    console.error("That key contains spaces or line breaks; copy it again from the Sanas Console.");
    process.exit(1);
  }
  const stamp = () => new Date().toTimeString().slice(0, 8);
  let server;
  try {
    server = await startSpikeServer({ port, getApiKey: () => key, log: (m) => console.log(`[${stamp()}] ${m}`) });
  } catch (err) {
    if (err?.code === "EADDRINUSE") {
      console.error(`Port ${port} is busy. Run: node spike/serve.mjs --port ${port + 10}  (and add http://localhost:${port + 10} as an allowed origin in Sanas).`);
      process.exit(1);
    }
    throw err;
  }
  console.log("");
  console.log(`AccentSwitch spike is running. Open  http://localhost:${server.port}/spike/  in Microsoft Edge or Chrome.`);
  console.log(`Sanas Console → your project → Allowed origins must include exactly:  http://localhost:${server.port}`);
  console.log(key ? "Sanas key loaded (kept in memory only)." : "No key loaded: only the Mock engine will work.");
  console.log("Press Ctrl+C to stop.");
  const stop = () => server.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
