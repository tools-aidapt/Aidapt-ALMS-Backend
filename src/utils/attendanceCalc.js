'use strict';

/**
 * Pure attendance calculations — no I/O, no Airtable, no env. Kept separate so
 * they can be unit-tested in isolation and reasoned about independently of the
 * data layer.
 */

const { pktMinutesOfDay, parseHhMm, round2 } = require('./dateUtils');

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

module.exports = { modeForDistance, computeLateness, shiftLengthHours };
