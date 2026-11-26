// The quiet test (Live, and step 7's long check): after a long silence, does
// the converted voice come back as soon as you talk again? Pure functions of
// the call follower's timelines, so they can be tested without a browser.
//
// The follower looks every 3 s. A "speech tick" is a 3-s window of your
// microphone above the speech level; with it goes how many seconds of that
// window were loud (in 20 ms frames). A "heard tick" is a look where converted
// speech followed yours (somewhere in the last 12 s, so heard ticks go on for
// up to 12 s after you stop talking).

/** Speech ticks at most this far apart (consecutive looks) belong to one stretch of talk. */
export const TALK_JOIN_SEC = 3.5;
/**
 * A stretch with less sound than this is not talk: a cough or a coughing fit,
 * clearing your throat, a laugh, putting the headset on. An answer after a
 * long silence has more. (A shorter stretch the app converted still counts:
 * see talkStretches.)
 */
export const TALK_MIN_SOUND_SEC = 3;
/**
 * "At once": the converted voice is back within this many seconds of your
 * first words: by the second look (6 s), plus half a second for a look that
 * comes a little late (looks are stamped to 0.1 s), as in TALK_JOIN_SEC.
 */
export const BACK_AT_ONCE_SEC = 6.5;

/** Seconds of `samples` louder than `floorDb` (dBFS), counted in 20 ms frames. */
export function soundSec(samples, sampleRate, floorDb) {
  const frame = Math.max(1, Math.round(sampleRate * 0.02));
  const floor = 10 ** (floorDb / 10);
  let loud = 0;
  for (let i = 0; i + frame <= samples.length; i += frame) {
    let sum = 0;
    for (let j = i; j < i + frame; j++) sum += samples[j] * samples[j];
    if (sum / frame > floor) loud++;
  }
  return Math.round(loud * 2) / 100;
}

/**
 * Stretches of talk from the speech ticks (seconds), keeping those with at
 * least TALK_MIN_SOUND_SEC of sound, and shorter ones the app converted: a
 * heard tick during the stretch or at the next look (within TALK_JOIN_SEC of
 * its end, so a look that comes a little late still counts). A short "Yes,
 * I'm here" in the middle of a silence then splits it, as it should; one the
 * app left out does not. `sound` holds each tick's seconds of sound; without
 * it (older results) every tick counts as talk.
 */
export function talkStretches(speech, sound, heard = []) {
  const out = [];
  speech.forEach((t, i) => {
    const last = out.at(-1);
    const secs = sound?.[i] ?? 3;
    if (last && t - last.end <= TALK_JOIN_SEC) {
      last.end = t;
      last.soundSec += secs;
    } else out.push({ start: t, end: t, soundSec: secs });
  });
  const converted = (s) => heard.some((t) => t >= s.start && t <= s.end + TALK_JOIN_SEC);
  return out.filter((s) => s.soundSec >= TALK_MIN_SOUND_SEC || converted(s));
}

const round1 = (v) => Math.round(v * 10) / 10;

/**
 * Your longest silence that ended with you talking again (from the start of
 * the call, or between stretches of talk), and how many seconds after you
 * started talking again converted speech came back (null: it didn't, or you
 * never spoke).
 *
 * "Started talking again" is the first look of that stretch. Putting the
 * headset on right before your first words (looks at most TALK_JOIN_SEC
 * apart) joins the stretch, so the comeback then counts from the handling,
 * not from your first word: hence the README's count to ten, in silence,
 * between putting the headset on and reading.
 *
 * The silence from your last words until the end is not a quiet test, as you
 * never spoke after it: it is returned apart, as silenceAtEndSec.
 */
export function quietTest(speech, heard, endSec, sound) {
  let silence = 0;
  let resumedAt = null;
  let previous = 0;
  for (const s of talkStretches(speech, sound, heard)) {
    if (s.start - previous > silence) {
      silence = s.start - previous;
      resumedAt = s.start;
    }
    previous = s.end;
  }
  const back = resumedAt == null ? null : heard.find((t) => t >= resumedAt) ?? null;
  return {
    silenceLongestSec: round1(silence),
    silenceAtEndSec: round1(Math.max(0, endSec - previous)),
    speechResumedAtSec: resumedAt,
    convertedBackAfterSec: back == null ? null : round1(back - resumedAt),
  };
}

// Minutes are rounded down, so "14.0 min" on the page means at least 840 s,
// as FINDINGS' rule for the JSON says.
const span = (secs) => (secs >= 90 ? `${(Math.floor(secs / 6) / 10).toFixed(1)} min` : `${Math.round(secs)} s`);

/**
 * The quiet test in words, for the status line and the line next to Stop:
 * when a silence of 10 s or more ended with talk, whether the converted voice
 * came back at once, late or not at all; and a hint when the longest silence
 * ran until Stop, so it was not tested.
 * `s` is a followed call's summary (quietTest's fields plus speechAtSec).
 */
export function quietNote(s) {
  const untested =
    s.speechAtSec?.length && s.silenceAtEndSec >= 60 && s.silenceAtEndSec > s.silenceLongestSec
      ? ` Your last ${span(s.silenceAtEndSec)} were silent until Stop, so that silence was not tested: after a silence, talk for a minute, then press Stop.`
      : "";
  if (s.speechResumedAtSec == null || s.silenceLongestSec < 10) return { text: untested, bad: false };
  const quiet = span(s.silenceLongestSec);
  if (s.convertedBackAfterSec == null) {
    return { text: ` Quiet test: after ${quiet} of silence you spoke, but the converted voice did not come back.${untested}`, bad: true };
  }
  const late = s.convertedBackAfterSec > BACK_AT_ONCE_SEC;
  const when = late ? `late: ${Math.round(s.convertedBackAfterSec)} s after you spoke again (it should be at once)` : "at once";
  return { text: ` Quiet test: after ${quiet} of silence the converted voice came back ${when}.${untested}`, bad: late };
}
