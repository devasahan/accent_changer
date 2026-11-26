/**
 * What the converted voice costs, and when to stop paying for it.
 *
 * Sanas bills a call from the moment it is Ready until it is destroyed, at
 * PRICE_PER_MIN, whether or not anyone speaks. CostMeter adds up those
 * minutes for this session, today and this month (in the user's local time),
 * and for all time, and keeps per-day and per-month totals small enough to
 * save after every call. Sanas is a prepaid wallet ($10 of free credit, no
 * monthly refill) with an optional monthly spend cap, and conversion stops
 * at whichever runs out first: budgetStatus turns both into minutes left,
 * the smaller of the cap's remainder and the wallet's (creditLeftUsd works
 * the wallet out from the balance the user read in the Sanas Console and the
 * meter's all-time minutes then and now). keyExpiry warns before the API key
 * runs out, and idleDisconnect says when a connected call is only costing
 * money.
 *
 * Pure: no clock, no storage, no timers. Times come in as epoch milliseconds
 * from the caller's clock and the local time zone as an offset in minutes, so
 * the tests can play whole months in a few milliseconds.
 */

/** AT5.2 on Sanas Cloud: $0.0090 per minute (developer.sanas.ai pricing page, updated 2026-10-01). */
export const PRICE_PER_MIN = 0.009;

const MINUTE_MS = 60000;
const DAY_MS = 86400000;
/** Per-day totals kept: 62 days always hold this month and the one before, whatever their lengths. */
const KEEP_DAYS = 62;
/** Per-month totals kept (two years): enough for "this month" and a look back, still a small file. */
const KEEP_MONTHS = 24;
/** Real time zones are within -12:00..+14:00; an offset beyond a whole day is a mistake, read as UTC. */
const MAX_OFFSET_MIN = 24 * 60;
/** Times outside 1970..~9900 are not a clock reading. */
const MAX_TIME_MS = 2.5e14;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const validTime = (ms) => typeof ms === "number" && ms >= 0 && ms <= MAX_TIME_MS;

/** A dollar amount or a count of minutes as the settings and the state file hold them. */
const isAmount = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Offset in ms from minutes to add to UTC for local time; anything unusable is UTC. */
function offsetMs(timeZoneOffsetMin) {
  const min = Number(timeZoneOffsetMin);
  return Number.isFinite(min) && Math.abs(min) <= MAX_OFFSET_MIN ? Math.round(min) * MINUTE_MS : 0;
}

/** Days since 1970-01-01 of a calendar date "YYYY-MM-DD"; null unless it is a real date (no 30 February). */
function dayNumber(text) {
  const m = typeof text === "string" ? DATE.exec(text.trim()) : null;
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const ms = Date.UTC(y, mo, d);
  const date = new Date(ms);
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo || date.getUTCDate() !== d) return null;
  return ms / DAY_MS;
}

/** "YYYY-MM-DD" of a day number. */
const dayKey = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);

/** Local day number of an instant (local time = UTC + offset). */
const localDay = (atMs, offMs) => Math.floor((atMs + offMs) / DAY_MS);

/** The local month that holds a local day: its key "YYYY-MM" and its [start, end) in UTC ms. */
function monthOf(day, offMs) {
  const d = new Date(day * DAY_MS);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return { key: dayKey(day).slice(0, 7), startMs: Date.UTC(y, m, 1) - offMs, endMs: Date.UTC(y, m + 1, 1) - offMs };
}

/** Running count of a month key, for keeping the newest KEEP_MONTHS. */
const monthIndex = (key) => Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7)) - 1;

/** Split [startMs, endMs) at local midnights: fn(dayNumber, ms) for each local day it touches. */
function eachLocalDay(startMs, endMs, offMs, fn) {
  for (let t = startMs, day = localDay(startMs, offMs); t < endMs; day++) {
    const next = Math.min(endMs, (day + 1) * DAY_MS - offMs);
    fn(day, next - t);
    t = next;
  }
}

const overlapMs = (call, fromMs, toMs) => Math.max(0, Math.min(call.endMs, toMs) - Math.max(call.startMs, fromMs));

function add(map, key, min) {
  map.set(key, (map.get(key) ?? 0) + min);
}

