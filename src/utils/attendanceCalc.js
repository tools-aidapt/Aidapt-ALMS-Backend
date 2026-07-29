'use strict';

/**
 * Pure attendance calculations — no I/O, no Airtable, no env. Kept separate so
 * they can be unit-tested in isolation and reasoned about independently of the
 * data layer.
 */

const { pktMinutesOfDay, parseHhMm, minutesBetween, round2 } = require('./dateUtils');

/**
 * Geofence mode from a computed distance and radius.
 * @returns {'Office'|'Remote In'}
 */
function modeForDistance(distanceMeters, radiusMeters) {
  return distanceMeters <= radiusMeters ? 'Office' : 'Remote In';
}

/**
 * After this many minutes past shift StartTime (PKT), the day is an immediate
 * strike regardless of the monthly late accumulation.
 */
const IMMEDIATE_STRIKE_AFTER_START_MINUTES = 30;

/**
 * Lateness against the shift start + grace, evaluated in PKT.
 * Also flags an immediate strike when arrival is more than
 * IMMEDIATE_STRIKE_AFTER_START_MINUTES after StartTime.
 *
 * @param {{fields: {StartTime: string, GraceMinutes?: number}}|null} shift
 * @param {string|Date} checkInInstant absolute instant
 * @returns {{isLate: boolean, lateByMinutes: number, isImmediateStrike: boolean}}
 */
function computeLateness(shift, checkInInstant) {
  if (!shift) return { isLate: false, lateByMinutes: 0, isImmediateStrike: false };
  const startMin = parseHhMm(shift.fields.StartTime);
  if (startMin === null) return { isLate: false, lateByMinutes: 0, isImmediateStrike: false };
  const grace = Number.isFinite(shift.fields.GraceMinutes)
    ? shift.fields.GraceMinutes
    : 0;
  const arrivalMin = pktMinutesOfDay(checkInInstant);
  const allowedMin = startMin + grace;
  const strikeAfterMin = startMin + IMMEDIATE_STRIKE_AFTER_START_MINUTES;
  const isImmediateStrike = arrivalMin > strikeAfterMin;
  if (arrivalMin > allowedMin) {
    return {
      isLate: true,
      lateByMinutes: arrivalMin - allowedMin,
      isImmediateStrike,
    };
  }
  return { isLate: false, lateByMinutes: 0, isImmediateStrike };
}

/**
 * After this many strikes within a calendar month, that strike's day becomes a
 * Half Day. Strikes themselves are recorded separately; Half Day is NOT applied
 * to every strike day — only the 3rd, 6th, 9th… strike.
 */
const LATE_STRIKE_THRESHOLD = 3;

const IMMEDIATE_STRIKE_REASON =
  'Immediate strike: arrived more than 30 minutes after shift start';

function monthlyStrikeReason(lateOrdinal) {
  return `Late strike: ${lateOrdinal}${ordinalSuffix(lateOrdinal)} late day of the month`;
}

function ordinalSuffix(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return 'th';
  const mod10 = n % 10;
  if (mod10 === 1) return 'st';
  if (mod10 === 2) return 'nd';
  if (mod10 === 3) return 'rd';
  return 'th';
}

/**
 * Dates that should show as Half Day: every LATE_STRIKE_THRESHOLD-th strike
 * within each calendar month (3rd, 6th, 9th…), not every strike day.
 *
 * @param {Array<{date: string, isLate: boolean, isImmediateStrike?: boolean, checkInTime?: string|null, checkInTimePkt?: string|null}>} dayInfos
 * @returns {Set<string>}
 */
function lateStrikeHalfDayDates(dayInfos) {
  return halfDayDatesFromStrikeItems(buildStrikeItems(dayInfos));
}

/**
 * From persisted/derived strike items, pick Half Day dates (every 3rd strike
 * per month, chronologically).
 *
 * @param {Array<{date: string}>} strikeItems
 * @returns {Set<string>}
 */
