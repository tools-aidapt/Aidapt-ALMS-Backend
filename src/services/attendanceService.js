'use strict';

const AttendancePunch = require('../models/AttendancePunch');
const Employee = require('../models/Employee');
const Shift = require('../models/Shift');
const OfficeConfig = require('../models/OfficeConfig');
const Holiday = require('../models/Holiday');
const env = require('../config/env');
const { query } = require('../config/db');
const { haversineDistanceMeters } = require('../utils/geo');
const {
  nowUtcIso,
  todayPktDateStr,
  minutesBetween,
  formatHoursMinutes,
  pktTimeLabel,
  pktHm,
  dateRangeInclusive,
  dowForDateStr,
  round2,
} = require('../utils/dateUtils');
const {
  modeForDistance,
  computeLateness,
  shiftLengthHours,
} = require('../utils/attendanceCalc');
const { conflict, notFound } = require('../middleware/errorHandler');

/** Shape a punch record for API responses. */
function serialize(rec) {
  const f = rec.fields;
  const workedMinutes = f.WorkedMinutes ?? null;
  return {
    id: rec.id,
    employee: f.Employee || [],
    date: f.Date || null,
    checkInTime: f.CheckInTime || null,
    checkOutTime: f.CheckOutTime || null,
    // PKT wall-clock labels so the exact hour:minute is readable without
    // converting the UTC timestamp on the client.
    checkInTimePkt: pktTimeLabel(f.CheckInTime),
    checkOutTimePkt: pktTimeLabel(f.CheckOutTime),
    checkInLat: f.CheckInLat ?? null,
    checkInLng: f.CheckInLng ?? null,
    checkInAccuracy: f.CheckInAccuracy ?? null,
    distanceMeters: f.DistanceMeters ?? null,
    mode: f.Mode || null,
    isLate: Boolean(f.IsLate),
    lateByMinutes: f.LateByMinutes ?? null,
    workedHours: f.WorkedHours ?? null,
    workedMinutes,
    // "8h 30m" breakdown of the worked duration.
    workedDuration: workedMinutes === null ? null : formatHoursMinutes(workedMinutes),
    overtimeHours: f.OvertimeHours ?? null,
    status: f.Status || null,
  };
}

async function loadEmployeeShift(employeeId) {
  const employee = await Employee.get(employeeId);
  if (!employee) throw notFound('Employee not found');
  const shiftId = (employee.fields.AssignedShift || [])[0];
  const shift = shiftId ? await Shift.get(shiftId) : null;
  return { employee, shift };
}

/**
 * Compute geofence mode + distance for a check-in coordinate.
 * Falls back to treating it as Remote if OfficeConfig is unset.
 */
async function evaluateGeofence(lat, lng) {
  const office = await OfficeConfig.getSingleton();
  if (!office) {
    return { distanceMeters: null, mode: 'Remote In', radius: null };
  }
  const { Latitude, Longitude, RadiusMeters } = office.fields;
  const radius = Number.isFinite(RadiusMeters)
    ? RadiusMeters
    : env.geofence.defaultRadiusMeters;
  const distanceMeters = haversineDistanceMeters(lat, lng, Latitude, Longitude);
  return { distanceMeters, mode: modeForDistance(distanceMeters, radius), radius };
}

/**
 * CHECK-IN — creates today's punch. One per employee per PKT day.
 */
async function checkIn(employeeId, { lat, lng, accuracy }) {
  const dateStr = todayPktDateStr();
  const existing = await AttendancePunch.findForEmployeeOnDate(employeeId, dateStr);
  if (existing) {
    throw conflict('Already checked in today', 'ALREADY_CHECKED_IN');
  }

  const { shift } = await loadEmployeeShift(employeeId);
  const now = nowUtcIso();
  const geo = await evaluateGeofence(lat, lng);
  const lateness = computeLateness(shift, now);

  const fields = {
    Employee: [employeeId],
    Date: dateStr,
    CheckInTime: now,
    CheckInLat: lat,
    CheckInLng: lng,
    CheckInAccuracy: accuracy ?? null,
    DistanceMeters: geo.distanceMeters,
    Mode: geo.mode,
    IsLate: lateness.isLate,
    LateByMinutes: lateness.lateByMinutes,
    Status: 'Present',
  };

  const rec = await AttendancePunch.create(fields);
  return serialize(rec);
}

/**
 * CHECK-OUT — closes today's punch; computes worked hours + overtime.
 */
