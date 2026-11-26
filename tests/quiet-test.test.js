import test from "node:test";
import assert from "node:assert/strict";
import { quietNote, quietTest, soundSec, talkStretches } from "../spike/quiet-test.js";

// Follower timelines: a tick every 3 s from x to y (inclusive).
const T = (x, y) => Array.from({ length: Math.floor((y - x) / 3) + 1 }, (_, i) => x + 3 * i);
// Each speech tick's seconds of sound: talk fills about 2 s of a 3-s window.
const talk = (ticks) => ticks.map(() => 2);

/** One call: speech ticks with their sound, heard ticks, end. */
function call(parts, heard, endSec) {
  const speech = parts.flatMap((p) => p.ticks);
  const sound = parts.flatMap((p) => p.sound ?? talk(p.ticks));
  const summary = { ...quietTest(speech, heard, endSec, sound), speechAtSec: speech };
  return { ...summary, note: quietNote(summary) };
}

test("talk comes back after 15 minutes and the voice with it: at once", () => {
  const r = call([{ ticks: T(3, 60) }, { ticks: T(960, 1050) }], [...T(6, 63), ...T(960, 1050)], 1051);
  assert.equal(r.silenceLongestSec, 900);
  assert.equal(r.speechResumedAtSec, 960);
  assert.equal(r.convertedBackAfterSec, 0);
  assert.match(r.note.text, /after 15\.0 min of silence the converted voice came back at once/);
  assert.equal(r.note.bad, false);
});

test("a knock on the headset 9 s before your first words doesn't count as talking again", () => {
  // You sit down and put the headset on (one tick, half a second of sound), then start reading.
  const r = call([{ ticks: T(3, 60) }, { ticks: [963], sound: [0.5] }, { ticks: T(972, 1020) }], [...T(6, 63), ...T(972, 1020)], 1021);
  assert.equal(r.speechResumedAtSec, 972);
  assert.equal(r.convertedBackAfterSec, 0);
  assert.match(r.note.text, /came back at once/);
});

test("the same knock split over two looks is still not talk", () => {
  const r = call([{ ticks: T(3, 60) }, { ticks: [960, 963], sound: [0.3, 0.3] }, { ticks: T(972, 1020) }], [...T(6, 63), ...T(972, 1020)], 1021);
  assert.equal(r.speechResumedAtSec, 972);
  assert.equal(r.convertedBackAfterSec, 0);
});

test("a cough in the middle of the silence doesn't split it", () => {
  const r = call([{ ticks: T(3, 60) }, { ticks: [660], sound: [0.4] }, { ticks: T(960, 1050) }], [...T(6, 63), ...T(960, 1050)], 1051);
  assert.equal(r.silenceLongestSec, 900);
  assert.equal(r.convertedBackAfterSec, 0);
});

test("coughs, clearing your throat or a laugh late in the silence (under 3 s of sound, left out by the app) don't split it", () => {
  // Counted as talk, each would make the app look minutes late: "came back late: 180 s after you spoke again".
  const noises = {
    "two coughs in one look": { ticks: [780], sound: [1.5] },
    "clearing your throat twice": { ticks: [741, 744], sound: [1.3, 1] },
    "a laugh": { ticks: [852, 855], sound: [1.6, 0.9] },
  };
  for (const [what, noise] of Object.entries(noises)) {
    const r = call([{ ticks: T(3, 60) }, noise, { ticks: T(960, 1050) }], [...T(6, 63), ...T(960, 1050)], 1051);
    assert.equal(r.silenceLongestSec, 900, what);
    assert.equal(r.speechResumedAtSec, 960, what);
    assert.equal(r.convertedBackAfterSec, 0, what);
    assert.match(r.note.text, /^ Quiet test: after 15\.0 min of silence the converted voice came back at once\.$/, what);
    assert.equal(r.note.bad, false, what);
  }
});