function halfDayDatesFromStrikeItems(strikeItems) {
  const result = new Set();
  const byMonth = new Map();
  const ordered = [...(strikeItems || [])].sort((a, b) => {
    const da = String(a.date).slice(0, 10);
    const db = String(b.date).slice(0, 10);
    return da < db ? -1 : da > db ? 1 : 0;
  });

  for (const item of ordered) {
    const date = String(item.date).slice(0, 10);
    const month = date.slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(date);
  }

  for (const dates of byMonth.values()) {
    dates.forEach((date, idx) => {
      if ((idx + 1) % LATE_STRIKE_THRESHOLD === 0) result.add(date);
    });
  }
  return result;
}

/**
 * Build deduped strike items (date + reason + check-in time) from late /
 * immediate-strike days. When a day qualifies for both rules, one item is
 * emitted and the immediate strike reason takes priority.
 *
 * These are strike records only — Half Day status is applied separately via
 * halfDayDatesFromStrikeItems (every 3rd strike).
 *
 * @param {Array<{
 *   date: string,
 *   isLate: boolean,
 *   isImmediateStrike?: boolean,
 *   checkInTime?: string|null,
 *   checkInTimePkt?: string|null,
 * }>} dayInfos
 * @returns {Array<{date: string, reason: string, checkInTime: string|null, checkInTimePkt: string|null}>}
 */
function buildStrikeItems(dayInfos) {
  const byDate = new Map();
  const countByMonth = new Map();
  const ordered = [...dayInfos].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  for (const { date, isLate, isImmediateStrike, checkInTime, checkInTimePkt } of ordered) {
    let reason = null;

    if (isLate) {
      const month = date.slice(0, 7);
      const next = (countByMonth.get(month) || 0) + 1;
      countByMonth.set(month, next);
      if (next % LATE_STRIKE_THRESHOLD === 0) {
        reason = monthlyStrikeReason(next);
      }
    }

    if (isImmediateStrike) {
      // Immediate strike wins when both rules hit the same day.
      reason = IMMEDIATE_STRIKE_REASON;
    }

    if (reason) {
      byDate.set(date, {
        date,
        reason,
        checkInTime: checkInTime || null,
        checkInTimePkt: checkInTimePkt || null,
      });
    }
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Shift length in hours from StartTime/EndTime; null if unparseable.
 * Supports overnight shifts (end < start).
 */
function shiftLengthHours(shift) {
  if (!shift) return null;
  const start = parseHhMm(shift.fields.StartTime);
  const end = parseHhMm(shift.fields.EndTime);
  if (start === null || end === null) return null;
  const span = end >= start ? end - start : end + 24 * 60 - start;
  return round2(span / 60);
}

/**
 * Worked minutes/hours + overtime from two absolute UTC instants.
 *
 * Returns nulls unless BOTH timestamps are present — a missing check-in must
 * never be coerced to `new Date(null)` (the Unix epoch), which produced the
 * ~495,000-hour durations. Negative spans (bad edits) clamp to 0.
 *
 * @param {string|Date|null} checkInInstant
 * @param {string|Date|null} checkOutInstant
 * @param {number|null} shiftLen scheduled shift length in hours (for overtime)
 * @returns {{workedMinutes: number|null, workedHours: number|null, overtimeHours: number|null}}
 */
function computeWorked(checkInInstant, checkOutInstant, shiftLen) {
  if (!checkInInstant || !checkOutInstant) {
    return { workedMinutes: null, workedHours: null, overtimeHours: null };
  }
  const workedMinutes = Math.max(0, minutesBetween(checkInInstant, checkOutInstant));
  const workedHours = round2(workedMinutes / 60);
  const shiftMinutes = shiftLen == null ? null : Math.round(shiftLen * 60);
  const overtimeMinutes = shiftMinutes == null ? 0 : Math.max(0, workedMinutes - shiftMinutes);
  return { workedMinutes, workedHours, overtimeHours: round2(overtimeMinutes / 60) };
}

module.exports = {
  modeForDistance,
  computeLateness,
  shiftLengthHours,
  computeWorked,
  lateStrikeHalfDayDates,
  halfDayDatesFromStrikeItems,
  buildStrikeItems,
  LATE_STRIKE_THRESHOLD,
  IMMEDIATE_STRIKE_AFTER_START_MINUTES,
  IMMEDIATE_STRIKE_REASON,
  monthlyStrikeReason,
};
