// Your friend's voice test and the order of work, as README.md, INTERVIEW.md
// and spike/FINDINGS.md tell them, checked against the test page's own words.
// Your friend is the app's main user: their voice is tested on your laptop,
// on your key, and their script and results stay apart from yours.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const README = read("README.md");
const INTERVIEW = read("INTERVIEW.md");
const FINDINGS = read("spike/FINDINGS.md");
const PAGE = read("spike/index.html") + read("spike/probe.js");

/** The text from a heading to the next heading of the same level or higher. */
function section(doc, title, level = 2) {
  const mark = `\n${"#".repeat(level)} ${title}`;
  const start = doc.indexOf(mark);
  assert.ok(start >= 0, `has "${mark.trim()}"`);
  const rest = doc.slice(start + mark.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return mark + (next < 0 ? rest : rest.slice(0, next));
}

const order = section(README, "What to do, in order");
const friendTest = section(README, "Your friend's voice test", 3);
const part2 = section(README, "Part 2: compare the ready-made apps");
const friendPc = section(README, "Later, on your friend's PC");
const troubleshooting = section(README, "Troubleshooting");

/** The friend's test's numbered steps (top level): { "1": text, … }. */
const step = Object.fromEntries(
  friendTest
    .split(/\n(?=\d+\. )/)
    .slice(1)
    .map((text) => [/^(\d+)\./.exec(text)[1], text]),
);
/** What comes before step 1: the opening lines and "Before the sitting". */
const beforeSteps = friendTest.split(/\n(?=1\. )/)[0];

/** A line of a step: the first one that matches, or "". */
const lineOf = (text, re) => text.split("\n").find((l) => re.test(l)) ?? "";

test("the order: Part 1, then your friend's voice test, then Part 2 any time after Part 1", () => {
  const at = (re) => order.search(re);
  assert.ok(at(/\*\*Part 1, now:\*\*/) >= 0);
  assert.ok(at(/\*\*Your friend's voice test,/) > at(/\*\*Part 1, now:\*\*/));
  assert.ok(at(/\*\*Part 2, any time after Part 1\*\*/) > at(/\*\*Your friend's voice test,/));
  assert.match(order, /\(#your-friends-voice-test-about-45-minutes\)/);
  assert.match(order, /the decision waits for this test/);
  assert.match(order, /\(#later-on-your-friends-pc\)/);
  assert.match(order, /\*\*Send me the results file\*\* after every sitting \(your friend's file only with their agreement\)/);
  assert.match(README, /^## Part 2: compare the ready-made apps \(any time after Part 1\)$/m);
});

test("no interview date drives the order; the trial timing and what comes after the trials live in INTERVIEW.md", () => {
  assert.doesNotMatch(README, /5–6 days before/);
  assert.doesNotMatch(order, /Our own app can't be ready in time/);
  assert.match(README, /\*\*An interview before our app is ready\?\*\* Only then follow \[INTERVIEW\.md\]\(INTERVIEW\.md\)/);
  assert.match(INTERVIEW, /\*\*When to do Part 2:\*\* if you haven't done it yet, 5–6 days before the interview\. The free trials last 7 days each/);
  assert.match(
    INTERVIEW,
    /\*\*If you already did Part 2 and its trials have ended,\*\* the app that passed costs money from then on: Krisp about \$15–30 a month for a plan whose daily minutes cover a 90-minute interview \(its \$8–16 plan gives only 1 hour a day; prices not checked\)/,
  );
  assert.doesNotMatch(INTERVIEW, /can wait/);
});

test("after the trials, the Krisp price is for a plan whose daily minutes carry the interview", () => {
  // FINDINGS: the $8–16 plan converts 1 hour a day, too little for a 90-minute interview plus checks.
  assert.match(FINDINGS, /Core about \$8\/month paid yearly or \$16 monthly, with 1 h\/day of conversion; Advanced about \$15 \/ \$30 with 4 h\/day; 7-day trial \[unverified\]/);
  assert.doesNotMatch(README + INTERVIEW, /Krisp about \$8–16 a month/);
  // INTERVIEW's bar and its day count the paid plan's daily minutes too, not only the trial's.
  assert.match(INTERVIEW, /\| Daily limit \| the trial's, or the paid plan's, minutes of accent conversion per day cover the interview \(plan 90 minutes\) plus your checks \|/);
  assert.match(INTERVIEW, /Keep your own check short \(a minute\): the trial's, or the paid plan's, daily minutes count\./);
  // The prices are not checked: Part 2's look at the sign-up pages notes the paid plans' minutes too.
  assert.match(part2, /\n- the price after the trial, and how many minutes a day of accent conversion each paid plan gives;\n/);
});

test("Part 2 says it uses up both free trials, and what the apps cost after them", () => {
  assert.match(order, /It uses up both apps' free trials, so read "An interview before our app is ready\?" below this list first/);
  assert.match(part2, /Part 2 starts both free trials, and a free trial can usually be used only once/);
  assert.match(
    part2,
    /using Krisp or the Sanas desktop app in an interview means paying\. Krisp is about \$15–30 a month for a plan whose daily minutes cover a 90-minute interview \(its \$8–16 plan gives only 1 hour a day; prices not checked\)\. The Sanas desktop app's price after its trial is not published\./,
  );
  assert.match(FINDINGS, /a ready-made app that passes the bar in \[INTERVIEW\.md\]\(\.\.\/INTERVIEW\.md\) \(a paid plan once its free trial has ended\)/);
});

test("your friend agrees before the sitting, and a Part 2 sitting finishes Part 2 before their test", () => {
  // Their voice goes through Sanas on your account, their lines stay in Edge, their file comes to me: they agree first.
  const ask = lineOf(beforeSteps, /\*\*Ask your friend first\.\*\*/);
  assert.match(ask, /their voice goes through Sanas cloud on your account/);
  assert.match(ask, /their 15 lines stay in Edge on your laptop until you remove them/);
  assert.match(ask, /the results file \(their lines, no audio\) comes to me/);
  assert.match(ask, /Go ahead only if they agree\./);
  assert.match(friendTest, /\*\*Send me the file:\*\* your friend agreed to that before the sitting\./);
  assert.doesNotMatch(friendTest, /once your friend agrees/);
  // The reload in step 1 would throw away the sound that Part 2's blind test plays.
  assert.match(beforeSteps, /In a Part 2 sitting, finish Part 2 first, including its blind test \(step 5\) and its download \(step 6\)/);
  assert.match(part2, /Your friend, the app's main user, can be that listener: then do \[their voice test\]\(#your-friends-voice-test-about-45-minutes\) after step 6\./);
  // Older code: a new folder, a terminal there, and the time it takes.
  const oldCode = lineOf(beforeSteps, /has no \*\*Whose voice\*\*/);
  assert.match(oldCode, /\(or from the link I send\), into a new folder\. Open a terminal in that folder \(step 3 there\) and start the server from it/);
  assert.match(oldCode, /about 15 minutes more/);
  // The old server goes first: on its busy port the new one stops and names another port, and the page on that
  // new address would forget your script (the browser keeps it per address), ask for the microphone again,
  // and need one more Allowed origin.
  assert.match(oldCode, /^- If step 1 of the page has no \*\*Whose voice\*\*, first stop the server if it is running \(Ctrl\+C in its window\)\. Then download the code again/);
  assert.match(oldCode, /the same way as before \(with `--port 8090` if you used that\)\. Use this new folder from now on\./);
  assert.match(oldCode, /The page still remembers your own script\./);
});

test("your friend's voice test: your key stays yours, and Whose voice is set before their lines are pasted", () => {
  assert.match(friendTest, /never sees or gets your key/);
  assert.match(step[1], /^1\. \*\*Before your friend sits down/);
  assert.match(step[1], /so that your key is no longer on the clipboard/);
  // A page left open from your own sitting: download, start the server again if it was stopped, then reload.
  const open = lineOf(step[1], /If the page is still open from your own sitting/);
  assert.match(open, /press \*\*Download results \(JSON\)\*\*\. If you stopped the server, start it again \(Part 1, step 2\)\. Then reload the page \(F5\)/);
  assert.match(step[2], /set \*\*Whose voice\*\* to \*\*Your friend's\*\*/);
  assert.match(step[2], /If it shows your own lines, Whose voice is still \*\*Yours\*\*/);
  // Their lines are copied from their message first: the clipboard holds only the word from step 1.
  assert.match(step[3], /Open your friend's message on this laptop[^.]*, select their 15 lines and press Ctrl\+C\. Then click in step 2's box, press Ctrl\+A, then Ctrl\+V\./);
  assert.match(step[3], /`AT5\.2_Masculine` and `AT5\.2_Feminine`, the one that matches their voice \(unless I ask you for a retest with the other one\)/);
  assert.match(friendTest, /never Bluetooth/);
  assert.match(friendTest, /ear cushions wiped/);
});

test("your friend's voice test: the runs, the ratings, the file that says it is theirs, the time and the cost", () => {
  assert.match(step[6], /only with your friend's own headset/);
  assert.match(step[7], /\*\*16 kHz\*\*/);
  assert.match(step[7], /\*\*48 kHz\*\*/);
  assert.match(step[7], /rated right after it/);
  // A dropped run doesn't count (FINDINGS): it is run again at its own sample rate.
  assert.match(step[7], /If a run says it "dropped the call", press \*\*Run\*\* again at the same sample rate, and your friend rates the new run\./);
  // 6–7 is "their call" in FINDINGS: their answer goes into the results file.
  assert.match(step[7], /If a run's \*\*Score\*\* in step 4 is from 6\.0 to 7\.9, ask your friend whether they would use it in an interview as it is, and type their answer in \*\*Notes\*\*/);
  assert.match(step[8], /\*\*Start live\*\*/);
  assert.match(step[9], /`sanas-check-friend-`/);
  assert.match(step[9], /Don't download a WAV/);
  assert.match(friendTest, /about 6 minutes of Sanas time, about \$0\.05 of your credit/);
  // Every step has a time, and they add up to the heading's.
  const total = Object.values(step).reduce((sum, text) => {
    const m = /\((?:about )?(\d+) min[,;)]/.exec(text.split("\n")[0]);
    assert.ok(m, `a time in: ${text.split("\n")[0]}`);
    return sum + Number(m[1]);
  }, 0);
  const said = Number(/\(about (\d+) minutes\)/.exec(friendTest.split("\n")[1])?.[1]);
  assert.ok(said > 0 && Math.abs(total - said) <= 5, `steps ${total} min, heading ${said} min`);
});

test("your friend's voice test leaves nothing of theirs behind: the tab is closed, and your headset and sample rate come back", () => {
  // The tab is closed after the download, so the next sitting starts on a fresh page, on Yours.
  const download = step[9].indexOf("Press **Download results (JSON)**");
  const close = step[9].indexOf(`Close the page's tab. Edge asks "Leave site?": you have downloaded, so choose **Leave**.`);
  assert.ok(download > 0 && close > download, step[9]);
  // Your friend's headset: the default playback device (Sanas plays there), with the clicks, and back again.
  assert.match(step[4], /press Windows key \+ R, type `mmsys\.cpl` and press Enter → \*\*Playback\*\* → right-click their headset → \*\*Set as Default Device\*\*/);
  assert.match(step[9], /If your friend used their own headset: unplug it, and make your headset's headphones the default playback device again/);
  const headsetBack = lineOf(step[9], /If your friend used their own headset/);
  assert.match(headsetBack, /The next time you open the page, pick your headset in its step 1\.$/);
  // One Sample rate is kept for both of you, and your friend's test ends on 48 kHz with either headset,
  // so the check of the rate is not only for their own headset.
  assert.match(PAGE, /for \(const id of \["mic", "out", "pairDevice", "rate"\]\) \$\(id\)\.addEventListener\("change", \(\) => remember\(id, \$\(id\)\.value\)\);/);
  assert.match(step[7], /\n {3}3\. Set Sample rate to \*\*48 kHz\*\*, press \*\*Run\*\*/);
  assert.doesNotMatch(headsetBack, /Sample rate/);
  const sendMe = lineOf(friendTest, /^\*\*Send me the file:\*\*/);
  assert.match(
    sendMe,
    /The next time you open the page, it is back on \*\*Yours\*\*, with your own script and model name\. Its Sample rate stays on the last one your friend's test used \(48 kHz\): check it in step 1 of the page before your next run\.$/,
  );
});

test("troubleshooting: lines pasted under Yours, and a dropped run", () => {
  const row = troubleshooting.split("\n").find((l) => l.startsWith("| Your own script was replaced by your friend's lines |")) ?? "";
  assert.match(row, /If \*\*Whose voice\*\* is grey \(your friend already recorded or ran, or Notes has text\), press \*\*Download results \(JSON\)\*\* and tell me that this file holds your friend's voice/);
  assert.match(row, /start again from step 3 of \[Your friend's voice test\]\(#your-friends-voice-test-about-45-minutes\)/);
  assert.match(row, /type your own model name again if it changed/);
  const dropped = troubleshooting.split("\n").find((l) => l.startsWith('| A run reports "dropped the call" |')) ?? "";
  assert.match(dropped, /press \*\*Run\*\* again at the same sample rate: a dropped run doesn't count/);
});

test("Whose voice outside your friend's test: the two rules, step 3.11, Troubleshooting, Privacy and FINDINGS", () => {
  // The second rule for every sitting: what the page remembers, for each of you.
  assert.match(
    README,
    /The page remembers your script text and model name \(your friend's apart from yours\), the sample rate and devices, but not your recording, runs, ratings or notes\./,
  );
  // Part 1, step 3.11: what the results file holds.
  assert.match(README, /\n {7}- the browser version, whose voice it is, and the script text if you changed it;\n/);
  // Troubleshooting: Whose voice is grey. The page's own hint says the same: download, then reload.
  const grey = troubleshooting.split("\n").find((l) => l.startsWith("| **Whose voice** is grey |")) ?? "";
  assert.match(
    grey,
    /\| The page holds a recording, runs or notes\. Press \*\*Download results \(JSON\)\*\*, then reload the page \(F5\) and choose \*\*Reload\*\*\. It is also grey while a step runs\. \|$/,
  );
  assert.match(PAGE, /"To change it, download the results \(step 8\), then reload the page\."/);
  assert.match(PAGE, /<h2>8 · Save<\/h2>[^]*?>Download results \(JSON\)</);
  // Privacy: the test runs on your key, which your friend never gets; their lines stay apart and can be removed.
  const privacy = section(README, "Privacy");
  const bullet = lineOf(privacy, /^- \*\*Your friend's voice test:\*\*/);
  assert.match(bullet, /^- \*\*Your friend's voice test:\*\* it runs on your key, in the test server's memory; your friend never sees or gets it\./);
  assert.match(bullet, /The page keeps your friend's script and model name in Edge on your laptop, apart from yours\./);
  assert.match(bullet, /To remove them, set \*\*Whose voice\*\* to \*\*Your friend's\*\* and delete all of step 2's text and the model name\./);
  assert.match(bullet, /Their results file holds their script \(their name and past employers\), but no audio\.$/);
  // FINDINGS, "What the probe measures": the Whose voice bullet, with the page's own field and file names.
  const probe = section(FINDINGS, "What the probe measures");
  const whose = lineOf(probe, /^- \*\*Whose voice\*\* \(step 1\)/);
  assert.match(whose, /^- \*\*Whose voice\*\* \(step 1\): yours or your friend's \(README, Part 1, "Your friend's voice test"\)\./);
  assert.match(whose, /Each person has their own remembered script and model name\./);
  assert.match(whose, /the choice can change only on a page that holds no recording, run or note, so one results file holds one voice\./);
  assert.match(whose, /\(`speaker`: `you` or `friend`, also in every run's `settings`; schema 4\), and your friend's files are named `sanas-check-friend-…`\./);
  assert.match(PAGE, /schema: 4, \/\/ 4: adds speaker/);
});

test("Part 2 and INTERVIEW speak of the blind listener and of an interview, not of your friend or the interview day", () => {
  // Your friend may be the blind listener, but need not be; Part 2 no longer leads to an interview date.
  assert.match(part2, /The page keeps the sound of only the last 6 runs, and only while it stays open; the listener in step 5 hears them at the end\./);
  assert.doesNotMatch(README, /your friend listens to them/);
  assert.match(part2, /Power mode on \*\*Best performance\*\*, as in an interview\./);
  assert.doesNotMatch(README, /as on the interview day/);
  assert.match(
    part2,
    /\nI'll tell you from your results how Sanas cloud compares with the two apps\. For an interview before our app is ready, \[INTERVIEW\.md\]\(INTERVIEW\.md\) says when an app is good enough to use, and how to set it up\.\n/,
  );
  assert.doesNotMatch(README, /Then go to \[INTERVIEW\.md\]/);
  assert.match(INTERVIEW, /\*\*If both apps pass,\*\* pick the one whose lines the blind listener got right more often\./);
  assert.doesNotMatch(INTERVIEW, /lines your friend got right/);
});

test("the names the friend's test quotes are the page's own", () => {
  assert.match(PAGE, /<select id="speaker"[^>]*>\s*<option value="you">Yours<\/option>\s*<option value="friend">Your friend's<\/option>\s*<\/select>/);
  assert.match(PAGE, /<label class="inline">Whose voice\s/);
  assert.match(PAGE, /"Your friend's script: /);
  assert.match(PAGE, /`\$\{fileStart\(\)\}\$\{stamp\(\)\}\.json`/);
  assert.match(PAGE, /"sanas-check-friend-"/);
  for (const name of [
    "Allow microphone",
    "Connect to Sanas",
    ">Record<",
    ">Run<",
    "Start live",
    "Notes",
    "Score: ",
    "Download results (JSON)",
    "▶ converted",
    "▶ original",
    "Mock (free test",
    "16 kHz",
    "48 kHz",
  ]) {
    assert.ok(PAGE.includes(name), `the page shows ${name}`);
  }
  // Edge must not put a person's old text back after Back or a restored tab (the browser test shows why).
  for (const id of ["speaker", "model", "script", "notes"]) {
    assert.match(PAGE, new RegExp(`id="${id}"[^>]*autocomplete="off"`), `#${id} has autocomplete="off"`);
  }
});

test("later, on your friend's PC: their own key, the things they need, and a guide to come", () => {
  assert.match(friendPc, /\*\*Their own Sanas account and API key,\*\* never yours/);
  assert.match(friendPc, /\*\*1-year\*\* expiry/);
  assert.match(friendPc, /\*\*Allowed origins\*\*/);
  assert.match(friendPc, /spend cap/);
  assert.match(friendPc, /\*\*A wired or USB headset,\*\* not Bluetooth/);
  assert.match(friendPc, /\*\*Windows 10 or 11\.\*\*/);
  assert.match(friendPc, /\*\*VB-CABLE,\*\*/);
  assert.match(friendPc, /\*\*The app's installer\.\*\*/);
  assert.match(friendPc, /\*\*OBS Studio,\*\* if their camera is on in interviews/);
  assert.match(friendPc, /\*\*About 2–3 hours\*\* for the install and its checks, like Sessions A2 and B/);
  assert.match(friendPc, /\*\*INTERVIEW\.md's steps, with our app:\*\*/);
  assert.match(friendPc, /a screenshot of Task Manager → Performance → CPU on their PC[^\n]*it never goes into this repo/);
  assert.match(friendPc, /Their PC and connection are checked again then: the delay and gaps measured so far, in your friend's voice test too, are your laptop's/);
  assert.match(friendPc, /a full guide for them that comes with the finished app/);
  assert.match(friendPc, /Settings are kept per PC/);
});

test("FINDINGS: GO needs your friend's voice too, is provisional until their test, and says what one pass means", () => {
  assert.match(FINDINGS, /GO needs every row to pass \(from the plan\)\. The delay, gaps and listening rows are judged for each voice, yours and your friend's:/);
  assert.match(FINDINGS, /Normally both voices must pass\. "Both voices", below the tables, says what happens when only one does: it can still be GO if that one is your friend's\./);
  assert.match(FINDINGS, /\| Listening test \(your friend's 15 sentences, rated by them\) \| the same bar: ≥ 8\/10, [^|]*\(6–7 = their call, in the Notes of their results file\)/);
  assert.match(FINDINGS, /\*\*Both voices\.\*\*/);
  assert.match(FINDINGS, /a GO from your runs alone is provisional/);
  assert.match(FINDINGS, /\*\*Only your friend's voice passes:\*\* GO, because the app is mainly for your friend: our app is then the one for your friend/);
  assert.match(FINDINGS, /\*\*Only your voice passes:\*\* NO-GO for the app as planned/);
  assert.match(FINDINGS, /on their own PC that needs Node\.js, this code and about 2 hours/);
  assert.match(FINDINGS, /Decision: \*\*pending\*\* your laptop runs and your friend's voice test/);
  // A public repo: no PC or graphics-chip model ("the NVIDIA chip" is fine, a model number is not).
  assert.doesNotMatch(FINDINGS + README + INTERVIEW, /\b(?:NVIDIA|GeForce|Quadro|RTX|GTX)\s+[A-Z]{0,3}\s?\d{3,}/);
});

test("FINDINGS: the results files settle each voice (which runs count), and a retest has steps, a time and a cost", () => {
  assert.match(
    FINDINGS,
    /\*\*A voice passes\*\* when, at one sample rate \(the one the app will use for that person\), its runs that did not drop pass the delay, gaps and listening rows\./,
  );
  assert.match(FINDINGS, /\*\*A dropped run\*\* is noted and run again, not counted\./);
  assert.match(FINDINGS, /\*\*Stability and the quiet test\*\* belong to the connection, not the voice, so they count once\./);
  assert.match(FINDINGS, /\| Delay median \/ p95 \(each Sanas run that counts, for each voice\) \|/);
  assert.match(FINDINGS, /\| Gaps in speech \(each Sanas run that counts, for each voice\) \| ≤ 1 per run \|/);
  // Your friend's test already runs both sample rates: the retest is the same test, with the other model name.
  assert.match(FINDINGS, /with the other model name \(`_Masculine` \/ `_Feminine`\) if the Console shows both/);
  // The retest names the README's part and the step where the other model name goes: the README's own steps
  // say to type the name that matches the voice (your friend's step 3), or the one from the Console (Part 1, 3.5).
  assert.match(
    FINDINGS,
    /for your friend, their voice test again \(README, Part 1, "Your friend's voice test", steps 1 to 9, with that other model name in its step 3: about 45 minutes, about \$0\.05\)/,
  );
  assert.match(
    FINDINGS,
    /for you, two runs at the sample rate the app would use for you, as in Part 1, steps 3\.3 to 3\.7, with that other model name in step 3\.5 \(about 30 minutes, about \$0\.03\)/,
  );
  assert.match(step[3], /^3\. \*\*Their script and model name\*\*[^\n]*the one that matches their voice \(unless I ask you for a retest with the other one\)/);
  assert.match(README, /\n {3}5\. \*\*Model name:\*\* type the exact name from the Console, then press \*\*Connect to Sanas\*\*\./);
  assert.doesNotMatch(FINDINGS, /the other sample rate/);
});

test("FINDINGS: the decision rule says whose voice and whose preference it uses", () => {
  const rule = section(FINDINGS, "Decision rule: our app, or a ready-made one?");
  assert.match(rule, /\(Part 2, with your voice, is the yardstick\)/);
  assert.match(
    rule,
    /\*\*If only your friend's voice passed\*\* \("Both voices" above\), items 1 and 2 are judged for your friend, not for you: item 1 compares Sanas cloud with a ready-made app tried with their voice, by their score, and is skipped if they haven't tried one; item 2 is their preference\. With item 1 skipped, our app is the one for your friend\./,
  );
  assert.match(rule, /Your own interviews follow \[INTERVIEW\.md\]\(\.\.\/INTERVIEW\.md\)\./);
});
