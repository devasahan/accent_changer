/**
 * Nothing secret leaves the app in a log line, a diagnostics summary or an
 * error report.
 *
 * redact() scrubs text: API keys, access tokens (JWTs, "Bearer …",
 * Authorization headers), the Sanas user and group ids, passwords in URLs,
 * device ids, UUIDs and any other long random-looking run of letters and
 * digits become "[redacted]". redactObject() does the same for a whole
 * object and also hides every value whose field name says it is a secret.
 * Delays, levels, states, model names, device names and URLs without secrets
 * stay as they are: a report is only useful if it still says what happened.
 * When in doubt a string goes: a lost word in a log costs less than a leaked
 * key.
 *
 * Pure string work (no DOM, no Node APIs): the app, the probe and the tests
 * share it.
 */

/** What every secret is replaced with. */
export const REDACTED = "[redacted]";

/**
 * "user:password@" in a URL, up to the last "@" before the host: a password
 * may hold an "@" of its own (p@ssw0rd). Bounded lengths: a long dotted text
 * must not make the search quadratic.
 */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/@:]{1,256}:[^\s/]{1,256}@/gi;

/** An Authorization header or field, in any quoting: the credentials after the scheme. */
const AUTH_HEADER =
  /(\bauthorization\\?["']?\s*[:=]\s*\\?["']?)((?:bearer|basic|digest|token|apikey|api-key)\s+)?([^\s"'\\,;]+)/gi;

/** "Bearer <token>" anywhere (RFC 6750 characters); 8 characters at least, because "bearer of" is English. */
const BEARER = /\b(bearer)\s+([A-Za-z0-9\-._~+/]{8,}=*)/gi;

/**
 * Fields whose values are secret however short they are ("user_id": "u1"):
 * JSON ("key": "v"), JS (key: 'v'), query strings, headers and log text
 * (key=v, X-Api-Key: v), and JSON escaped inside a JSON string
 * (\"key\":\"v\"). The name is a secret word (token, api key, user id, group
 * id, secret, password, cookie, credential) written with "_", "-" or nothing
 * between its parts, after up to three prefixes ending in "_" or "-"
 * (x-api-key, sanas_user_id) and a camel-case one (sanasUserId, authToken):
 * the names redactObject hides. The value is a quoted string or a bare word;
 * an object or array value is left to the other rules. (Every part of the
 * name has a bounded length and ends where the next one begins, so the
 * search stays linear.)
 */