const isMinutes = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const entriesOf = (o) => (o && typeof o === "object" && !Array.isArray(o) ? Object.entries(o) : []);
const byKey = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
/** Saved minutes to a millionth (60 µs): short numbers in the file, nothing lost that matters. */
const rounded = ([key, min]) => [key, Math.round(min * 1e6) / 1e6];

/**
 * Totals saved by an earlier run, cleaned: a missing, corrupt or hand-edited
 * file gives empty totals rather than an error (the app must start anyway).
 */
function readState(state) {
  let s = state;
  if (typeof s === "string") {
    try {
      s = JSON.parse(s);
    } catch {
      s = null;
    }
  }
  const days = new Map();
  const months = new Map();
  if (!s || typeof s !== "object") return { days, months, totalMin: 0 };
  for (const [key, min] of entriesOf(s.days)) if (DATE.test(key) && dayNumber(key) !== null && isMinutes(min)) days.set(key, min);
  for (const [key, min] of entriesOf(s.months)) if (MONTH.test(key) && isMinutes(min)) months.set(key, min);
  // Day totals without month totals (an older or hand-made file): rebuild the months from the days.
  if (!months.size) for (const [key, min] of days) add(months, key.slice(0, 7), min);
  // The all-time total; a file from before it was kept: the months it still has (two years).
  let totalMin = isMinutes(s.totalMin) ? s.totalMin : 0;
  if (!isMinutes(s.totalMin)) for (const min of months.values()) totalMin += min;
  return { days, months, totalMin };
}

/**
 * Billed Sanas minutes and their price: this session, today and this month.
 *
 * Call callStarted() when a call reaches Ready and callEnded() when it is
 * destroyed; overlapping calls (a reconnect that overlaps the old call) are
 * each billed. This run's calls are kept as time ranges and split into local
 * days only when asked, so "today" is right for whatever time zone the
 * caller passes, also across midnight and month ends. Earlier runs come in
 * as per-day and per-month totals (`state`, a serialize() result).
 */
export class CostMeter {
  /**
   * @param {object} [options]
   * @param {number} [options.pricePerMin=PRICE_PER_MIN] dollars per billed minute
   * @param {object|string|null} [options.state] a previous serialize() result (or its JSON text);
   *   anything unreadable in it is ignored
   * @param {number} [options.timeZoneOffsetMin=0] default local time zone for totals() and
   *   serialize(): minutes to add to UTC (India +330, New York -300), i.e. -new Date().getTimezoneOffset()
   */
  constructor({ pricePerMin = PRICE_PER_MIN, state = null, timeZoneOffsetMin = 0 } = {}) {
    this.pricePerMin = Number.isFinite(pricePerMin) && pricePerMin >= 0 ? pricePerMin : PRICE_PER_MIN;
    this.timeZoneOffsetMin = timeZoneOffsetMin;
    const saved = readState(state);
    this._days = saved.days; // earlier runs: local date "YYYY-MM-DD" -> minutes
    this._months = saved.months; // earlier runs: "YYYY-MM" -> minutes
    this._totalMin = saved.totalMin; // earlier runs, all time: never trimmed
    this._open = new Map(); // call id -> Ready time (ms)
    this._ended = []; // this run's ended calls: [{startMs, endMs}]
  }

  /**
   * A call reached Ready: billing starts. Starting a call that is already
   * open keeps its first time (billing never starts later than it did), and
   * an invalid time is ignored.
   * @param {*} id anything that tells calls apart (a Map key)
   * @param {number} atMs epoch milliseconds
   */
  callStarted(id, atMs) {
    if (!validTime(atMs) || this._open.has(id)) return;
    this._open.set(id, atMs);
  }

  /**
   * The call was destroyed: billing stops. An id that is not open (never
   * reached Ready, or already ended) and an invalid time are ignored; an end
   * before the start (the clock was set back) bills nothing.
   * @param {*} id
   * @param {number} atMs epoch milliseconds
   */
  callEnded(id, atMs) {
    if (!validTime(atMs) || !this._open.has(id)) return;
    const startMs = this._open.get(id);
    this._open.delete(id);
    if (atMs > startMs) this._ended.push({ startMs, endMs: atMs });
  }

  /** Number of calls billing right now. */
  get openCalls() {
    return this._open.size;
  }

