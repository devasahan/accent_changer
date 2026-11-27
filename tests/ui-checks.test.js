// Step 3 of the page (src/ui/checks.js): the Session B checklist's marks and
// colours, the delay's colour, the long check's lines while it runs and when
// it is done, and what Hide says. The marks and kinds are typed here on
// purpose (spec §6.1, §6.3, §6.4): the test must not take them from the code
// it checks. The page itself is covered by tests/browser/app.cjs; here a few
// page elements are faked, just enough for the view.
import test from "node:test";
import assert from "node:assert/strict";
import { CHECKS_TEXTS, ChecksView, delayKind, delayText, gateItem, hideText, longDone, longProgressText } from "../src/ui/checks.js";

/** A page element as the view uses it: text, children, dataset. */
function element(doc, tag = "") {
  return {
    tag,
    ownerDocument: doc,
    children: [],
    dataset: {},
    text: "",
    get textContent() {
      return this.children.length ? this.children.map((c) => (c.tag === "br" ? "\n" : c.textContent)).join("") : this.text;
    },
    set textContent(value) {
      this.children = [];
      this.text = String(value);
    },
    replaceChildren(...nodes) {
      this.children = nodes;
      this.text = "";
    },
  };
}

function page() {
  const doc = {
    createElement: (tag) => element(doc, tag),
    createTextNode: (text) => Object.assign(element(doc, "#text"), { text }),
  };
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) els.set(id, element(doc));
    return els.get(id);
  };
  return { view: new ChecksView({ $ }), $ };
}

test("gateItem: each status has its mark and its colour (✓ ok, ✗ error, … info, ! warn)", () => {
  const rows = [
    [{ row: "Secure page", status: "pass", text: "The app's page is a secure page." }, "✓ · Secure page · The app's page is a secure page.", "ok"],
    [{ row: "Voice into CABLE Input", status: "fail", text: "Refused." }, "✗ · Voice into CABLE Input · Refused.", "error"],
    [{ row: "Connect only", status: "todo", text: "Press it." }, "… · Connect only · Press it.", "info"],
    [{ row: "Delay at most 120 ms", status: "note", text: "Close." }, "! · Delay at most 120 ms · Close.", "warn"],
  ];
  for (const [row, text, kind] of rows) assert.deepEqual(gateItem(row), { text, kind }, row.status);
  // Anything else is shown as not done yet, never as passed.
  assert.deepEqual(gateItem({ row: "X", status: "maybe", text: "?" }), { text: "… · X · ?", kind: "info" });
});

test("renderGate: the checklist shows every row with its mark and data-kind", () => {
  const { view, $ } = page();
  view.renderGate([
    { row: "Secure page", status: "pass", text: "Yes." },
    { row: "Connect only", status: "fail", text: "No." },
    { row: "Zoom's Test Mic hears you", status: "todo", text: "Your note." },
    { row: "Delay at most 120 ms", status: "note", text: "Close." },
  ]);
  const items = $("gateList").children.map((li) => [li.dataset.kind, li.textContent]);
  assert.deepEqual(items, [
    ["ok", "✓ · Secure page · Yes."],
    ["error", "✗ · Connect only · No."],
    ["info", "… · Zoom's Test Mic hears you · Your note."],
    ["warn", "! · Delay at most 120 ms · Close."],
  ]);
});

test("delayKind: good is green; too slow and a silent CABLE Output are red; the rest yellow", () => {
  const kinds = { good: "ok", borderline: "warn", slow: "error", unclear: "warn", "silent-mic": "warn", "silent-cable": "error" };
  for (const [verdict, kind] of Object.entries(kinds)) assert.equal(delayKind(verdict), kind, verdict);
  assert.equal(delayKind(undefined), "warn");
});

test("delayDone: the delay's text and notes, coloured by its verdict", () => {
  const { view, $ } = page();
  const good = { verdict: "good", text: "Delay through VB-CABLE: about 64 ms (± 10). Good.", notes: ["A note."] };
  assert.equal(delayText(good), "Delay through VB-CABLE: about 64 ms (± 10). Good. A note.");
  view.delayDone(good);
  assert.equal($("measureInfo").textContent, "Delay through VB-CABLE: about 64 ms (± 10). Good. A note.");
  assert.equal($("measureInfo").dataset.kind, "ok");
  view.delayDone({ verdict: "slow", text: "Delay through VB-CABLE: about 150 ms (± 10). Too slow." });
  assert.equal($("measureInfo").dataset.kind, "error");
  view.delayProgress(8.6);
  assert.equal($("measureInfo").textContent, CHECKS_TEXTS.measuring(9));
  assert.equal($("measureInfo").dataset.kind, undefined);
});

