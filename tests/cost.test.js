import test from "node:test";
import assert from "node:assert/strict";
import { CostMeter, PRICE_PER_MIN, budgetStatus, idleDisconnect, keyExpiry, localDate } from "../src/core/cost.js";

const MIN = 60000;
const DAY = 24 * 60 * MIN;
const at = (iso) => Date.parse(iso); // ISO texts with "Z": the same instant on every machine
const IST = 330; // India: UTC+5:30
const NEW_YORK = -300; // UTC-5 in winter

function near(actual, expected, label = "", eps = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= eps, `${label} ${actual} != ${expected}`);
}

/** Minutes of a totals() result, rounded to the microminute, for deepEqual. */
const mins = (t) => ({
  session: Math.round(t.session.min * 1e6) / 1e6,
  today: Math.round(t.today.min * 1e6) / 1e6,
  month: Math.round(t.month.min * 1e6) / 1e6,
});

test("one call is billed from Ready to destroy at $0.009 a minute", () => {
  assert.equal(PRICE_PER_MIN, 0.009);
  const m = new CostMeter();
  const t0 = at("2026-11-26T10:00:00Z");
  assert.deepEqual(mins(m.totals(t0)), { session: 0, today: 0, month: 0 });
  m.callStarted("call-1", t0);
  assert.equal(m.openCalls, 1);
  const open = m.totals(t0 + 4 * MIN); // still open: counted up to now
  assert.deepEqual(mins(open), { session: 4, today: 4, month: 4 });
  near(open.session.usd, 0.036, "usd");
  m.callEnded("call-1", t0 + 10 * MIN);
  assert.equal(m.openCalls, 0);
  const done = m.totals(t0 + 60 * MIN); // ended: no more minutes after the destroy
  assert.deepEqual(mins(done), { session: 10, today: 10, month: 10 });
  near(done.today.usd, 0.09, "usd");
  near(done.month.usd, 0.09, "usd");
  const pricey = new CostMeter({ pricePerMin: 0.02 });
  pricey.callStarted(1, t0);
  pricey.callEnded(1, t0 + 30 * MIN);
  near(pricey.totals(t0 + 30 * MIN).session.usd, 0.6, "custom price");
});

test("overlapping calls each count (a reconnect that overlaps the old call)", () => {
  const m = new CostMeter();
  const t0 = at("2026-11-26T10:00:00Z");
  m.callStarted("old", t0);
  m.callStarted("new", t0 + 5 * MIN);
  assert.equal(m.openCalls, 2);
  assert.equal(mins(m.totals(t0 + 8 * MIN)).session, 8 + 3);
  m.callEnded("old", t0 + 10 * MIN);
  assert.deepEqual(mins(m.totals(t0 + 15 * MIN)), { session: 20, today: 20, month: 20 });
});

test("odd calls: repeated start keeps the first, unknown or repeated end and bad times change nothing", () => {
  const m = new CostMeter();
  const t0 = at("2026-11-26T10:00:00Z");
  m.callStarted("a", t0);
  m.callStarted("a", t0 + 5 * MIN); // billing never starts later than it began
  m.callEnded("nobody", t0 + 6 * MIN);
  m.callEnded("a", NaN);
  m.callStarted("b", Infinity);
  m.callStarted("c", "10:00");
  assert.equal(m.openCalls, 1);
  m.callEnded("a", t0 + 10 * MIN);
  m.callEnded("a", t0 + 20 * MIN); // already ended
  assert.equal(mins(m.totals(t0 + 30 * MIN)).session, 10);
  m.callStarted("back", t0 + 40 * MIN);
  m.callEnded("back", t0 + 39 * MIN); // the clock went back: nothing billed
  assert.equal(mins(m.totals(t0 + 45 * MIN)).session, 10);
  m.callStarted("later", t0 + 50 * MIN);
  assert.equal(mins(m.totals(t0 + 45 * MIN)).session, 10, "an open call counts nothing before its start");
  assert.throws(() => m.totals(), TypeError);
  assert.throws(() => m.totals(NaN), TypeError);
});