const FIELD =
  /(?<![A-Za-z0-9])((?:[a-z0-9]{1,20}[_-]){0,3}[a-z0-9]{0,20}?(?:token|api[_-]?key|user[_-]?id|group[_-]?id|secret|password|cookie|credentials?))(\\?["']?)(\s*[:=]\s*)(\\"(?:[^"\\]|\\[^"])*\\"|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s"'`,;&)}\]>{[][^\s"'`,;&)}\]>]*)/gi;

/** Values that say a field is empty: nothing to hide, and worth seeing in a report. */
const EMPTY_VALUE = /^(?:null|undefined|true|false|""|''|\\"\\")$/i;

/**
 * A JSON Web Token: base64url header "eyJ…" (it starts with {"), payload,
 * signature. Only where a token can start: inside a longer run it is caught
 * by LONG_RUN, and trying every "eyJ" in a run would make the search quadratic.
 */
const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*/g;

/** Secret and publishable API keys (sk_live_…, pk_test_…). */
const PREFIXED_KEY = /\b(?:sk|pk)[_-][A-Za-z0-9_-]{8,}/g;

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** Chromium's device ids: 64 hex digits (a hash, but it identifies this PC's devices). */
const HEX_ID = /\b[0-9a-f]{64}\b/gi;

/**
 * A key in standard base64 ("+", "/", "=" padding), which those characters
 * would split into runs too short for LONG_RUN: 32 or more of
 * [A-Za-z0-9+/_~-] (and its padding) with "+", "/" or "~" in it and upper
 * case, lower case and digits mixed. URLs (scheme://…, the first
 * alternative) are passed over whole: their paths are words, numbers and
 * slashes, and the other rules still hide what a URL can carry (passwords,
 * query tokens, JWTs, long ids). Dots and backslashes end a run, so Windows
 * paths and file names stay too.
 */
const BASE64_RUN = /(\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s"'<>]*)|[A-Za-z0-9+/_~-]{32,}={0,2}/gi;

/** Any long run of key characters: no word, path part or number in an ordinary log is this long. */
const LONG_RUN = /[A-Za-z0-9_-]{32,}/g;

/** True for a BASE64_RUN match that is a key-like run (not a URL). */
const isBase64Key = (m, url) => url === undefined && /[+/~]/.test(m) && /[A-Z]/.test(m) && /[a-z]/.test(m) && /[0-9]/.test(m);

function hideField(match, key, quote, sep, value) {
  if (EMPTY_VALUE.test(value)) return match;
  let hidden;
  if (value.startsWith('\\"')) hidden = `\\"${REDACTED}\\"`;
  else if (value[0] === '"' || value[0] === "'") hidden = value[0] + REDACTED + value[0];
  // A bare value after a JSON key ("user_id": 12345): quote it, so the JSON still parses.
  else if (quote.endsWith('"') && sep.includes(":")) hidden = quote.startsWith("\\") ? `\\"${REDACTED}\\"` : `"${REDACTED}"`;
  else hidden = REDACTED;
  return key + quote + sep + hidden;
}

/**
 * Text with every secret replaced by "[redacted]": JWTs, "Bearer <token>"
 * and Authorization credentials, sk_/pk_ API keys, any run of 32 or more
 * [A-Za-z0-9_-] characters, base64 keys (32 or more characters with "+" or
 * "/", mixed case and digits), 64-hex device ids, UUIDs, passwords in URLs,
 * and the values of access_token / user_id / group_id / apiKey (and other
 * token, secret, password, cookie and credential) fields, also as
 * x-api-key, user-id or camel-case names like sanasUserId. Ordinary text is
 * returned unchanged, and redacting twice changes nothing more. Anything
 * that is not a string is turned into one first (null and undefined into "").
 * @param {string} text
 * @returns {string}
 */
export function redact(text) {
  if (text === null || text === undefined) return "";
  let s = typeof text === "string" ? text : String(text);
  s = s.replace(URL_CREDENTIALS, `$1${REDACTED}@`);
  s = s.replace(AUTH_HEADER, (m, head, scheme) => head + (scheme ?? "") + REDACTED);
  s = s.replace(BEARER, `$1 ${REDACTED}`);
  s = s.replace(FIELD, hideField);
  // Whole base64 keys first: a rule below that hid one part of a key would leave the rest of it visible.
  s = s.replace(BASE64_RUN, (m, url) => (isBase64Key(m, url) ? REDACTED : m));
  s = s.replace(JWT, REDACTED);
  s = s.replace(PREFIXED_KEY, REDACTED);
  s = s.replace(UUID, REDACTED);
  s = s.replace(HEX_ID, REDACTED);
  // A run of only dashes or underscores is a separator line, not a key.
  s = s.replace(LONG_RUN, (m) => (/[A-Za-z0-9]/.test(m) ? REDACTED : m));
  return s;
}

/** Field names whose values are hidden whatever they hold. */
const SECRET_FIELD = /token|api[-_]?key|secret|password|credential|cookie|device[-_]?id|user[-_]?id|group[-_]?id|authorization/i;

/** Deeper than this is not a diagnostics object; stop rather than recurse forever. */
const MAX_DEPTH = 64;

/** Null, undefined, "" and booleans carry no secret: shown as they are, even under a secret name. */
const holdsSomething = (v) => v !== undefined && v !== null && v !== "" && typeof v !== "boolean";

/** Set a property on a plain object, "__proto__" included (as an own property, not the prototype). */
function define(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

function copy(value, secret, ancestors, depth) {
  if (secret && holdsSomething(value)) return REDACTED;
  if (typeof value === "string") return redact(value);
  if (typeof value === "function" || typeof value === "symbol") return undefined; // as JSON.stringify drops them
  if (value === null || typeof value !== "object") return value; // numbers, booleans, bigint, undefined
  if (ancestors.has(value)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[too deep]";
  ancestors.add(value);
  try {
    const next = (v, isSecret = false) => copy(v, isSecret, ancestors, depth + 1);
    if (Array.isArray(value)) return value.map((v) => next(v));
    if (ArrayBuffer.isView(value)) return typeof value.slice === "function" ? value.slice() : value; // samples, levels
    if (typeof value.toJSON === "function") return next(value.toJSON()); // Date, URL: what JSON would show
    if (value instanceof Map) return [...value].map(([k, v]) => [next(k), next(v, typeof k === "string" && SECRET_FIELD.test(k))]);
    if (value instanceof Set) return [...value].map((v) => next(v));
    const out = {};
    const isError = value instanceof Error;
    if (isError) {
      // name and message are not own enumerable properties: copy them by hand.
      define(out, "name", redact(value.name));
      define(out, "message", redact(value.message));
    }
    for (const [key, v] of Object.entries(value)) {
      if (isError && (key === "name" || key === "message")) continue; // copied above
      // Two keys that are secrets themselves both become "[redacted]": number the
      // later ones, so no value silently replaces another.
      const safe = redact(key);
      let name = safe;
      for (let i = 2; Object.prototype.hasOwnProperty.call(out, name); i++) name = `${safe}#${i}`;
      define(out, name, next(v, SECRET_FIELD.test(key)));
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * A deep copy of `value` that is safe to show or send: the value of every
 * field whose name matches token / apiKey / api_key / secret / password /
 * credential / cookie / deviceId / user_id / group_id / authorization becomes
 * "[redacted]" (unless it is empty: null, "", a boolean), and every other
 * string goes through redact(). Errors become {name, message, ...}, Dates and
 * URLs their JSON text, Maps and Sets arrays; functions are dropped and
 * cycles become "[circular]". The input is not changed.
 * @param {*} value
 * @returns {*}
 */
export function redactObject(value) {
  return copy(value, false, new Set(), 0);
}
