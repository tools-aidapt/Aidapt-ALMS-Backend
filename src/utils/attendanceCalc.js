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
 * Lateness against the shift start + grace, evaluated in PKT.
 * @param {{fields: {StartTime: string, GraceMinutes?: number}}|null} shift
 * @param {string|Date} checkInInstant absolute instant
 * @returns {{isLate: boolean, lateByMinutes: number}}
 */
function computeLateness(shift, checkInInstant) {
  if (!shift) return { isLate: false, lateByMinutes: 0 };
  const startMin = parseHhMm(shift.fields.StartTime);
  if (startMin === null) return { isLate: false, lateByMinutes: 0 };
  const grace = Number.isFinite(shift.fields.GraceMinutes)
    ? shift.fields.GraceMinutes
    : 0;
  const arrivalMin = pktMinutesOfDay(checkInInstant);
  const allowedMin = startMin + grace;
  if (arrivalMin > allowedMin) {
    return { isLate: true, lateByMinutes: arrivalMin - allowedMin };
  }
  return { isLate: false, lateByMinutes: 0 };
}

/**
 * After this many late days within a calendar month, that day becomes a Half
 * Day. Fixed policy (not configurable). The 3rd, 6th, 9th… late day each trip it.
 */
const LATE_STRIKE_THRESHOLD = 3;

/**
 * Which days should be marked Half Day because of accumulated late strikes.
 *
 * Walks days in date order, keeping a running late-day count keyed by calendar
 * month (YYYY-MM) so the counter resets on the 1st even if the input range
 * spans multiple months. Every time a late day pushes that month's count to a
 * multiple of LATE_STRIKE_THRESHOLD, that day's date is flagged.
 *
 * Pure: derives entirely from current punch lateness, so corrections that clear
 * a late flag automatically shift the strike forward on the next read.
 *
 * @param {Array<{date: string, isLate: boolean}>} dayInfos
 * @returns {Set<string>} dates (YYYY-MM-DD) to mark Half Day
 */
function lateStrikeHalfDayDates(dayInfos) {
  const result = new Set();
  const countByMonth = new Map();
  const ordered = [...dayInfos].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const { date, isLate } of ordered) {
    if (!isLate) continue;
    const month = date.slice(0, 7);
    const next = (countByMonth.get(month) || 0) + 1;
    countByMonth.set(month, next);
    if (next % LATE_STRIKE_THRESHOLD === 0) result.add(date);
  }
  return result;
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
  LATE_STRIKE_THRESHOLD,
};