test("day roll-over: a call across midnight is split between the two days", () => {
  const m = new CostMeter();
  m.callStarted("c", at("2026-11-26T23:50:00Z"));
  assert.deepEqual(mins(m.totals(at("2026-11-26T23:59:00Z"))), { session: 9, today: 9, month: 9 });
  assert.deepEqual(mins(m.totals(at("2026-11-27T00:05:00Z"))), { session: 15, today: 5, month: 15 });
  m.callEnded("c", at("2026-11-27T00:20:00Z"));
  assert.deepEqual(mins(m.totals(at("2026-11-27T09:00:00Z"))), { session: 30, today: 20, month: 30 });
  assert.deepEqual(mins(m.totals(at("2026-11-28T09:00:00Z"))), { session: 30, today: 0, month: 30 });
  assert.deepEqual(m.serialize(), { version: 1, days: { "2026-11-26": 10, "2026-11-27": 20 }, months: { "2026-11": 30 } });
});

test("today is the local day: the time zone offset moves midnight", () => {
  // 18:00-18:40 UTC is 23:30-00:10 in India, 13:00-13:40 in New York.
  const m = new CostMeter();
  m.callStarted("c", at("2026-11-26T18:00:00Z"));
  m.callEnded("c", at("2026-11-26T18:40:00Z"));
  const now = at("2026-11-26T18:40:00Z");
  assert.deepEqual(mins(m.totals(now, { timeZoneOffsetMin: IST })), { session: 40, today: 10, month: 40 });
  assert.deepEqual(mins(m.totals(now, { timeZoneOffsetMin: NEW_YORK })), { session: 40, today: 40, month: 40 });
  assert.deepEqual(mins(m.totals(now)), { session: 40, today: 40, month: 40 }, "default offset 0 = UTC");
  assert.deepEqual(m.serialize({ timeZoneOffsetMin: IST }).days, { "2026-11-26": 30, "2026-11-27": 10 });
  // The meter's own default zone, and nonsense offsets read as UTC.
  const india = new CostMeter({ timeZoneOffsetMin: IST });
  india.callStarted("c", at("2026-11-26T18:00:00Z"));
  india.callEnded("c", at("2026-11-26T18:40:00Z"));
  assert.equal(mins(india.totals(now)).today, 10);
  assert.equal(mins(india.totals(now, { timeZoneOffsetMin: NaN })).today, 40);
  assert.equal(mins(india.totals(now, { timeZoneOffsetMin: 100000 })).today, 40);
  assert.equal(localDate(now, { timeZoneOffsetMin: IST }), "2026-11-27");
  assert.equal(localDate(now), "2026-11-26");
  assert.equal(localDate(now, { timeZoneOffsetMin: NEW_YORK }), "2026-11-26");
  assert.equal(localDate(NaN), null);
});

test("month and year roll-over in local time", () => {
  const m = new CostMeter({ timeZoneOffsetMin: IST });
  // 23:55 IST on 30 November to 00:05 IST on 1 December.
  m.callStarted("c", at("2026-11-30T18:25:00Z"));
  m.callEnded("c", at("2026-11-30T18:35:00Z"));
  assert.deepEqual(mins(m.totals(at("2026-11-30T18:35:00Z"))), { session: 10, today: 5, month: 5 });
  assert.deepEqual(mins(m.totals(at("2026-11-30T18:29:00Z"))), { session: 10, today: 5, month: 5 }, "on 30 Nov IST");
  let s = m.serialize();
  assert.deepEqual(s.days, { "2026-11-30": 5, "2026-12-01": 5 });
  assert.deepEqual(s.months, { "2026-11": 5, "2026-12": 5 });
  // New Year in UTC, and a later December day that sees only December's minutes.
  const y = new CostMeter();
  y.callStarted("c", at("2026-12-31T23:58:00Z"));
  y.callEnded("c", at("2027-01-01T00:03:00Z"));
  assert.deepEqual(mins(y.totals(at("2027-01-01T00:03:00Z"))), { session: 5, today: 3, month: 3 });
  assert.deepEqual(mins(y.totals(at("2026-12-31T23:59:30Z"))), { session: 5, today: 2, month: 2 });
  s = y.serialize();
  assert.deepEqual(s.months, { "2026-12": 2, "2027-01": 3 });
  assert.deepEqual(s.days, { "2026-12-31": 2, "2027-01-01": 3 });
  // A call longer than a whole day is spread over every day it touched.
  const long = new CostMeter();
  long.callStarted("c", at("2026-02-27T12:00:00Z"));
  long.callEnded("c", at("2026-03-01T06:00:00Z"));
  assert.deepEqual(long.serialize().days, { "2026-02-27": 720, "2026-02-28": 1440, "2026-03-01": 360 });
  assert.deepEqual(long.serialize().months, { "2026-02": 2160, "2026-03": 360 });
});