test("putting the headset on, a silent count to ten, then reading: counted from your first words", () => {
  // The README's quiet test: the handling (two looks, 2.2 s of sound, left out by the app), 10 s of silence, then the script.
  const r = call([{ ticks: T(3, 60) }, { ticks: [951, 954], sound: [1.6, 0.6] }, { ticks: T(966, 1050) }], [...T(6, 63), ...T(966, 1050)], 1051);
  assert.equal(r.speechResumedAtSec, 966);
  assert.equal(r.silenceLongestSec, 906);
  assert.equal(r.convertedBackAfterSec, 0);
  assert.match(r.note.text, /after 15\.1 min of silence the converted voice came back at once\./);
});

test("putting the headset on straight into your first words: one stretch, counted from the handling", () => {
  // The same handling with no pause: its looks and your reading are at most 3.5 s apart, so the comeback
  // counts from the handling's first look (951), not from your first word (957). That costs 6 s here (still
  // "at once": two looks); a longer fumble makes an app that converted your first word look late. Hence the
  // README's count to ten.
  const r = call([{ ticks: T(3, 60) }, { ticks: [951, 954], sound: [1.6, 0.6] }, { ticks: T(957, 1050) }], [...T(6, 63), ...T(957, 1050)], 1051);
  assert.equal(r.speechResumedAtSec, 951);
  assert.equal(r.convertedBackAfterSec, 6);
  assert.equal(r.note.bad, false);
  assert.match(r.note.text, /came back at once\.$/);
});

test("back at the second look, a little late, is still at once; at the third look it is late", () => {
  // The looks come every 3 s, stamped to 0.1 s, so the second look can read 6.1-6.4 s after the first.
  for (const back of [966.1, 966.4]) {
    const r = call([{ ticks: T(3, 60) }, { ticks: T(960, 1050) }], [...T(6, 63), back, ...T(969, 1050)], 1051);
    assert.equal(r.convertedBackAfterSec, Math.round((back - 960) * 10) / 10);
    assert.equal(r.note.bad, false, `back at ${back}`);
    assert.match(r.note.text, /came back at once\.$/, `back at ${back}`);
  }
  const third = call([{ ticks: T(3, 60) }, { ticks: T(960, 1050) }], [...T(6, 63), ...T(969, 1050)], 1051);
  assert.equal(third.convertedBackAfterSec, 9);
  assert.equal(third.note.bad, true);
  assert.match(third.note.text, /came back late: 9 s after you spoke again \(it should be at once\)\.$/);
  // Just over the limit: the figure never reads 6 s, which would look like "at once".
  const over = call([{ ticks: T(3, 60) }, { ticks: T(960, 1050) }], [...T(6, 63), 966.6, ...T(969, 1050)], 1051);
  assert.equal(over.note.bad, true);
  assert.match(over.note.text, /came back late: 7 s after you spoke again/);
});

test("a cough 15 s after your last converted words is not made talk by their lingering heard ticks", () => {
  // Heard ticks go on for 12 s after you stop talking (to 72 here); the cough's look is at 75.
  const r = call([{ ticks: T(3, 60) }, { ticks: [75], sound: [1.5] }, { ticks: T(960, 1050) }], [...T(6, 72), ...T(960, 1050)], 1051);
  assert.equal(r.silenceLongestSec, 900);
  assert.equal(r.convertedBackAfterSec, 0);
});

test("a stretch with 3 s of sound is talk even when the app left it out", () => {
  // Two looks of 1.5 s each, not converted, then the rest of your answer: the comeback counts from 960.
  const r = call([{ ticks: T(3, 60) }, { ticks: [960, 963], sound: [1.5, 1.5] }, { ticks: T(972, 1050) }], [...T(6, 63), ...T(972, 1050)], 1051);
  assert.equal(r.speechResumedAtSec, 960);
  assert.equal(r.convertedBackAfterSec, 12);
  assert.equal(r.note.bad, true);
});