async function checkOut(employeeId) {
  const dateStr = todayPktDateStr();
  const punch = await AttendancePunch.findForEmployeeOnDate(employeeId, dateStr);
  if (!punch) throw conflict('No check-in found for today', 'NOT_CHECKED_IN');
  if (punch.fields.CheckOutTime) {
    throw conflict('Already checked out today', 'ALREADY_CHECKED_OUT');
  }

  const { shift } = await loadEmployeeShift(employeeId);
  const now = nowUtcIso();

  // Work to the exact minute, then derive hours from it (single source of truth).
  const workedMinutes = minutesBetween(punch.fields.CheckInTime, now);
  const workedHours = round2(workedMinutes / 60);

  const len = shiftLengthHours(shift);
  const shiftMinutes = len === null ? null : Math.round(len * 60);
  const overtimeMinutes = shiftMinutes === null ? 0 : Math.max(0, workedMinutes - shiftMinutes);
  const overtimeHours = round2(overtimeMinutes / 60);

  const rec = await AttendancePunch.update(punch.id, {
    CheckOutTime: now,
    WorkedHours: workedHours,
    WorkedMinutes: workedMinutes,
    OvertimeHours: overtimeHours,
  });
  return serialize(rec);
}

/**
 * List punches with optional filters. Scoping is enforced in the controller;
 * this delegates filtering to the data layer.
 */
async function list({ employeeId, from, to, status } = {}) {
  const rows = await AttendancePunch.query({ employeeId, from, to, status });
  return rows.map(serialize);
}

async function getById(id) {
  const rec = await AttendancePunch.get(id);
  if (!rec) throw notFound('Punch not found');
  return serialize(rec);
}

/** Current-status label from today's punch. */
function statusFromPunch(punch) {
  if (!punch) return 'Not checked in';
  const f = punch.fields;
  if (f.Status === 'On Leave') return 'On leave';
  if (f.Status === 'Holiday') return 'Holiday';
  if (f.Status === 'Absent') return 'Absent';
  if (f.CheckOutTime) return 'Checked out';
  if (f.Mode === 'Remote In') return 'Working remotely';
  return 'In office';
}

/** Last day-of-month date string ("YYYY-MM-DD") for the month of `dateStr`. */
function endOfMonth(dateStr) {
  const year = Number(dateStr.slice(0, 4));
  const month = Number(dateStr.slice(5, 7)); // 1-12
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate(); // day 0 of next month
  return `${dateStr.slice(0, 8)}${String(last).padStart(2, '0')}`;
}

const DEFAULT_WORKING_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

/**
 * Day-type for the calendar cell (NOT location/lateness — those are separate
 * dimensions). Priority: Holiday > Weekend > On Leave > (Half Day > Present) >
 * Future > Absent.
 * @returns {'Present'|'Half Day'|'On Leave'|'Absent'|'Holiday'|'Weekend'|'Future'}
 */
function cellStatus(dateStr, punch, ctx) {
  if (ctx.holidaySet.has(dateStr)) return 'Holiday';
  if (!ctx.workingDays.has(dowForDateStr(dateStr))) return 'Weekend';
  if (ctx.leaveSet.has(dateStr)) return 'On Leave';

  if (punch) {
    const f = punch.fields;
    if (f.Status === 'On Leave') return 'On Leave';
    if (f.Status === 'Absent') return 'Absent';
    if (
      f.CheckOutTime &&
      ctx.shiftLength &&
      f.WorkedHours != null &&
      f.WorkedHours > 0 &&
      f.WorkedHours < ctx.shiftLength / 2
    ) {
      return 'Half Day';
    }
    return 'Present'; // attended — location & lateness carried separately
  }

  if (dateStr > ctx.today) return 'Future';
  return 'Absent'; // past/today working day with no punch
}

/** Location dimension (geofence): "Office" | "Remote" | null. */
function locationOf(punch) {
  if (!punch) return null;
  const m = punch.fields.Mode;
  if (m === 'Office') return 'Office';
  if (m === 'Remote In') return 'Remote';
  return null;
}

/** Human display label combining day-type + location + lateness. */
function cellLabel(status, location, isLate) {
  if (status === 'Present' || status === 'Half Day') {
    const base =
      status === 'Half Day'
        ? 'Half Day'
        : location === 'Office'
          ? 'In Office'
          : location === 'Remote'
            ? 'Remote'
            : 'Present';
    return isLate ? `${base} (Late)` : base;
  }
  return status; // Holiday | Weekend | On Leave | Absent | Future
}

/** Shape one calendar day for the month breakdown (punch may be absent). */
function dayEntry(dateStr, punch, ctx) {
  const f = punch ? punch.fields : null;
  const status = cellStatus(dateStr, punch, ctx);
  const location = locationOf(punch); // Office | Remote | null
  const isLate = f ? Boolean(f.IsLate) : false;
  return {
    date: dateStr,
    dayOfWeek: dowForDateStr(dateStr),
    status, // day-type
    location, // "Office" | "Remote" | null  (independent of status)
    isLate, // time dimension, independent of location
    lateByMinutes: f ? f.LateByMinutes ?? 0 : 0,
    label: cellLabel(status, location, isLate), // e.g. "In Office (Late)"
    mode: f ? f.Mode || null : null,
    checkInTime: f ? pktHm(f.CheckInTime) : null,
    checkOutTime: f ? pktHm(f.CheckOutTime) : null,
    workedHours: f ? f.WorkedHours ?? null : null,
    workedDuration: f && f.WorkedMinutes != null ? formatHoursMinutes(f.WorkedMinutes) : null,
    overtimeHours: f ? f.OvertimeHours ?? null : null,
  };
}