test("serialize and restore: earlier runs count in today and this month, not in the session", () => {
  const a = new CostMeter({ timeZoneOffsetMin: IST });
  const call = (id, from, minutes) => {
    a.callStarted(id, at(from));
    a.callEnded(id, at(from) + minutes * MIN);
  };
  call(1, "2026-10-31T10:00:00Z", 7); // last month
  call(2, "2026-11-25T10:00:00Z", 20); // yesterday
  call(3, "2026-11-26T04:00:00Z", 15); // today (09:30 IST)
  const now = at("2026-11-26T12:00:00Z");
  const before = mins(a.totals(now));
  assert.deepEqual(before, { session: 42, today: 15, month: 35 });

  const saved = JSON.parse(JSON.stringify(a.serialize()));
  assert.deepEqual(saved, {
    version: 1,
    days: { "2026-10-31": 7, "2026-11-25": 20, "2026-11-26": 15 },
    months: { "2026-10": 7, "2026-11": 35 },
  });
  const b = new CostMeter({ state: saved, timeZoneOffsetMin: IST });
  assert.deepEqual(mins(b.totals(now)), { session: 0, today: 15, month: 35 });
  b.callStarted("x", now);
  b.callEnded("x", now + 3 * MIN);
  assert.deepEqual(mins(b.totals(now + 3 * MIN)), { session: 3, today: 18, month: 38 });
  const again = b.serialize();
  assert.deepEqual(again.days, { "2026-10-31": 7, "2026-11-25": 20, "2026-11-26": 18 });
  assert.deepEqual(again.months, { "2026-10": 7, "2026-11": 38 });
  // Saving twice does not count anything twice; the JSON text of a state works too.
  assert.deepEqual(b.serialize(), again);
  const c = new CostMeter({ state: JSON.stringify(again), timeZoneOffsetMin: IST });
  assert.deepEqual(mins(c.totals(now + 3 * MIN)), { session: 0, today: 18, month: 38 });
  assert.deepEqual(mins(c.totals(at("2026-12-01T12:00:00Z"))), { session: 0, today: 0, month: 0 }, "a new month");
});

test("serialize({atMs}) saves an open call up to then, so a crash loses at most a minute", () => {
  const m = new CostMeter();
  const t0 = at("2026-11-26T10:00:00Z");
  m.callStarted("live", t0);
  assert.deepEqual(m.serialize(), { version: 1, days: {}, months: {} }, "without atMs: ended calls only");
  const snapshot = m.serialize({ atMs: t0 + 30 * MIN });
  assert.deepEqual(snapshot.days, { "2026-11-26": 30 });
  assert.deepEqual(m.serialize({ atMs: t0 + 40 * MIN }).days, { "2026-11-26": 40 }, "not 30 + 40");
  // The app is killed here; the next run starts from the last snapshot.
  const next = new CostMeter({ state: snapshot });
  assert.deepEqual(mins(next.totals(t0 + 60 * MIN)), { session: 0, today: 30, month: 30 });
});

