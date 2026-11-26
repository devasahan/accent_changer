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
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cleanKeyInput } from "../src/core/key-input.js";

export { cleanKeyInput }; // the hidden prompt's cleaning, shared with the app (src/core/key-input.js)

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SANAS_IDENTITY_URL = "https://identity.sanas.ai/oauth2/api-key/login";
export const SANAS_PORTAL_URL = "https://portal-api.sanas.ai";
/** The addresses the Windows app will load its page from (Tauri: http, or https with useHttpsScheme). */
export const APP_ORIGINS = ["http://tauri.localhost", "https://tauri.localhost"];
/** An address nobody lists. Sanas must refuse it, or the origin check can't tell anything. */
export const CONTROL_ORIGIN = "https://origin-check.accent-changer.invalid";
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

// The app's own CSP, from the Tauri config: Edge dev mode serves the app's
// pages (src/) under exactly the policy they get inside the app. Without a
// readable config (a partial copy of the repo), they get the probe's policy:
// the probe page itself never depends on it.
export const APP_CSP = (() => {
  try {
    const csp = JSON.parse(readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8")).app?.security?.csp;
    if (typeof csp === "string" && csp.trim()) return csp;
  } catch {
    // missing or malformed: fall through
  }
  return CSP;
})();

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
export function createHandler({
  port,
  getApiKey,
  getOriginCheck = () => null,
  fetchImpl = globalThis.fetch,
  identityUrl = SANAS_IDENTITY_URL,
  log = () => {},
}) {
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
      headers["Content-Security-Policy"] = top === "src" ? APP_CSP : CSP;
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
      // Which page addresses Sanas accepts (no secrets in it): the probe saves it in its results.
      if (url.pathname === "/origin-check") return sendJson(res, 200, getOriginCheck() ?? { ran: false });
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
export async function startSpikeServer({ port = 8080, getApiKey = () => "", getOriginCheck, fetchImpl, log } = {}) {
  const first = http.createServer();
  const actual = await listen(first, port, "127.0.0.1");
  const handler = createHandler({ port: actual, getApiKey, getOriginCheck, fetchImpl, log });
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
 * minutes). { ok, session } when it does (session: the short-lived token
 * and ids, or null if the answer lacks them; never log it), { refused,
 * status } when it says no, { unknown, message } when it can't be asked
 * right now.
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
    if (!body?.access_token) return { unknown: true, message: "unexpected answer from Sanas" };
    const session =
      typeof body.user_id === "string" && body.user_id && typeof body.group_id === "string" && body.group_id
        ? { accessToken: body.access_token, userId: body.user_id, groupId: body.group_id }
        : null;
    return { ok: true, session };
  }
  if ([400, 401, 403].includes(res.status)) return { refused: true, status: res.status };
  return { unknown: true, message: `Sanas answered HTTP ${res.status}` };
}

/** The portal's "origin not allowed" answer, matched like the Sanas SDK does (index.js, isOriginForbiddenResponse). */
function isOriginForbidden(status, body) {
  return status === 403 && body?.errorCode === "FORBIDDEN" && typeof body.message === "string" && /origin not allowed/i.test(body.message);
}

const allowsOrigin = (headers, origin) => {
  const value = headers.get("access-control-allow-origin");
  return value === "*" || value === origin;
};

/**
 * How a preflight answer lets the Authorization header through: "named"
 * (listed by name), "wildcard" (a "*": Chromium, so Edge and WebView2,
 * accept that for requests without credentials, like the SDK's; the spec
 * and Firefox don't), or null (not at all).
 */
function authorizationVia(headers) {
  const names = (headers.get("access-control-allow-headers") ?? "").split(",").map((h) => h.trim().toLowerCase());
  if (names.includes("authorization")) return "named";
  return names.includes("*") ? "wildcard" : null;
}

/**
 * Ask Sanas for the project's entitlements the way a page on `origin` would
 * (the SDK's first call when it connects): a CORS preflight, then the GET.
 * Free: no audio minutes. `verdict` is "accepted" (a browser page there
 * would get the answer), "refused" (Sanas says the origin is not allowed),
 * "no-cors" (Sanas answered, but without the CORS headers a browser needs)
 * or "error" (could not tell; see `note`).
 */