test("minutes on the page are rounded down: 14.0 min means at least 840 s", () => {
  const note = (silenceLongestSec) =>
    quietNote({ speechAtSec: [1], silenceLongestSec, silenceAtEndSec: 0, speechResumedAtSec: 1000, convertedBackAfterSec: 0 }).text;
  assert.match(note(837.1), /after 13\.9 min of silence/);
  assert.match(note(839.9), /after 13\.9 min of silence/);
  assert.match(note(840), /after 14\.0 min of silence/);
  assert.match(note(899.9), /after 14\.9 min of silence/);
  assert.match(note(900), /after 15\.0 min of silence/);
  assert.match(note(89), /after 89 s of silence/);
  assert.match(note(90), /after 1\.5 min of silence/);
});

test("a short reply the app converted splits the silence; one it left out doesn't", () => {
  // "Yes, I'm here" at minute 7: one look, 1.5 s of sound. The 15-minute quiet test didn't happen, and the page says so.
  const reply = { ticks: [420], sound: [1.5] };
  // Converted speech heard at that look, at the next one, or at the next one a little late (a busy laptop).
  for (const heardAt of [420, 423, 423.3]) {
    const r = call([{ ticks: T(3, 60) }, reply, { ticks: T(960, 1050) }], [...T(6, 63), heardAt, ...T(960, 1050)], 1051);
    assert.equal(r.silenceLongestSec, 540, `heard at ${heardAt}`);
    assert.equal(r.speechResumedAtSec, 960, `heard at ${heardAt}`);
    assert.match(r.note.text, /^ Quiet test: after 9\.0 min of silence the converted voice came back at once\.$/, `heard at ${heardAt}`);
  }
  // Not converted (the app left it out, or lost it): too little sound to be talk, so the silence stays whole.
  const unconverted = call([{ ticks: T(3, 60) }, reply, { ticks: T(960, 1050) }], [...T(6, 63), ...T(960, 1050)], 1051);
  assert.equal(unconverted.silenceLongestSec, 900);
  assert.match(unconverted.note.text, /after 15\.0 min of silence the converted voice came back at once/);
});

test("clearing your throat just before you answer isn't made talk by your answer's conversion", () => {
  // "Ahem" (one look, 1.2 s), then your answer two looks later, converted at once: only the next look counts
  // for the ahem, so the comeback is counted from your answer, not from the ahem.
  const r = call([{ ticks: T(3, 60) }, { ticks: [954], sound: [1.2] }, { ticks: T(960, 1050) }], [...T(6, 63), ...T(960, 1050)], 1051);
  assert.equal(r.speechResumedAtSec, 960);
  assert.equal(r.convertedBackAfterSec, 0);
  assert.equal(r.note.bad, false);
});

test("a first sentence lost after the silence still shows as late", () => {
  // You say a short sentence (two looks, 4 s of sound), pause 6 s, go on; conversion is back only 12 s after your first words.
  const r = call([{ ticks: T(3, 60) }, { ticks: [960, 963] }, { ticks: T(969, 1050) }], [...T(6, 63), ...T(972, 1050)], 1051);
  assert.equal(r.speechResumedAtSec, 960);
  assert.equal(r.convertedBackAfterSec, 12);
  assert.match(
    r.note.text,
    /^ Quiet test: after 15\.0 min of silence the converted voice came back late: 12 s after you spoke again \(it should be at once\)\.$/,
  );
  assert.equal(r.note.bad, true);
});

test("late, and never: told apart", () => {
  const late = call([{ ticks: T(3, 60) }, { ticks: T(960, 1050) }], [...T(6, 63), ...T(981, 1050)], 1051);
  assert.equal(late.convertedBackAfterSec, 21);
  assert.equal(late.note.bad, true);
  const never = call([{ ticks: T(3, 60) }, { ticks: T(960, 1050) }], T(6, 63), 1051);
  assert.equal(never.speechResumedAtSec, 960);
  assert.equal(never.convertedBackAfterSec, null);
  assert.match(never.note.text, /you spoke, but the converted voice did not come back/);
  assert.equal(never.note.bad, true);
});