test("the last 62 days are kept; month totals keep the older days, for two years", () => {
  const m = new CostMeter();
  const first = at("2026-01-01T12:00:00Z");
  for (let d = 0; d < 70; d++) {
    m.callStarted(d, first + d * DAY);
    m.callEnded(d, first + d * DAY + MIN);
  }
  const s = m.serialize();
  const days = Object.keys(s.days);
  assert.equal(days.length, 62);
  assert.equal(days[0], "2026-01-09");
  assert.equal(days.at(-1), "2026-03-11");
  assert.deepEqual(s.months, { "2026-01": 31, "2026-02": 28, "2026-03": 11 });
  const restored = new CostMeter({ state: s });
  assert.equal(mins(restored.totals(at("2026-03-11T20:00:00Z"))).month, 11);
  assert.equal(mins(restored.totals(at("2026-03-11T20:00:00Z"))).today, 1);
  // Counted back from atMs when it is given: two months later only months remain.
  assert.deepEqual(restored.serialize({ atMs: at("2026-05-20T12:00:00Z") }).days, {});
  assert.deepEqual(restored.serialize({ atMs: at("2026-05-20T12:00:00Z") }).months, s.months);

  const years = new CostMeter();
  for (let k = 0; k < 30; k++) {
    const start = Date.UTC(2024, k, 1, 12);
    years.callStarted(k, start);
    years.callEnded(k, start + 2 * MIN);
  }
  const months = Object.keys(years.serialize().months);
  assert.equal(months.length, 24);
  assert.equal(months[0], "2024-07");
  assert.equal(months.at(-1), "2026-06");
  assert.deepEqual(Object.keys(years.serialize().days), ["2026-04-01", "2026-05-01", "2026-06-01"]);
});

test("a corrupt or hand-edited state never stops the app: what can't be read is ignored", () => {
  const t = at("2026-11-26T12:00:00Z");
  for (const state of [null, undefined, "not json", "{}", 42, [], { days: "x", months: 7 }]) {
    assert.deepEqual(mins(new CostMeter({ state }).totals(t)), { session: 0, today: 0, month: 0 }, JSON.stringify(state));
  }
  const odd = new CostMeter({
    state: {
      version: 9,
      days: { "2026-13-01": 5, "2026-02-30": 5, x: 1, "2026-11-25": -3, "2026-11-24": "7", "2026-11-26": 2, "2026-11-23": Infinity },
      months: [],
    },
  });
  assert.deepEqual(mins(odd.totals(t)), { session: 0, today: 2, month: 2 }, "months rebuilt from the readable days");
  assert.deepEqual(odd.serialize(), { version: 1, days: { "2026-11-26": 2 }, months: { "2026-11": 2 } });
  // One future date in the file does not push the real history out when the time is known.
  const future = new CostMeter({ state: { days: { "2031-01-01": 1, "2026-11-20": 4 }, months: { "2031-01": 1, "2026-11": 4 } } });
  const kept = future.serialize({ atMs: t });
  assert.equal(kept.days["2026-11-20"], 4);
  assert.equal(kept.months["2026-11"], 4);
});