export async function checkOrigin({ origin, session, fetchImpl = globalThis.fetch, portalUrl = SANAS_PORTAL_URL, timeoutMs = 10000 }) {
  const url = `${portalUrl}/api/v1/sdk/groups/${encodeURIComponent(session.groupId)}/entitlements`;
  const result = { origin, verdict: "error", note: "", preflight: null, get: null };
  try {
    const pre = await fetchImpl(url, {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    await pre.arrayBuffer().catch(() => {});
    result.preflight = {
      status: pre.status,
      allowOrigin: pre.headers.get("access-control-allow-origin"),
      allowHeaders: pre.headers.get("access-control-allow-headers"),
    };
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { Origin: origin, Authorization: `Bearer ${session.accessToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON
    }
    result.get = { status: res.status, allowOrigin: res.headers.get("access-control-allow-origin") };
    if (isOriginForbidden(res.status, body)) {
      result.verdict = "refused";
    } else if (!res.ok || !body?.data) {
      result.note = `Sanas answered HTTP ${res.status}`;
    } else {
      const via = authorizationVia(pre.headers);
      const preflightOk = pre.ok && allowsOrigin(pre.headers, origin) && via !== null;
      result.verdict = preflightOk && allowsOrigin(res.headers, origin) ? "accepted" : "no-cors";
      if (result.verdict === "accepted" && via === "wildcard") {
        result.note = "accepted via Access-Control-Allow-Headers: * (Edge and WebView2 allow this; stricter browsers would not)";
      }
    }
  } catch (err) {
    result.note = err?.name === "TimeoutError" ? `no answer within ${timeoutMs / 1000} s` : "could not reach portal-api.sanas.ai";
  }
  return result;
}

const ORIGIN_ROLES = (pageOrigin) => [
  [pageOrigin, "this page"],
  [APP_ORIGINS[0], "the app"],
  [APP_ORIGINS[1], "the app, backup"],
  [CONTROL_ORIGIN, "test address, not on your list"],
];

/**
 * Turn checkOrigin results into lines to print and one conclusion. The page's
 * own origin must be accepted and the unlisted control refused; otherwise
 * the check can't tell anything about the app's origins.
 */
export function originReport(results, pageOrigin) {
  const by = new Map(results.map((r) => [r.origin, r]));
  const describe = (r) => {
    if (!r) return "not checked";
    if (r.origin === CONTROL_ORIGIN) {
      if (r.verdict === "refused") return "refused, as it should be";
      if (r.verdict === "accepted") return "accepted, though it is on no list";
    }
    if (r.verdict === "accepted") return "accepted";
    if (r.verdict === "refused") return "refused: not in Allowed origins";
    if (r.verdict === "no-cors") return "Sanas answered, but a browser would block the answer (CORS)";
    return `could not check (${r.note})`;
  };
  const roles = ORIGIN_ROLES(pageOrigin);
  const width = Math.max(...roles.map(([o]) => o.length));
  const lines = roles.map(([origin, role]) => `  ${origin.padEnd(width)}  (${role})  ${describe(by.get(origin))}`);
  const page = by.get(pageOrigin);
  const control = by.get(CONTROL_ORIGIN);
  const appOk = APP_ORIGINS.filter((o) => by.get(o)?.verdict === "accepted");
  const appVerdicts = APP_ORIGINS.map((o) => by.get(o)?.verdict);
  let conclusion;
  let appReady = null; // true / false when the check could tell, null when it couldn't
  if (page?.verdict === "refused") {
    conclusion = `Sanas refused this page's own address. Add exactly  ${pageOrigin}  under Allowed origins, then start the server again.`;
  } else if (page?.verdict !== "accepted") {
    conclusion = "Inconclusive: Sanas did not accept this page's own address in this check. The app's own test will tell.";
  } else if (control?.verdict !== "refused") {
    conclusion = "Inconclusive: Sanas did not refuse an address that is on no list, so this check can't tell. The app's own test will.";
  } else if (appOk.length) {
    appReady = true;
    conclusion = `Good: the app can load its page from ${appOk.join(" and ")}.`;
  } else if (appVerdicts.every((v) => v === "refused")) {
    appReady = false;
    conclusion = `Sanas refused both app addresses. Add exactly  ${APP_ORIGINS.join("  and  ")}  under Allowed origins (no slash at the end). If the Console won't save them, say so in your results notes.`;
  } else if (appVerdicts.every((v) => v === "refused" || v === "no-cors")) {
    appReady = false;
    conclusion =
      "Sanas answers the app addresses, but without the CORS headers a browser there needs; adding them again won't help. Say so in your results notes.";
  } else {
    conclusion = "Inconclusive: Sanas could not be asked about the app addresses (see the lines above). Start the server again to retry.";
  }
  return { lines, conclusion, appReady };
}

/** Check the page's own origin, both app origins and the control at once. */
export async function runOriginCheck({ session, pageOrigin, fetchImpl, portalUrl }) {
  const origins = ORIGIN_ROLES(pageOrigin).map(([o]) => o);
  const results = await Promise.all(origins.map((origin) => checkOrigin({ origin, session, fetchImpl, portalUrl })));
  const report = originReport(results, pageOrigin);
  return { ran: true, at: new Date().toISOString(), pageOrigin, results, conclusion: report.conclusion, appReady: report.appReady, lines: report.lines };
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
      return { key: "", session: null };
    }
    const { value, ignored, doubled } = answer;
    if (!value) return { key: "", session: null };
    const notes = [doubled && "it was pasted twice, so one copy is used", ignored && `${ignored} control key(s) ignored`].filter(Boolean);
    console.log(`Got a ${value.length}-character key ending in ${tail(value)}${notes.length ? ` (${notes.join("; ")})` : ""}.`);
    if (/\s/.test(value)) {
      // The Console shows a key only once: the copy to go back to is the saved one.
      console.log("That key contains spaces: copy it again from where you saved it (for example your password manager).");
      continue;
    }
    const verdict = await checkKey({ key: value });
    if (verdict.ok) {
      console.log("Sanas accepted the key. It is kept in this window's memory only.");
      return { key: value, session: verdict.session, verdict };
    }
    if (verdict.refused) {
      console.log(`Sanas refused this key (HTTP ${verdict.status}). Paste it again: once, then Enter.`);
      continue;
    }
    console.log(`Could not check the key with Sanas (${verdict.message}). Using it anyway; the page will say if it is refused.`);
    return { key: value, session: null, verdict };
  }
  console.log("Sanas refused the key three times. Check it in the Sanas Console (expired? revoked?), then start the server again.");
  return { key: "", session: null };
}

/** Why the address check could not run with this key check's verdict, and what to do. */
export function skippedCheck(verdict) {
  if (verdict?.refused) return { reason: `Sanas refused the key (HTTP ${verdict.status})`, next: "Fix the key, then start the server again." };
  if (verdict?.ok && !verdict.session) return { reason: "Sanas's answer about the key had no user or group id", next: "Write this in your notes." };
  return { reason: "the key could not be checked with Sanas when the server started", next: "Start the server again to run it." };
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
  let originCheck = null;
  const stamp = () => new Date().toTimeString().slice(0, 8);
  let server;
  try {
    // Bind first, so a busy port doesn't cost a paste of the key.
    server = await startSpikeServer({
      port,
      getApiKey: () => key,
      getOriginCheck: () => originCheck,
      log: (m) => console.log(`[${stamp()}] ${m}`),
    });
  } catch (err) {
    console.error(portHelp(port, err) ?? `Could not start the server on port ${port}: ${err?.message ?? err}`);
    process.exit(1);
  }
  const fromEnv = (process.env.SANAS_API_KEY ?? "").trim();
  let session = null;
  let verdict = null;
  if (fromEnv) {
    console.log(`Using the key from the SANAS_API_KEY environment variable (${tail(fromEnv)}).`);
    console.log("To paste another key instead, open a new window, run  Remove-Item Env:SANAS_API_KEY  (PowerShell), and start the server again.");
    verdict = await checkKey({ key: fromEnv });
    if (verdict.ok) console.log("Sanas accepted that key.");
    else if (verdict.refused) console.log(`Sanas refused that key (HTTP ${verdict.status}).`);
    else console.log(`Could not check the key with Sanas (${verdict.message}).`);
    key = fromEnv;
    session = verdict.ok ? verdict.session : null;
  } else {
    ({ key, session, verdict = null } = await askForKey());
  }
  if (session) {
    console.log("");
    console.log("Checking which page addresses Sanas accepts (free: no audio minutes)…");
    originCheck = await runOriginCheck({ session, pageOrigin: `http://localhost:${server.port}` });
    for (const line of originCheck.lines) console.log(line);
    console.log(originCheck.conclusion);
    console.log("(The page saves this check in its results JSON.)");
  } else if (key) {
    const skip = skippedCheck(verdict);
    originCheck = { ran: false, reason: skip.reason };
    console.log(`Address check skipped: ${skip.reason}. ${skip.next}`);
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