test("the silence after your last words is not the quiet test, however long", () => {
  // A 15-minute quiet test, then the call ends but Stop comes 20 minutes later (or the 90-minute limit stops it).
  for (const endSec of [1300, 2400, 5400]) {
    const r = call([{ ticks: T(3, 60) }, { ticks: T(960, 1200) }], [...T(6, 63), ...T(960, 1200)], endSec);
    assert.equal(r.silenceLongestSec, 900, `end ${endSec}`);
    assert.equal(r.speechResumedAtSec, 960);
    assert.equal(r.convertedBackAfterSec, 0);
    assert.equal(r.silenceAtEndSec, endSec - 1200);
    assert.match(r.note.text, /came back at once/);
    if (endSec - 1200 > 900) assert.match(r.note.text, /were silent until Stop, so that silence was not tested/);
    else assert.doesNotMatch(r.note.text, /not tested/);
    assert.equal(r.note.bad, false);
  }
});

test("forgetting Stop for 25 min, then putting the headset on, is not 'did not come back'", () => {
  // The quiet test, the end of the call, and 25 minutes later you come back and put the headset on (two
  // looks, 2.2 s of sound, nothing to convert) before you press Stop. Counted as talk, it would end a
  // 25-minute "silence" that the app never came back from.
  const r = call([{ ticks: T(3, 60) }, { ticks: T(960, 3720) }, { ticks: [5223, 5226], sound: [1.6, 0.6] }], [...T(6, 63), ...T(960, 3720)], 5230);
  assert.equal(r.silenceLongestSec, 900);
  assert.equal(r.convertedBackAfterSec, 0);
  assert.equal(r.note.bad, false);
  assert.match(r.note.text, /came back at once\. Your last 25\.1 min were silent until Stop, so that silence was not tested/);
});

test("staying silent until Stop says the quiet test wasn't done", () => {
  const r = call([{ ticks: T(3, 60) }], T(6, 63), 960);
  assert.equal(r.speechResumedAtSec, 3, "only the start of the call came before talk");
  assert.ok(r.silenceLongestSec < 10);
  assert.equal(r.silenceAtEndSec, 900);
  assert.match(r.note.text, /last 15\.0 min were silent until Stop/);
  assert.equal(r.note.bad, false);
});

test("silence from the very start of the call, then talk, is a quiet test too", () => {
  const r = call([{ ticks: T(903, 960) }], T(903, 960), 961);
  assert.equal(r.silenceLongestSec, 903);
  assert.equal(r.convertedBackAfterSec, 0);
});

test("no talk at all: nothing to say", () => {
  const r = call([], [], 120);
  assert.equal(r.speechResumedAtSec, null);
  assert.equal(r.silenceAtEndSec, 120);
  assert.equal(r.note.text, "");
});

test("results saved before sound was recorded count every speech tick as talk", () => {
  const stretches = talkStretches([660, ...T(960, 990)]);
  assert.deepEqual(
    stretches.map((s) => s.start),
    [660, 960],
  );
});

test("seconds of sound: a short loud click is short, talk is long", () => {
  const rate = 48000;
  const window = new Float32Array(rate * 3);
  for (let i = 0; i < rate * 0.4; i++) window[i] = 0.3 * Math.sin(i / 7); // a 0.4-s cough
  assert.ok(Math.abs(soundSec(window, rate, -45) - 0.4) <= 0.04, `${soundSec(window, rate, -45)}`);
  for (let i = 0; i < rate * 3; i++) window[i] = (Math.floor(i / (rate * 0.25)) % 4 === 3 ? 0.0005 : 0.1) * Math.sin(i / 5); // words with short pauses
  const s = soundSec(window, rate, -45);
  assert.ok(s >= 2 && s <= 2.4, `${s}`);
  assert.equal(soundSec(new Float32Array(rate * 3), rate, -45), 0);
});
