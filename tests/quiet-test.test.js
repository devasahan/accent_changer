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

test("a first sentence lost after the silence still shows as late", () => {
  // You say a short sentence (two looks), pause 6 s, go on; conversion is back only 12 s after your first words.
  const r = call([{ ticks: T(3, 60) }, { ticks: [960, 963] }, { ticks: T(969, 1050) }], [...T(6, 63), ...T(972, 1050)], 1051);
  assert.equal(r.speechResumedAtSec, 960);
  assert.equal(r.convertedBackAfterSec, 12);
  assert.match(r.note.text, /only 12 s after you spoke again/);
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
