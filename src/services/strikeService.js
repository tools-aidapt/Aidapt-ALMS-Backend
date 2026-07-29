'use strict';

const AttendancePunch = require('../models/AttendancePunch');
const Employee = require('../models/Employee');
const Shift = require('../models/Shift');
const EmployeeMonthlyStrike = require('../models/EmployeeMonthlyStrike');
const {
  computeLateness,
  buildStrikeItems,
} = require('../utils/attendanceCalc');
const { pktTimeLabel } = require('../utils/dateUtils');

/** YYYY-MM from a date string (YYYY-MM-DD or ISO). */
function yearMonthOf(dateStr) {
  return String(dateStr).slice(0, 7);
}

/** Last day-of-month date string ("YYYY-MM-DD") for the month of `dateStr`. */
function endOfMonth(dateStr) {
  const year = Number(dateStr.slice(0, 4));
  const month = Number(dateStr.slice(5, 7));
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${dateStr.slice(0, 8)}${String(last).padStart(2, '0')}`;
}

/**
 * Rebuild the persisted monthly strike row from current punches.
 * Merges monthly every-3rd-late strikes with immediate (+30 min after start) strikes.
 *
 * @param {string} employeeId
 * @param {string} yearMonthOrDate YYYY-MM or any date in that month
 * @returns {Promise<object>} EmployeeMonthlyStrike record
 */
async function recomputeForEmployeeMonth(employeeId, yearMonthOrDate) {
  const yearMonth = yearMonthOf(yearMonthOrDate);
  const from = `${yearMonth}-01`;
  const to = endOfMonth(from);

  const [punches, employee] = await Promise.all([
    AttendancePunch.query({ employeeId, from, to }),
    Employee.get(employeeId),
  ]);
  const shiftId = employee && (employee.fields.AssignedShift || [])[0];
  const shift = shiftId ? await Shift.get(shiftId) : null;

  const dayInfos = punches.map((r) => {
    const date = String(r.fields.Date).slice(0, 10);
    const checkIn = r.fields.CheckInTime || null;
    const checkInMeta = {
      checkInTime: checkIn,
      checkInTimePkt: pktTimeLabel(checkIn),
    };
    // Prefer live evaluation from check-in + shift so immediate strikes stay
    // accurate even when IsLate was edited independently.
    if (checkIn && shift) {
      const lateness = computeLateness(shift, checkIn);
      return {
        date,
        isLate: lateness.isLate,
        isImmediateStrike: lateness.isImmediateStrike,
        ...checkInMeta,
      };
    }
    return {
      date,
      isLate: Boolean(r.fields.IsLate),
      isImmediateStrike: false,
      ...checkInMeta,
    };
  });

  const lateCount = dayInfos.filter((d) => d.isLate).length;
  const strikeItems = buildStrikeItems(dayInfos);

  return EmployeeMonthlyStrike.upsertForEmployeeMonth({
    employeeId,
    yearMonth,
    lateCount,
    strikeCount: strikeItems.length,
    strikeItems,
  });
}

module.exports = {
  yearMonthOf,
  recomputeForEmployeeMonth,
};