test("without a clock reading serialize() drops nothing: one future date cannot wipe the history", () => {
  // A day in 2031 from a PC clock that was wrong during an earlier run (or a hand edit). This run
  // makes no call (the app was opened and closed, or only settings changed) and saves with the
  // plain serialize(): counting the kept days back from the newest saved date dropped every real
  // day and month, so this month's spend read $0 after the next start.
  const state = {
    version: 1,
    days: { "2031-01-01": 1, "2026-11-20": 4, "2026-11-25": 30 },
    months: { "2031-01": 1, "2026-11": 34, "2026-10": 120 },
  };
  const m = new CostMeter({ state });
  assert.deepEqual(m.serialize(), {
    version: 1,
    days: { "2026-11-20": 4, "2026-11-25": 30, "2031-01-01": 1 },
    months: { "2026-10": 120, "2026-11": 34, "2031-01": 1 },
  });
  const next = new CostMeter({ state: JSON.stringify(m.serialize()) });
  const now = at("2026-11-26T12:00:00Z");
  assert.deepEqual(mins(next.totals(now)), { session: 0, today: 0, month: 34 });
  assert.deepEqual(budgetStatus({ capUsd: 10, spentUsd: next.totals(now).month.usd }), { minutesLeft: 1077, red: false });
  // Old days are still trimmed once there is a clock reading: atMs, or a call made in this run.
  const old = new CostMeter({ state: { days: { "2026-01-02": 3, "2026-11-25": 30 }, months: { "2026-01": 3, "2026-11": 30 } } });
  assert.deepEqual(old.serialize().days, { "2026-01-02": 3, "2026-11-25": 30 }, "no clock reading: kept");
  assert.deepEqual(old.serialize({ atMs: now }).days, { "2026-11-25": 30 });
  old.callStarted("c", now);
  old.callEnded("c", now + 2 * MIN);
  assert.deepEqual(old.serialize().days, { "2026-11-25": 30, "2026-11-26": 2 }, "this run's call is the clock reading");
  assert.deepEqual(old.serialize().months, { "2026-01": 3, "2026-11": 32 });
});

test("budgetStatus: minutes left before the cap, red under 90", () => {
  assert.deepEqual(budgetStatus({ capUsd: 10, spentUsd: 0 }), { minutesLeft: 1111, red: false });
  assert.deepEqual(budgetStatus({ capUsd: 10, spentUsd: 9.19 }), { minutesLeft: 90, red: false });
  assert.deepEqual(budgetStatus({ capUsd: 10, spentUsd: 9.2 }), { minutesLeft: 88, red: true });
  assert.deepEqual(budgetStatus({ capUsd: 10, spentUsd: 12 }), { minutesLeft: 0, red: true }, "over the cap");
  assert.deepEqual(budgetStatus({ capUsd: 10, spentUsd: NaN }), { minutesLeft: 1111, red: false }, "unknown spend counts as 0");
  assert.deepEqual(budgetStatus({ capUsd: 1, spentUsd: 0.5, pricePerMin: 0.02, redBelowMin: 30 }), { minutesLeft: 25, red: true });
  assert.deepEqual(budgetStatus({ capUsd: 1, spentUsd: 0.3, pricePerMin: 0.02, redBelowMin: 30 }), { minutesLeft: 35, red: false });
  for (const bad of [{}, { capUsd: 0 }, { capUsd: -5 }, { capUsd: NaN }, { capUsd: 10, pricePerMin: 0 }]) {
    assert.deepEqual(budgetStatus(bad), { minutesLeft: null, red: false }, JSON.stringify(bad));
  }
  assert.deepEqual(budgetStatus(), { minutesLeft: null, red: false });
  // With the meter: this month's spend against the monthly cap.
  const m = new CostMeter();
  m.callStarted("c", at("2026-11-26T10:00:00Z"));
  const spent = m.totals(at("2026-11-26T10:00:00Z") + 1000 * MIN).month.usd; // $9.00
  assert.deepEqual(budgetStatus({ capUsd: 10, spentUsd: spent }), { minutesLeft: 111, red: false });
});