  /** This run's calls as time ranges: the ended ones, and the open ones up to `atMs` (left out without it). */
  _calls(atMs) {
    const calls = this._ended.slice();
    if (validTime(atMs)) for (const startMs of this._open.values()) if (atMs > startMs) calls.push({ startMs, endMs: atMs });
    return calls;
  }

  _money(min) {
    return { min, usd: min * this.pricePerMin };
  }

  /**
   * Minutes and dollars for this session (the calls since this meter was
   * made), today, this month and all time (`all`, earlier runs included, for
   * the wallet: see creditLeftUsd). Open calls count up to `atMs`; "today"
   * and "this month" are the local day and month of `atMs`, earlier runs
   * included.
   *
   * `capMonth` is what a monthly spend cap may have counted: the larger of
   * this local month and the UTC month that holds `atMs`. The Sanas Console
   * does not say which month its cap counts (UTC is likely); near a month's
   * end the two differ by the time zone's offset (in India the local month
   * starts 5.5 h before the UTC one), and the larger never promises minutes
   * the cap has already spent. Earlier runs are known only by local month,
   * so for the UTC month this counts them by the local month of the same
   * name (off by at most the calls an earlier run made within the offset of
   * the month's start or end).
   * @param {number} atMs epoch milliseconds (now)
   * @param {{timeZoneOffsetMin?: number}} [options] minutes to add to UTC for local time
   * @returns {{session: {min: number, usd: number}, today: {min: number, usd: number}, month: {min: number, usd: number},
   *   capMonth: {min: number, usd: number}, all: {min: number, usd: number}}}
   */
  totals(atMs, { timeZoneOffsetMin = this.timeZoneOffsetMin } = {}) {
    if (!validTime(atMs)) throw new TypeError("CostMeter.totals needs the time now, in epoch milliseconds");
    const off = offsetMs(timeZoneOffsetMin);
    const day = localDay(atMs, off);
    const dayStartMs = day * DAY_MS - off;
    const month = monthOf(day, off);
    const utcMonth = monthOf(localDay(atMs, 0), 0);
    let sessionMs = 0;
    let todayMs = 0;
    let monthMs = 0;
    let utcMonthMs = 0;
    for (const call of this._calls(atMs)) {
      sessionMs += call.endMs - call.startMs;
      todayMs += overlapMs(call, dayStartMs, dayStartMs + DAY_MS);
      monthMs += overlapMs(call, month.startMs, month.endMs);
      utcMonthMs += overlapMs(call, utcMonth.startMs, utcMonth.endMs);
    }
    const monthMin = (this._months.get(month.key) ?? 0) + monthMs / MINUTE_MS;
    const utcMonthMin = (this._months.get(utcMonth.key) ?? 0) + utcMonthMs / MINUTE_MS;
    return {
      session: this._money(sessionMs / MINUTE_MS),
      today: this._money((this._days.get(dayKey(day)) ?? 0) + todayMs / MINUTE_MS),
      month: this._money(monthMin),
      capMonth: this._money(Math.max(monthMin, utcMonthMin)),
      all: this._money(this._totalMin + sessionMs / MINUTE_MS),
    };
  }

