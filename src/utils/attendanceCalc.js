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

module.exports = { modeForDistance, computeLateness, shiftLengthHours, computeWorked };
