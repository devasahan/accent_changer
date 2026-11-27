// README.md's Session B, read the way the user follows it: every step can be
// done without guessing, nothing the session changes on the PC is left
// changed, the times add up, and the Edge comparison measures the Edge page
// alone. The page's own texts are checked by tests/ui-*.test.js and
// tests/browser/app.cjs; this file checks the instructions around them.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const HTML = readFileSync(new URL("../src/index.html", import.meta.url), "utf8");

/** The text between a heading and the next heading of the same level. */
function section(title) {
  const start = README.indexOf(`\n## ${title}`);
  assert.ok(start >= 0, `README has "## ${title}"`);
  const end = README.indexOf("\n## ", start + 4);
  return README.slice(start, end < 0 ? README.length : end);
}

const sessionB = section("Session B: your voice into the meeting");
const [steps, edge] = sessionB.split("**If I ask you to compare with Edge**");
const troubleshooting = section("Troubleshooting");
const privacy = section("Privacy");

/** Session B's numbered steps (top level): { "1": text, …, "12": text }. */
const step = Object.fromEntries(
  steps
    .split(/\n(?=\d+\. )/)
    .slice(1)
    .map((text) => [/^(\d+)\./.exec(text)[1], text]),
);

/** A sub-step of a step ("7.5"): from its number to the next sub-step. */
function subStep(id) {
  const [n, k] = id.split(".");
  const text = step[n];
  const start = text.search(new RegExp(`\\n {3}${k}\\. `));
  assert.ok(start >= 0, `step ${id} exists`);
  const next = text.slice(start + 1).search(/\n {3}\d+\. /);
  return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
}

const beforeYouStart = /\*\*Before you start[^\n]*/.exec(steps)?.[0] ?? "";

/** The rows of the troubleshooting table: [you see, do this]. */
const rows = troubleshooting
  .split("\n")
  .filter((l) => l.startsWith("| ") && !l.startsWith("| You see"))
  .map((l) => l.slice(2, -2).split(" | "));

test("Session B keeps its step numbers (the page's checklist names steps 4 to 10, 7.5 and 7.6)", () => {
  assert.deepEqual(Object.keys(step), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]);
  for (const id of ["2.3", "3.1", "7.1", "7.2", "7.3", "7.4", "7.5", "7.6"]) subStep(id);
  assert.match(step[5], /Zoom's microphone test/);
  assert.match(subStep("7.6"), /Only if it said "Too many clicks"/);
});