  /**
   * The totals to save, earlier runs and this one together:
   * { version: 1, days: {"YYYY-MM-DD": min}, months: {"YYYY-MM": min}, totalMin }
   * (plain JSON, local dates; totalMin: all time, never trimmed). Without `atMs` only ended calls are in; pass
   * `atMs` to include open calls up to then, so a save every minute or so
   * during a long call loses at most that minute if the app is killed. The
   * last 62 days are kept, counted back from a clock reading: `atMs`, else
   * this run's latest call end. Older days are dropped, their months keep
   * them; months are kept for two years. Without a clock reading (no `atMs`
   * and no call this run) nothing is dropped: the saved dates alone can't
   * say what "now" is.
   * @param {{atMs?: number, timeZoneOffsetMin?: number}} [options]
   * @returns {{version: 1, days: Object<string, number>, months: Object<string, number>, totalMin: number}}
   */
  serialize({ atMs = null, timeZoneOffsetMin = this.timeZoneOffsetMin } = {}) {
    const off = offsetMs(timeZoneOffsetMin);
    const days = new Map(this._days);
    const months = new Map(this._months);
    const calls = this._calls(atMs);
    let totalMin = this._totalMin;
    for (const call of calls) totalMin += (call.endMs - call.startMs) / MINUTE_MS;
    for (const call of calls) {
      eachLocalDay(call.startMs, call.endMs, off, (day, ms) => {
        const key = dayKey(day);
        add(days, key, ms / MINUTE_MS);
        add(months, key.slice(0, 7), ms / MINUTE_MS);
      });
    }
    // Count the kept days back from a clock reading (atMs, else this run's
    // latest call end). Without one, keep everything: counting back from the
    // newest saved date would let one future date (a PC clock that was wrong
    // during an earlier run, or a hand edit) drop every real day and month,
    // and this month's spend with them. A run without calls adds nothing, so
    // the file does not grow; the next save with a clock reading trims it.
    let nowMs = validTime(atMs) ? atMs : null;
    for (const call of calls) if (nowMs === null || call.endMs > nowMs) nowMs = call.endMs;
    let keptDays = [...days];
    let keptMonths = [...months];
    if (nowMs !== null) {
      const newestDay = localDay(nowMs, off);
      const newestMonth = monthIndex(dayKey(newestDay));
      keptDays = keptDays.filter(([key]) => dayNumber(key) > newestDay - KEEP_DAYS);
      keptMonths = keptMonths.filter(([key]) => monthIndex(key) > newestMonth - KEEP_MONTHS);
    }
    return {
      version: 1,
      days: Object.fromEntries(keptDays.sort(byKey).map(rounded)),
      months: Object.fromEntries(keptMonths.sort(byKey).map(rounded)),
      totalMin: rounded(["", totalMin])[1],
    };
  }
}

/**
 * The local date "YYYY-MM-DD" of an instant: `today` for keyExpiry, in the
 * same time zone the CostMeter uses. Null for an invalid time.
 * @param {number} atMs epoch milliseconds
 * @param {{timeZoneOffsetMin?: number}} [options] minutes to add to UTC for local time (default 0)
 * @returns {string|null}
 */
export function localDate(atMs, { timeZoneOffsetMin = 0 } = {}) {
  return validTime(atMs) ? dayKey(localDay(atMs, offsetMs(timeZoneOffsetMin))) : null;
}

/**
 * What is left in the Sanas wallet (dollars), from the balance the user read
 * in the Sanas Console (`creditUsd`, settings.budget.creditUsd) and the
 * meter's all-time minutes when it was read (`creditAtMin`,
 * settings.budget.creditAtMin) and now (`totalMin`, totals(now).all.min):
 * creditUsd - (totalMin - creditAtMin) * price. Null when that is not
 * known: no balance entered, or a meter whose all-time total is below the
 * one the balance was read at (its saved state was lost: ask again, as after
 * a top-up). It may go below 0 when the meter counted more than Sanas billed.
 * @param {{creditUsd: number|null, creditAtMin: number|null, totalMin: number, pricePerMin?: number}} credit
 * @returns {number|null}
 */
export function creditLeftUsd({ creditUsd, creditAtMin, totalMin, pricePerMin = PRICE_PER_MIN } = {}) {
  if (!isAmount(creditUsd) || !isAmount(creditAtMin) || !isAmount(totalMin) || !isAmount(pricePerMin)) return null;
  // A millionth of a minute of slack: the saved totals are rounded to that.
  if (totalMin < creditAtMin - 1e-6) return null;
  return creditUsd - Math.max(0, totalMin - creditAtMin) * pricePerMin;
}

/**
 * Minutes of conversion left, rounded down (never promise a minute that
 * isn't there): the smaller of what the monthly spend cap and the wallet
 * still allow. `red` when fewer than `redBelowMin` are left: under 90
 * minutes, one more interview may not fit. `creditUnknown` when the wallet
 * is not known (no balance entered: creditLeftUsd gave null): then only the
 * cap is counted, and the checklist must show it amber at best, never green,
 * since the wallet does not refill each month and may hold far less. Without
 * a usable price, or with neither a usable cap nor a known wallet,
 * minutesLeft is null and nothing is red.
 * @param {{capUsd: number|null, spentUsd: number, creditLeftUsd?: number|null, pricePerMin?: number, redBelowMin?: number}} budget
 *   capUsd: the monthly spend cap (none: no cap); spentUsd: what the cap counts, this month's
 *   spend (totals(now).capMonth.usd), unknown counts as 0; creditLeftUsd: see creditLeftUsd
 * @returns {{minutesLeft: number|null, red: boolean, creditUnknown: boolean}}
 */
