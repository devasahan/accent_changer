#!/usr/bin/env node
/**
 * Accent Changer spike server.
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
    if (req.headers["x-accent-changer"] !== "1") return send(res, 403, "Missing X-Accent-Changer header");
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
 * Start listening on 127.0.0.1 and on ::1 (Edge tries ::1 first for
 * "localhost"), and return { port, close }. A machine without IPv6 loopback
 * is fine; a ::1 port that another program holds is an error, or Edge would
 * open that program instead of this page. Port 0 picks a free port (IPv4
 * only), for tests.
 */
export async function startSpikeServer({ port = 8080, getApiKey = () => "", fetchImpl, log } = {}) {
  const first = http.createServer();
  const actual = await listen(first, port, "127.0.0.1");
  const handler = createHandler({ port: actual, getApiKey, fetchImpl, log });
  first.on("request", handler);
  const servers = [first];
  const close = () => Promise.all(servers.map((s) => new Promise((resolve) => s.close(() => resolve()))));
  if (port !== 0) {
    const second = http.createServer(handler);
    try {
      await listen(second, actual, "::1");
      servers.push(second);
    } catch (err) {
      if (err?.code === "EADDRINUSE" || err?.code === "EACCES" || err?.code === "EPERM") {
        await close();
        err.ipv6 = true;
        throw err;
      }
      // No IPv6 loopback on this machine: browsers fall back to 127.0.0.1.
    }
  }
  return { port: actual, close };
}

/**
 * The key from what arrived at the hidden prompt: escape sequences (arrow
 * keys, bracketed-paste markers) and other control characters (a Ctrl+V
 * that the console passed through as ^V) are dropped, Backspace deletes.
 * Returns { value, ignored } with `ignored` the number of keys dropped.
 */
export function cleanKeyInput(raw) {
  let value = "";
  let ignored = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\x1b") {
      const next = raw[i + 1];
      if (next === "[") {
        let j = i + 2;
        while (j < raw.length && !/[\x40-\x7e]/.test(raw[j])) j++;
        i = j; // ESC [ … final byte
      } else if (next === "O") i += 2; // ESC O x
      else if (next !== undefined) i += 1;
      ignored++;
      continue;
    }
    if (c === "\x7f" || c === "\b") {
      value = value.slice(0, -1);
      continue;
    }
    if (c.charCodeAt(0) < 0x20) {
      ignored++;
      continue;
    }
    value += c;
  }
  value = value.trim();
  // The same key pasted twice (Ctrl+V and then right-click "to be sure").
  const half = value.length / 2;
  const doubled = value.length >= 16 && Number.isInteger(half) && value.slice(0, half) === value.slice(half);
  return { value: doubled ? value.slice(0, half) : value, ignored, doubled };
}

/**
 * Read a line from the terminal without echoing it (for the API key).
 * Resolves { value, ignored, doubled }, or null when this is not an
 * interactive terminal (nothing can be asked).
 */
export function promptHidden(question, input = process.stdin, output = process.stdout) {
  if (!input.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    output.write(question);
    let raw = "";
    const finish = () => {
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
      output.write("\n");
      resolve(cleanKeyInput(raw));
    };
    const onData = (chunk) => {
      for (const c of String(chunk)) {
        if (c === "\r" || c === "\n" || c === "\u0004") return finish();
        if (c === "\u0003") {
          output.write("\n");
          process.exit(130);
        }
        raw += c;
      }
    };
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    input.on("data", onData);
  });
}

/**
 * Ask Sanas once whether it accepts `key` (a token exchange: no audio
 * minutes). { ok } when it does, { refused, status } when it says no,
 * { unknown, message } when it can't be asked right now.
 */
export async function checkKey({ key, fetchImpl = globalThis.fetch, identityUrl = SANAS_IDENTITY_URL }) {
  let res;
  try {
    res = await fetchImpl(identityUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: key }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    return { unknown: true, message: err?.name === "TimeoutError" ? "no answer within 15 s" : "could not reach identity.sanas.ai" };
  }
  if (res.ok) {
    const body = await res.json().catch(() => null);
    return body?.access_token ? { ok: true } : { unknown: true, message: "unexpected answer from Sanas" };
  }
  if ([400, 401, 403].includes(res.status)) return { refused: true, status: res.status };
  return { unknown: true, message: `Sanas answered HTTP ${res.status}` };
}