test("every link inside the README goes to a heading that exists", () => {
  // GitHub's anchors: lower case, punctuation dropped, spaces to hyphens.
  const anchors = new Set(
    README.split("\n")
      .filter((l) => /^#{1,6} /.test(l))
      .map((l) =>
        l
          .replace(/^#+ /, "")
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\- ]/gu, "")
          .replace(/ /g, "-"),
      ),
  );
  const links = [...README.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
  assert.ok(links.length >= 4);
  for (const link of links) assert.ok(anchors.has(link), `#${link}`);
});

test("U01: Zoom and Meet are set back to the headset where Session B changed them", () => {
  // Zoom keeps the microphone of the last call; CABLE Output is silent once the app is closed.
  assert.match(step[5], /set Zoom back[^.]*: Microphone your headset/);
  assert.match(step[5], /Automatically adjust microphone volume" as it was/);
  assert.match(step[5], /note whether it was ticked/);
  const meet = subStep("7.5");
  assert.match(meet, /set Meet back[^.]*: \*\*⋮\*\* → \*\*Settings\*\* → \*\*Audio\*\* → Microphone your headset/);
  assert.match(meet, /\*\*Leave empty calls\*\* on again/);
  // Set back before leaving the meeting: Meet's settings are reached from inside a call.
  assert.ok(meet.indexOf("set Meet back") < meet.indexOf("Then leave the meeting"), meet);
  const row = rows.find(([seen]) => /After Session B, nobody hears me in Zoom or Meet/.test(seen));
  assert.ok(row, "a troubleshooting row for the next ordinary call");
  assert.match(row[1], /still uses CABLE Output/);
  assert.match(row[1], /Pick your headset as the microphone/);
});

test("U02: the Edge comparison closes the app, uses a fresh download and needs no key", () => {
  assert.ok(edge, "the Edge paragraph");
  assert.match(edge, /\*\*Close Accent Changer\*\*/);
  assert.match(edge, /keeps sending your microphone into CABLE Input/);
  assert.match(edge, /\*\*Download the code again\*\*/);
  assert.match(edge, /\(#before-you-start-once\)/);
  assert.match(edge, /when it asks for the key, just press Enter/);
  assert.match(edge, /http:\/\/localhost:8080\/src\//);
  assert.match(edge, /If Edge asks to use your microphone, allow it/);
  // The Edge page's own results, copied before its window is closed (the page forgets them).
  const copy = edge.indexOf("**Press Copy results** on that page");
  assert.ok(copy > 0 && copy < edge.indexOf("close the test page's window"), edge);
  // Closing the app comes first, after its results are pasted.
  assert.ok(edge.indexOf("**Close Accent Changer**") < edge.indexOf("**Start the test server**"));
});

test("U07: the Edge run is minimized for the whole check and judged on the time off screen", () => {
  assert.match(edge, /Edge has no Hide: in step 7\.3, minimize the window with the test page and set the timer to 65 minutes, and skip step 7\.4/);
  assert.match(edge, /judges an Edge run on the time the page was not on screen/);
  assert.match(edge, /open Meet in a new Edge window \(Ctrl\+N\), not in a new tab/);
});

test("U04: the results are copied after the hour-long check and before Windows Audio restarts", () => {
  assert.match(subStep("7.5"), /Press \*\*Copy results\*\* in the app and paste them into your message \(don't send it yet\)/);
  assert.match(step[9], /^9\. \*\*Restart Windows Audio\*\* \(\d+ min\)\. First press \*\*Copy results\*\*/);
  assert.match(step[11], /this last copy holds everything/);
});

test("U05: step 7.5 says what to do for every result of the long check", () => {
  const s = subStep("7.5");
  assert.match(s, /note its first line/);
  for (const [outcome, todo] of [
    [/\*\*Ended early\*\*, or \*\*nothing measured\*\*/, /do step 7 again once, from 7\.1/],
    [/\*\*Passed\*\*/, /go on/],
    [/\*\*Needs a setting change\*\*/, /do what it says[^.]*\. Tell me in your message before you run the hour again/],
    [/\*\*Not passed\*\* for another reason/, /If one of them says "Too many clicks", do step 7\.6/],
  ]) {
    const line = s.split("\n").find((l) => outcome.test(l));
    assert.ok(line, String(outcome));
    assert.match(line, todo);
  }
});

test("U06: the long checks ask the user not to press the headset's mute button", () => {
  assert.match(subStep("7.1"), /don't press your headset's mute button/);
  assert.match(step[8], /without pressing your headset's mute button/);
  assert.match(subStep("7.6"), /no mute button/);
});

test("U08: every Session B step has a time, and they add up to the times the README states", () => {
  const minutes = (text) => {
    const m = /\((?:about )?(\d+) min[;)]/.exec(text.split("\n")[0]);
    assert.ok(m, `a time in: ${text.split("\n")[0]}`);
    return Number(m[1]);
  };
  const before = Number(/\((\d+) min\)/.exec(beforeYouStart)?.[1]);
  assert.ok(before > 0, `a time for Before you start: ${beforeYouStart}`);
  const total = before + Object.values(step).reduce((sum, text) => sum + minutes(text), 0);
  // "about 2¼ hours in all", in the section and in "What to do, in order".
  assert.match(steps, /It takes about 2¼ hours in all/);
  assert.match(README, /Session B build is ready\*\* \(about 2¼ hours in all, about 80 minutes of it with you; about 35 minutes more if its step 7\.6 is needed\)/);
  assert.ok(Math.abs(total - 135) <= 10, `the steps add up to ${total} min`);
  // The long check itself: 30 minutes minimized, 30 hidden, the start and the end.
  assert.ok(minutes(step[7]) >= 70, "step 7");
  assert.match(steps, /If step 7\.6 is needed, it adds about 35 minutes/);
});

test("U09: Session B's Windows paths work on Windows 10 as well as 11", () => {
  assert.match(beforeYouStart, /On Windows 10: Windows Settings → System → \*\*Power & sleep\*\* → "When plugged in, PC goes to sleep after" → \*\*Never\*\*/);
  assert.match(beforeYouStart, /Note what it said before, so you can set it back/);
  assert.match(subStep("3.1"), /On Windows 10: Windows Settings → Apps → Apps & features → \*\*Accent Changer\*\* → \*\*Uninstall\*\* → \*\*Uninstall\*\*/);
  assert.match(step[12], /Set the sleep setting back as you noted it/);
});

test("critic-02: the laptop stays open, so no sleep spoils the long check", () => {
  assert.match(beforeYouStart, /\*\*Keep the laptop open\*\* until the end: closing the lid puts it to sleep even with this setting/);
  assert.match(subStep("7.3"), /Leave the laptop open and plugged in/);
  assert.ok(rows.some(([seen, todo]) => /lid was closed/.test(seen) && /do step 7 again/.test(todo)));
});

test("U16: the Privacy section names the settings file and says what the log holds", () => {
  assert.match(privacy, /%LOCALAPPDATA%\\io\.github\.devasahan\.accentchanger\\settings\.json/);
  assert.match(privacy, /with their Windows names and ids/);
  assert.match(privacy, /\*\*Delete the application data\*\* removes them, the log, and the microphone permission/);
  assert.match(privacy, /The log holds state names, codes, timings and short error sentences: never a device name, a device id, a key or a token/);
  assert.doesNotMatch(privacy, /codes and numbers only/);
  assert.match(privacy, /left out of screen sharing, recordings and screenshots/);
});

test("U17: the tone row warns that Stop and check ends the long check early", () => {
  const row = rows.find(([seen]) => seen === "The meeting hears a tone");
  assert.ok(row);
  assert.match(row[1], /expected until it says done/);
  assert.match(row[1], /the check then ends early, and step 7 must be done again/);
});

test("U20: the small gaps in Session B's steps are filled", () => {
  assert.match(step[1], /click the folder icon next to the file \(\*\*Show in folder\*\*\), then right-click the zip/);
  assert.match(subStep("2.1"), /neither the green tick nor the green phone sign/);
  assert.match(subStep("2.3"), /neither the green tick nor the green phone sign/);
  assert.match(step[4], /no warnings: lines in brown or yellow/);
  assert.doesNotMatch(step[4], /yellow warnings/);
  assert.match(subStep("7.2"), /If Edge asks whether Meet may use your microphone and camera, allow it/);
  assert.match(subStep("7.2"), /\*\*Copy joining info\*\*, and send that to your phone/);
  assert.match(subStep("7.2"), /press \*\*Admit\*\* on the laptop/);
  assert.match(subStep("7.4"), /If it isn't back after 32 minutes, open it from the Start menu and note the time/);
  assert.match(step[8], /note the first line of the result/);
  assert.match(step[11], /your notes from steps 4, 5, 6, 7\.4, 7\.5, 8 and 9/);
  // Step 7.6 sends the user to Advanced by the README alone.
  assert.match(HTML, /<summary>Advanced \(only when the README or I ask\)<\/summary>/);
});

test("U03: the README says what to do when the bottom of the page is out of reach", () => {
  assert.match(step[4], /If you can't reach the bottom of the page \(\*\*Copy results\*\*, in step 6 of the page\), maximize the window: double-click its title bar/);
});

test("U21: the top of the README says where the work is, and its two rules are the test page's", () => {
  assert.doesNotMatch(README, /\*\*Status: Step 0\.\*\*/);
  assert.match(README, /\*\*Status: Step 2\.\*\* The app's test build for \[Session B\]/);
  assert.match(README, /Two rules for every sitting with the test page \(Parts 1 and 2; the app in Sessions A2 and B has \*\*Copy results\*\* instead\):/);
});

test("U23: the page's own words fit any PC, not only a laptop (the friend's may be a desktop)", () => {
  assert.match(HTML, /and checks that this works on this PC\./);
  for (const [name, text] of [
    ["src/index.html", HTML],
    ["src/ui/voice.js", readFileSync(new URL("../src/ui/voice.js", import.meta.url), "utf8")],
    ["src/ui/checks.js", readFileSync(new URL("../src/ui/checks.js", import.meta.url), "utf8")],
  ]) {
    assert.doesNotMatch(text, /laptop/i, name);
  }
});

test("the troubleshooting table keeps two cells in every row", () => {
  assert.ok(rows.length >= 25, String(rows.length));
  for (const row of rows) assert.equal(row.length, 2, row.join(" | "));
});
