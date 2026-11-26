/**
 * Plain-English hints for the Sanas SDK's error codes. The probe page and the
 * app fix the same problems in different places (a local server holds the
 * key for the probe; the app keeps it in Windows Credential Manager).
 */

const COMMON = {
  model_not_entitled: "Your project isn't entitled to that model name. Copy the exact name (with any suffix) from the Sanas Console.",
  feature_not_entitled: "Remote Inferencing (accent translation) isn't enabled for your account. Ask Sanas support to enable it.",
  unsupported_sample_rate: "Use 8000, 16000 or 48000 Hz.",
  network_error: "A request to Sanas failed: check the internet connection, or a firewall blocking WebSockets.",
};

export const HINTS = {
  probe: {
    ...COMMON,
    origin_not_allowed: "Add this page's origin (e.g. http://localhost:8080) under Project settings → Allowed origins in the Sanas Console.",
    authentication_failed:
      "Sanas refused the key. Stop the server, start it again and paste the key once (the server says whether Sanas accepts it); if it is still refused, check in the Sanas Console whether the key expired or was revoked.",
  },
  app: {
    ...COMMON,
    origin_not_allowed:
      "Add http://tauri.localhost under Project settings → Allowed origins in the Sanas Console (exactly, no slash at the end), then press Connect only again.",
    authentication_failed:
      "Sanas refused the saved key. Paste it again from where you saved it (for example your password manager) and press Save key; if it is still refused, check in the Sanas Console whether it expired or was revoked.",
  },
};

// The app's own text for a saved key that Sanas refuses (src-tauri/src/sanas.rs):
// it already says what to do.
const SAYS_WHAT_TO_DO = /refused the saved key/i;

/**
 * An Error with the SDK's message, its code in brackets, and what to do.
 * The SDK files every failed token request under authentication_failed, also
 * when the key was never asked about (no key saved, Sanas unreachable, too
 * many requests): then the message already says what to do, and the key hint
 * would send the person to the Sanas Console for nothing. So the key hint
 * comes only with a refusal (HTTP 400, 401 or 403) in the message, and not
 * when the message is the app's own refusal text, which gives the same advice.
 */
export function describeSdkError(err, { where = "probe" } = {}) {
  const code = err?.code;
  const message = String(err?.message ?? err);
  const hints = HINTS[where] ?? HINTS.probe;
  let hint = code && hints[code] ? ` ${hints[code]}` : "";
  const status = Number(/HTTP (\d{3})/.exec(message)?.[1]);
  if (code === "authentication_failed" && (![400, 401, 403].includes(status) || SAYS_WHAT_TO_DO.test(message))) hint = "";
  const e = new Error(`${message}${code ? ` [${code}]` : ""}.${hint}`);
  e.code = code;
  return e;
}