/** --port 8090, --port=8090 or the PORT variable; an error message for anything else. */
export function portFromArgs(argv, env = process.env) {
  let raw;
  let from = "default";
  const eq = argv.find((a) => a.startsWith("--port="));
  const i = argv.indexOf("--port");
  if (eq) {
    raw = eq.slice("--port=".length);
    from = "--port";
  } else if (i >= 0) {
    raw = argv[i + 1];
    from = "--port";
  } else if (env.PORT) {
    raw = env.PORT;
    from = "PORT";
  }
  if (from === "default") return { port: 8080, from };
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n >= 65536) {
    const what = raw === undefined ? "--port needs a number after it" : `"${raw}" is not a port number (${from})`;
    return { error: `${what}. Example: node spike/serve.mjs --port 8090` };
  }
  return { port: n, from };
}

const tail = (key) => `…${key.slice(-4)}`;

async function askForKey() {
  const question =
    "Paste your Sanas API key once (Ctrl+V in Windows Terminal, right-click in the classic window), then press Enter.\n" +
    "Nothing shows while you paste: that is on purpose. Leave it empty to use only the Mock engine: ";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const answer = await promptHidden(question);
    if (answer === null) {
      console.log(
        "Can't ask for the key here: this window isn't an interactive terminal (Git Bash's mintty, an editor's console…). " +
          "Run  node spike/serve.mjs  in PowerShell or Windows Terminal, or set SANAS_API_KEY for this window.",
      );
      return "";
    }
    const { value, ignored, doubled } = answer;
    if (!value) return "";
    const notes = [doubled && "it was pasted twice, so one copy is used", ignored && `${ignored} control key(s) ignored`].filter(Boolean);
    console.log(`Got a ${value.length}-character key ending in ${tail(value)}${notes.length ? ` (${notes.join("; ")})` : ""}.`);
    if (/\s/.test(value)) {
      console.log("That key contains spaces: copy it again from the Sanas Console.");
      continue;
    }
    const verdict = await checkKey({ key: value });
    if (verdict.ok) {
      console.log("Sanas accepted the key. It is kept in this window's memory only.");
      return value;
    }
    if (verdict.refused) {
      console.log(`Sanas refused this key (HTTP ${verdict.status}). Paste it again: once, then Enter.`);
      continue;
    }
    console.log(`Could not check the key with Sanas (${verdict.message}). Using it anyway; the page will say if it is refused.`);
    return value;
  }
  console.log("Sanas refused the key three times. Check it in the Sanas Console (expired? revoked?), then start the server again.");
  return "";
}

function portHelp(port, err) {
  const next = port === 8080 ? 8090 : port + 10;
  const fix = `Run:  node spike/serve.mjs --port ${next}   and add  http://localhost:${next}  to Allowed origins in the Sanas Console.`;
  if (err?.code === "EADDRINUSE") {
    return `Port ${port} is already used by another program${err.ipv6 ? " (on the IPv6 address [::1], which Edge tries first)" : ""}. ${fix}`;
  }
  if (err?.code === "EACCES" || err?.code === "EPERM") {
    return `Windows does not let programs use port ${port} on this PC (Hyper-V, WSL or Docker often reserve ports). ${fix}`;
  }
  return null;
}

async function main() {
  const parsed = portFromArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(parsed.error);
    process.exit(1);
  }
  const { port } = parsed;
  if (parsed.from === "PORT") console.log(`Using port ${port} from the PORT environment variable.`);
  let key = "";
  const stamp = () => new Date().toTimeString().slice(0, 8);
  let server;
  try {
    // Bind first, so a busy port doesn't cost a paste of the key.
    server = await startSpikeServer({ port, getApiKey: () => key, log: (m) => console.log(`[${stamp()}] ${m}`) });
  } catch (err) {
    console.error(portHelp(port, err) ?? `Could not start the server on port ${port}: ${err?.message ?? err}`);
    process.exit(1);
  }
  const fromEnv = (process.env.SANAS_API_KEY ?? "").trim();
  if (fromEnv) {
    console.log(`Using the key from the SANAS_API_KEY environment variable (${tail(fromEnv)}).`);
    console.log("To paste another key instead, open a new window, run  Remove-Item Env:SANAS_API_KEY  (PowerShell), and start the server again.");
    const verdict = await checkKey({ key: fromEnv });
    if (verdict.ok) console.log("Sanas accepted that key.");
    else if (verdict.refused) console.log(`Sanas refused that key (HTTP ${verdict.status}).`);
    else console.log(`Could not check the key with Sanas (${verdict.message}).`);
    key = fromEnv;
  } else {
    key = await askForKey();
  }
  console.log("");
  console.log(`Accent Changer spike is running. Open  http://localhost:${server.port}/spike/  in Microsoft Edge or Chrome.`);
  console.log(`Sanas Console → your project → Allowed origins must include exactly:  http://localhost:${server.port}`);
  if (!key) console.log("No key loaded: only the Mock engine will work.");
  console.log("Press Ctrl+C to stop.");
  const stop = () => server.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`The spike server stopped: ${err?.message ?? err}`);
    process.exit(1);
  });
}