export function budgetStatus({ capUsd, spentUsd, creditLeftUsd: credit = null, pricePerMin = PRICE_PER_MIN, redBelowMin = 90 } = {}) {
  const creditUnknown = !(typeof credit === "number" && Number.isFinite(credit));
  const hasCap = Number.isFinite(capUsd) && capUsd > 0;
  if (!(Number.isFinite(pricePerMin) && pricePerMin > 0) || (!hasCap && creditUnknown)) {
    return { minutesLeft: null, red: false, creditUnknown };
  }
  const spent = Number.isFinite(spentUsd) && spentUsd > 0 ? spentUsd : 0;
  let leftUsd = hasCap ? capUsd - spent : Infinity;
  if (!creditUnknown && credit < leftUsd) leftUsd = credit;
  // The small allowance keeps $0.81 at $0.009/min at 90 minutes, not 89.99999999999999 → 89.
  const minutesLeft = Math.max(0, Math.floor(leftUsd / pricePerMin + 1e-9));
  return { minutesLeft, red: minutesLeft < redBelowMin, creditUnknown };
}

/**
 * How long the Sanas API key has left. Dates are calendar dates
 * "YYYY-MM-DD" (`today` in local time, see localDate). On its expiry day the
 * key still counts as working (daysLeft 0); `warn` from 14 days before.
 * Null when either date is missing or not a real date.
 * @param {{expiresOn: string|null, today: string, warnDays?: number}} dates
 * @returns {{daysLeft: number, warn: boolean, expired: boolean}|null}
 */
export function keyExpiry({ expiresOn, today, warnDays = 14 } = {}) {
  const end = dayNumber(expiresOn);
  const now = dayNumber(today);
  if (end === null || now === null) return null;
  const daysLeft = end - now;
  return { daysLeft, warn: daysLeft <= warnDays, expired: daysLeft < 0 };
}

/** Mixer states in which a Sanas call is up and billing. */
const CONNECTED = new Set(["connecting", "converting", "own-manual", "own-fault"]);
/** States in which the meeting hears the user's own voice although the call is up. */
const OWN = new Set(["own-manual", "own-fault"]);

/**
 * Should the app hang up the Sanas call to stop paying for nothing? While
 * connected: after `ownLimitMs` on the user's own voice (own-manual or
 * own-fault: nobody hears the converted voice), or after `silentLimitMs`
 * without speech. "connecting" is not "own voice" here: the user asked for
 * the converted voice and the app is waiting for it to be healthy, so only
 * the silence rule applies there. Hanging up never touches the meeting mic
 * (it carries the own voice meanwhile); tell the mixer first (own or off) so
 * the hang-up does not count as a fault, and reconnect only on Convert. The
 * answer stays true while nothing changes: ask while a call is up, act once.
 * @param {object} now
 * @param {string} now.state the mixer's state ("off" | "connecting" | "converting" | "own-manual" | "own-fault")
 * @param {number|null} now.ownSinceMs when the current own-voice state began (or the call connected, if later)
 * @param {number|null} now.lastSpeechMs when the user last spoke (pass the connect time if not since)
 * @param {number} now.nowMs
 * @param {number} [now.ownLimitMs=120000]
 * @param {number} [now.silentLimitMs=1800000]
 * @returns {{disconnect: boolean, reason: "own-voice"|"no-speech"|null}}
 */
export function idleDisconnect({ state, ownSinceMs, lastSpeechMs, nowMs, ownLimitMs = 120000, silentLimitMs = 1800000 } = {}) {
  if (!CONNECTED.has(state) || !Number.isFinite(nowMs)) return { disconnect: false, reason: null };
  if (OWN.has(state) && Number.isFinite(ownSinceMs) && nowMs - ownSinceMs >= ownLimitMs) {
    return { disconnect: true, reason: "own-voice" };
  }
  if (Number.isFinite(lastSpeechMs) && nowMs - lastSpeechMs >= silentLimitMs) {
    return { disconnect: true, reason: "no-speech" };
  }
  return { disconnect: false, reason: null };
}