/**
 * Attendance overview for one employee over a month: a day-by-day breakdown
 * (check-in/out for every calendar day) plus period counts, hours, and today's
 * status. Defaults to the full current PKT month (1st → last day).
 */
async function overview({ employeeId, from, to } = {}) {
  const today = todayPktDateStr();
  const fromDate = from || `${today.slice(0, 8)}01`; // 1st of the month
  const toDate = to || endOfMonth(fromDate); // last day of that month

  // Gather everything the per-day cell status needs, in parallel.
  const [employee, holidaySet, leaveResult, rows] = await Promise.all([
    Employee.get(employeeId),
    Holiday.dateSet(fromDate, toDate),
    query(
      `SELECT from_date, to_date FROM leave_requests
       WHERE employee_id = $1 AND status = 'Approved'
         AND from_date <= $3 AND to_date >= $2`,
      [employeeId, fromDate, toDate]
    ),
    AttendancePunch.query({ employeeId, from: fromDate, to: toDate }),
  ]);

  const shiftId = employee ? (employee.fields.AssignedShift || [])[0] : null;
  const shift = shiftId ? await Shift.get(shiftId) : null;
  const workingDaysList =
    shift && shift.fields.WorkingDays && shift.fields.WorkingDays.length
      ? shift.fields.WorkingDays
      : DEFAULT_WORKING_DAYS;

  // Expand approved leave ranges to a set of covered dates.
  const leaveSet = new Set();
  for (const lr of leaveResult.rows) {
    for (const d of dateRangeInclusive(
      String(lr.from_date).slice(0, 10),
      String(lr.to_date).slice(0, 10)
    )) {
      leaveSet.add(d);
    }
  }

  const ctx = {
    today,
    workingDays: new Set(workingDaysList),
    holidaySet,
    leaveSet,
    shiftLength: shiftLengthHours(shift),
  };

  // Index punches by their date for the per-day walk.
  const byDate = new Map();
  for (const r of rows) byDate.set(String(r.fields.Date).slice(0, 10), r);

  const counts = {
    present: 0, absent: 0, onLeave: 0, holiday: 0,
    late: 0, office: 0, remoteIn: 0, recordedDays: rows.length,
  };
  let totalWorkedMinutes = 0;
  let totalOvertimeHours = 0;
  let totalLateMinutes = 0;

  for (const r of rows) {
    const f = r.fields;
    if (f.Status === 'Present') counts.present += 1;
    else if (f.Status === 'Absent') counts.absent += 1;
    else if (f.Status === 'On Leave') counts.onLeave += 1;
    else if (f.Status === 'Holiday') counts.holiday += 1;
    if (f.IsLate) { counts.late += 1; totalLateMinutes += Number(f.LateByMinutes || 0); }
    if (f.Mode === 'Office') counts.office += 1;
    else if (f.Mode === 'Remote In') counts.remoteIn += 1;
    totalWorkedMinutes += Number(f.WorkedMinutes || 0);
    totalOvertimeHours += Number(f.OvertimeHours || 0);
  }

  // One entry per calendar day in the range, each with a derived cell status.
  const days = dateRangeInclusive(fromDate, toDate).map((d) => dayEntry(d, byDate.get(d) || null, ctx));

  const todayPunch = byDate.get(today) || null;

  return {
    employeeId,
    period: { from: fromDate, to: toDate },
    counts,
    hours: {
      totalWorkedMinutes,
      totalWorkedHours: round2(totalWorkedMinutes / 60),
      totalWorkedDuration: formatHoursMinutes(totalWorkedMinutes),
      totalOvertimeHours: round2(totalOvertimeHours),
      totalLateMinutes,
    },
    today: {
      status: statusFromPunch(todayPunch),
      checkInTime: todayPunch ? pktHm(todayPunch.fields.CheckInTime) : null,
      checkOutTime: todayPunch ? pktHm(todayPunch.fields.CheckOutTime) : null,
      mode: todayPunch ? todayPunch.fields.Mode || null : null,
    },
    days,
  };
}

module.exports = {
  checkIn,
  checkOut,
  list,
  getById,
  overview,
  serialize,
  // exported for unit testing of the pure pieces
  evaluateGeofence,
  computeLateness,
  shiftLengthHours,
};