test("longDone: passed is green; a setting to change is yellow; not passed and nothing measured are red", () => {
  const lines = ["65 min recorded: 31 min minimized, 29 min hidden, 5 min open.", "Gaps: none."];
  assert.deepEqual(longDone({ verdict: "pass", reasons: [], lines, notes: ["A note."] }), {
    head: "Long check done: passed.",
    lines: [...lines, "A note."],
    kind: "ok",
  });
  assert.deepEqual(longDone({ verdict: "fix-setting", reasons: ["The tone came in at −16.0 dB."], lines: [] }), {
    head: "Long check done: needs a setting change: The tone came in at −16.0 dB.",
    lines: [],
    kind: "warn",
  });
  assert.deepEqual(longDone({ verdict: "fail", reasons: ["The sound stopped once.", "Too many clicks."], lines }), {
    head: "Long check done: not passed: The sound stopped once. Too many clicks.",
    lines,
    kind: "error",
  });
  assert.equal(longDone({ verdict: "no-signal", reasons: ["The test tone never arrived."] }).kind, "error");
  assert.equal(longDone({ verdict: "no-signal", reasons: [] }).head, "Long check done: nothing measured:");
  // The view: the head, then each line; the kind it returns is the status line's.
  const { view, $ } = page();
  assert.equal(view.longDone({ verdict: "fail", reasons: ["The sound stopped once."], lines: ["Gaps: 1 (300 ms)."] }), "error");
  assert.equal($("longInfo").textContent, "Long check done: not passed: The sound stopped once.\nGaps: 1 (300 ms).");
  assert.equal($("longInfo").dataset.kind, "error");
  assert.equal(view.longDone({ verdict: "pass", reasons: [], lines: [] }), "ok");
  assert.equal($("longInfo").dataset.kind, "ok");
});

test("longProgressText: the tone check's line, and the check with the microphone's (drop-outs, no tone)", () => {
  const p = {
    mode: "tone",
    elapsedSec: 750,
    totalSec: 1800,
    phase: "minimized",
    phasesSoFar: { visibleSec: 148, minimizedSec: 602, hiddenSec: 0 },
    ticks: 1,
    gaps: 0,
    dropouts: 0,
    levelDb: -12,
  };
  assert.equal(longProgressText(p), "Long check: 12:30 of 30:00 · now minimized · minimized so far 10:02 · hidden so far 0:00 · tone −12.0 dB · clicks 1 · gaps 0");
  assert.equal(
    longProgressText({ ...p, levelDb: null }),
    "Long check: 12:30 of 30:00 · now minimized · minimized so far 10:02 · hidden so far 0:00 · tone not found yet · clicks 1 · gaps 0",
  );
  // Extended by a Hide: the total goes past the hour.
  assert.match(longProgressText({ ...p, totalSec: 4350, phase: "hidden" }), /^Long check: 12:30 of 1:12:30 · now hidden · /);
  const mic = { ...p, mode: "mic", phase: "visible", phasesSoFar: { visibleSec: 3, minimizedSec: 0, hiddenSec: 0 }, elapsedSec: 3, totalSec: 15, levelDb: null, dropouts: 2, gaps: 1 };
  assert.equal(longProgressText(mic), "Long check: 0:03 of 0:15 · now open · minimized so far 0:00 · hidden so far 0:00 · dropouts 2 · gaps 1");
  assert.ok(!/tone|clicks/.test(longProgressText(mic)));
  assert.equal(longProgressText({ analysing: true, analysingSec: 5 }), "Analysing (about 5 s)…");
  assert.equal(longProgressText(null), "");
});

test("hideText: when the app comes back, and when an extended long check now ends", () => {
  const at = new Date(2026, 10, 27, 14, 2, 0).getTime();
  const showAt = new Date(2026, 10, 27, 14, 32, 0).getTime();
  assert.equal(
    hideText({ at: new Date(at).toISOString(), showAt }),
    "Hidden at 14:02. The app comes back by itself at 14:32 (look for it on the taskbar), or open Accent Changer from the Start menu to bring it back sooner.",
  );
  assert.equal(
    hideText({ at: new Date(at).toISOString(), showAt, longEndsAt: new Date(2026, 10, 27, 14, 34, 0).toISOString() }),
    "Hidden at 14:02. The app comes back by itself at 14:32 (look for it on the taskbar), or open Accent Changer from the Start menu to bring it back sooner. The long check now ends at 14:34.",
  );
});
