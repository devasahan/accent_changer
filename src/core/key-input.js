/**
 * Cleaning up a pasted API key: what arrived from a hidden terminal prompt
 * or a password field. Shared by the probe's server and the app.
 */

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