test("keyExpiry: days left, warning from 14 days before, expired after the day", () => {
  assert.deepEqual(keyExpiry({ expiresOn: "2027-11-26", today: "2026-11-26" }), { daysLeft: 365, warn: false, expired: false });
  assert.deepEqual(keyExpiry({ expiresOn: "2026-12-11", today: "2026-11-26" }), { daysLeft: 15, warn: false, expired: false });
  assert.deepEqual(keyExpiry({ expiresOn: "2026-12-10", today: "2026-11-26" }), { daysLeft: 14, warn: true, expired: false });
  assert.deepEqual(keyExpiry({ expiresOn: "2026-11-26", today: "2026-11-26" }), { daysLeft: 0, warn: true, expired: false });
  assert.deepEqual(keyExpiry({ expiresOn: "2026-11-25", today: "2026-11-26" }), { daysLeft: -1, warn: true, expired: true });
  assert.equal(keyExpiry({ expiresOn: "2028-03-01", today: "2028-02-28" }).daysLeft, 2, "leap year");
  assert.equal(keyExpiry({ expiresOn: "2027-03-01", today: "2027-02-28" }).daysLeft, 1);
  assert.equal(keyExpiry({ expiresOn: "2027-01-01", today: "2026-12-31" }).daysLeft, 1, "new year");
  assert.equal(keyExpiry({ expiresOn: " 2026-12-01 ", today: "2026-11-26" }).daysLeft, 5, "spaces around");
  assert.equal(keyExpiry({ expiresOn: "2026-12-26", today: "2026-11-26", warnDays: 30 }).warn, true);
  for (const expiresOn of [null, undefined, "", "2027-02-30", "26/11/2027", "2027-11-26T00:00:00Z", 20271126]) {
    assert.equal(keyExpiry({ expiresOn, today: "2026-11-26" }), null, String(expiresOn));
  }
  assert.equal(keyExpiry({ expiresOn: "2027-11-26", today: null }), null);
  assert.equal(keyExpiry(), null);
  // With localDate: India is already on the next day at 20:00 UTC.
  const now = at("2026-11-25T20:00:00Z");
  assert.equal(keyExpiry({ expiresOn: "2026-11-26", today: localDate(now, { timeZoneOffsetMin: IST }) }).daysLeft, 0);
  assert.equal(keyExpiry({ expiresOn: "2026-11-26", today: localDate(now) }).daysLeft, 1);
});

test("idleDisconnect: own voice for 2 minutes, or no speech for 30, while connected", () => {
  const own = (state, nowMs) => idleDisconnect({ state, ownSinceMs: 1000, lastSpeechMs: nowMs - 1000, nowMs });
  for (const state of ["own-manual", "own-fault"]) {
    assert.deepEqual(own(state, 1000 + 119999), { disconnect: false, reason: null }, state);
    assert.deepEqual(own(state, 1000 + 120000), { disconnect: true, reason: "own-voice" }, state);
  }
  // Waiting for the converted voice after Convert is not "own voice": the user asked for it.
  assert.deepEqual(own("connecting", 1000 + 600000), { disconnect: false, reason: null });
  assert.deepEqual(own("converting", 1000 + 600000), { disconnect: false, reason: null });
  const quiet = (state, nowMs, lastSpeechMs = 0) => idleDisconnect({ state, ownSinceMs: null, lastSpeechMs, nowMs });
  for (const state of ["connecting", "converting", "own-manual", "own-fault"]) {
    assert.deepEqual(quiet(state, 1799999), { disconnect: false, reason: null }, state);
    assert.deepEqual(quiet(state, 1800000), { disconnect: true, reason: "no-speech" }, state);
  }
  // Not connected: nothing to hang up.
  for (const state of ["off", "unknown", undefined]) {
    assert.deepEqual(idleDisconnect({ state, ownSinceMs: 0, lastSpeechMs: 0, nowMs: 1e9 }), { disconnect: false, reason: null });
  }
  // Own voice wins when both apply; missing times switch their rule off; limits can be changed.
  assert.deepEqual(idleDisconnect({ state: "own-fault", ownSinceMs: 0, lastSpeechMs: 0, nowMs: 1e9 }).reason, "own-voice");
  assert.deepEqual(idleDisconnect({ state: "own-fault", ownSinceMs: null, lastSpeechMs: null, nowMs: 1e9 }), { disconnect: false, reason: null });
  assert.deepEqual(idleDisconnect({ state: "converting", lastSpeechMs: 0, nowMs: NaN }), { disconnect: false, reason: null });
  assert.equal(idleDisconnect({ state: "own-manual", ownSinceMs: 0, lastSpeechMs: 0, nowMs: 5000, ownLimitMs: 5000 }).disconnect, true);
  assert.equal(idleDisconnect({ state: "converting", lastSpeechMs: 0, nowMs: 60000, silentLimitMs: 60000 }).reason, "no-speech");
  assert.deepEqual(idleDisconnect(), { disconnect: false, reason: null });
});
