'use strict';

/**
 * Date/time helpers.
 *
 * Business timezone is PKT (Pakistan Standard Time = Asia/Karachi = UTC+5,
 * no DST). Times are stored in Airtable as UTC ISO strings; all local
 * reasoning (lateness, "today", working-day counts) is done against PKT via a
 * fixed +5h offset so results are deterministic and library-free.
 */

const PKT_OFFSET_MINUTES = 5 * 60; // UTC+5, no DST
const MS_PER_MINUTE = 60000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Current instant as a UTC ISO string. */
function nowUtcIso() {
  return new Date().toISOString();
}

/**
 * Given a Date (or ISO string) representing an absolute instant, return the
 * wall-clock components as they appear in PKT.
 * @returns {{year, month, day, hours, minutes, seconds, dow, dateStr}}
 *   dateStr is "YYYY-MM-DD" in PKT; dow is 'Mon'..'Sun'.
 */
function toPkt(instant) {
  const date = instant instanceof Date ? instant : new Date(instant);
  const shifted = new Date(date.getTime() + PKT_OFFSET_MINUTES * MS_PER_MINUTE);
  // Read via UTC getters on the shifted timestamp -> PKT wall clock.
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  return {
    year,
    month,
    day,
    hours: shifted.getUTCHours(),
    minutes: shifted.getUTCMinutes(),
    seconds: shifted.getUTCSeconds(),
    dow: DOW[shifted.getUTCDay()],
    dateStr: `${year}-${pad(month)}-${pad(day)}`,
  };
}

/** "YYYY-MM-DD" for the current PKT day. */
function todayPktDateStr() {
  return toPkt(new Date()).dateStr;
}

/** Minutes since PKT midnight for a given instant. */
function pktMinutesOfDay(instant) {
  const p = toPkt(instant);
  return p.hours * 60 + p.minutes;
}

/**
 * Parse "HH:MM" (24h) into minutes-since-midnight.
 * @returns {number|null} null if malformed.
 */
function parseHhMm(hhmm) {
  if (typeof hhmm !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Day-of-week label ('Mon'..'Sun') for a "YYYY-MM-DD" date string (PKT-agnostic). */
function dowForDateStr(dateStr) {
  // Treat the date as noon UTC to avoid any offset edge landing on a prior day.
  const d = new Date(`${dateStr}T12:00:00Z`);
  return DOW[d.getUTCDay()];
}

/**
 * Inclusive list of "YYYY-MM-DD" date strings from fromDate to toDate.
 * Inputs are "YYYY-MM-DD". Returns [] if toDate < fromDate.
 */
function dateRangeInclusive(fromDate, toDate) {
  const out = [];
  const start = Date.parse(`${fromDate}T12:00:00Z`);
  const end = Date.parse(`${toDate}T12:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return out;
  for (let t = start; t <= end; t += MS_PER_DAY) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Difference in whole hours (float, 2dp) between two instants. */
function hoursBetween(startInstant, endInstant) {
  const start = new Date(startInstant).getTime();
  const end = new Date(endInstant).getTime();
  return round2((end - start) / (60 * MS_PER_MINUTE));
}

/** Difference in whole minutes (integer, rounded) between two instants. */
function minutesBetween(startInstant, endInstant) {
  const start = new Date(startInstant).getTime();
  const end = new Date(endInstant).getTime();
  return Math.round((end - start) / MS_PER_MINUTE);
}

/** Human "Hh Mm" from a total-minutes count (e.g. 510 -> "8h 30m"). */
function formatHoursMinutes(totalMinutes) {
  const m = Math.max(0, Math.round(totalMinutes || 0));
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** PKT wall-clock label "YYYY-MM-DD HH:MM" for an instant (or null). */
function pktTimeLabel(instant) {
  if (!instant) return null;
  const p = toPkt(instant);
  return `${p.dateStr} ${pad(p.hours)}:${pad(p.minutes)}`;
}

/** PKT time-of-day "HH:mm" (24h) for an instant (or null). */
function pktHm(instant) {
  if (!instant) return null;
  const p = toPkt(instant);
  return `${pad(p.hours)}:${pad(p.minutes)}`;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

module.exports = {
  PKT_OFFSET_MINUTES,
  nowUtcIso,
  toPkt,
  todayPktDateStr,
  pktMinutesOfDay,
  parseHhMm,
  dowForDateStr,
  dateRangeInclusive,
  hoursBetween,
  minutesBetween,
  formatHoursMinutes,
  pktTimeLabel,
  pktHm,
  round2,
};
