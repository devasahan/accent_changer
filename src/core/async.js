/**
 * Small promise helpers shared by the probe and the app.
 */

/** The error an aborted operation rejects with (name "AbortError"). */
export function abortError() {
  const e = new Error("Cancelled.");
  e.name = "AbortError";
  return e;
}

/** Resolve `promise`, or reject after `ms` with `message`, or as soon as `signal` aborts. */
export function settle(promise, { ms, message, signal }) {
  let timer;
  let onAbort;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
      onAbort = () => reject(abortError());
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    }),
  ]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  });
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
