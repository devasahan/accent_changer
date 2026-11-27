// src/audio/devices.js: a browser call that never answers is given up, and nothing waits for it for good.
// Runs on the fakes in tests/helpers/fake-audio.js with node:test's mock clock.
import test from "node:test";
import assert from "node:assert/strict";
import { advance, flush, useFakeAudio, watch } from "./helpers/fake-audio.js";
import {
  NO_ANSWER_MS,
  micErrorText,
  onDeviceChange,
  openCableOutput,
  openMic,
  readDevices,
  readOutputRate,
} from "../src/audio/devices.js";
import { classifyError } from "../src/core/recovery.js";

const HEADSET = { deviceId: "mic-head", label: "Headset Microphone (Test Headset)" };

test("readDevices gives up a device list that never comes (TimeoutError after 15 s)", async (t) => {
  const fake = useFakeAudio(t);
  fake.hang.enumerate = 1;
  const read = watch(readDevices());
  await advance(NO_ANSWER_MS - 10);
  assert.equal(read.done, false);
  await advance(20);
  assert.equal(read.done, true);
  assert.equal(read.error?.name, "TimeoutError");
  assert.equal(classifyError(read.error), "transient");
  // The next read asks again and works.
  const again = watch(readDevices());
  await flush();
  assert.equal(again.value?.cableIn?.deviceId, "cable-in");
  assert.equal(fake.calls.enumerate, 2);
});

test("readDevices: an unlock getUserMedia that never answers leaves the names hidden; its late stream is stopped", async (t) => {
  const fake = useFakeAudio(t);
  fake.hideLabels = true;
  fake.hang.gum = 1;
  const read = watch(readDevices({ unlockLabels: true }));
  await advance(NO_ANSWER_MS + 10);
  assert.equal(read.done, true, "readDevices still waits for the unlock");
  const snap = read.value;
  assert.equal(snap.labelsVisible, false);
  assert.equal(snap.unlockError?.name, "MicError");
  assert.equal(snap.unlockError?.cause?.name, "TimeoutError");
  assert.equal(classifyError(snap.unlockError), "transient");
  assert.equal(typeof snap.unlockMs, "number"); // performance.now(), which the mock clock leaves alone
  const [late] = fake.answerLate("gum");
  await flush();
  assert.equal(late.getTracks()[0].readyState, "ended");
});

test("openMic gives up a getUserMedia that never answers: a passing MicError; the late stream is stopped", async (t) => {
  const fake = useFakeAudio(t);
  fake.hang.gum = 1;
  const opening = watch(openMic(HEADSET));
  await advance(NO_ANSWER_MS + 10);
  assert.equal(opening.done, true);
  const err = opening.error;
  assert.equal(err?.name, "MicError");
  assert.equal(err.code, "other");
  assert.equal(err.cause?.name, "TimeoutError");
  assert.equal(classifyError(err), "transient");
  assert.equal(err.message, "The microphone did not answer in time. Try again in a moment.");
  assert.equal(micErrorText(err.cause), err.message);
  const [late] = fake.answerLate("gum");
  await flush();
  assert.equal(late.getTracks()[0].readyState, "ended");
  assert.equal(fake.liveTracks().length, 0);
});

test("openMic stops waiting as soon as its signal aborts; a stream that comes later is stopped", async (t) => {
  const fake = useFakeAudio(t);
  const before = new AbortController();
  before.abort();
  const refused = watch(openMic(HEADSET, { signal: before.signal }));
  await flush();
  assert.equal(refused.error?.name, "AbortError");
  assert.equal(fake.calls.gum, 0, "getUserMedia is not even asked");

  fake.hang.gum = 1;
  const ac = new AbortController();
  const opening = watch(openMic(HEADSET, { signal: ac.signal }));
  await advance(500);
  assert.equal(opening.done, false);
  ac.abort();
  await flush();
  assert.equal(opening.error?.name, "AbortError");
  const [late] = fake.answerLate("gum");
  await flush();
  assert.equal(late.getTracks()[0].readyState, "ended");
});

test("readDevices stops waiting as soon as its signal aborts", async (t) => {
  const fake = useFakeAudio(t);
  fake.hang.enumerate = 1;
  const ac = new AbortController();
  const read = watch(readDevices({ signal: ac.signal }));
  await advance(1000);
  assert.equal(read.done, false);
  ac.abort();
  await flush();
  assert.equal(read.error?.name, "AbortError");
});

test("onDeviceChange keeps reading after a device list that never came", async (t) => {
  const fake = useFakeAudio(t);
  const seen = [];
  const unsubscribe = onDeviceChange((snap) => seen.push(snap.defaultOutputLabel));
  t.after(unsubscribe);
  fake.hang.enumerate = 1;
  fake.devicechange(); // this read never gets its list
  await advance(300);
  fake.defaultOutputIsCable = true;
  fake.devicechange(); // a real change while the first read waits
  await advance(2000);
  assert.deepEqual(seen, []);
  await advance(NO_ANSWER_MS);
  assert.deepEqual(seen, ["Default - CABLE Input (VB-Audio Virtual Cable)"]);
  // And the next change is read as usual.
  fake.defaultOutputIsCable = false;
  fake.devicechange();
  await flush();
  assert.deepEqual(seen.at(-1), "Default - Headset Earphone (Test Headset)");
});

test("readOutputRate: a device list that never comes gives null; a close() that never finishes is not waited for", async (t) => {
  const fake = useFakeAudio(t, { cableRateHz: 44100 });
  fake.hang.enumerate = 1;
  const listLate = watch(readOutputRate("cable-in"));
  await advance(NO_ANSWER_MS + 10);
  assert.equal(listLate.done, true);
  assert.equal(listLate.value, null);

  fake.hang.close = 1;
  const closeHangs = watch(readOutputRate("cable-in"));
  await advance(1000);
  assert.equal(closeHangs.done, false);
  await advance(1100);
  assert.equal(closeHangs.done, true);
  assert.equal(closeHangs.value, 44100);
});

test("openCableOutput gives up a getUserMedia that never answers; the late stream is stopped", async (t) => {
  const fake = useFakeAudio(t);
  const snap = await readDevices();
  fake.hang.gum = 1;
  const opening = watch(openCableOutput(snap));
  await advance(NO_ANSWER_MS + 10);
  assert.equal(opening.done, true);
  assert.match(opening.error?.message ?? "", /did not answer in time/);
  assert.equal(opening.error?.cause?.name, "TimeoutError");
  const [late] = fake.answerLate("gum");
  await flush();
  assert.equal(late.getTracks()[0].readyState, "ended");
});
