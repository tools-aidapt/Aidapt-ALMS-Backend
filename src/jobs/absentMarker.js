'use strict';

const cron = require('node-cron');
const Employee = require('../models/Employee');
const Shift = require('../models/Shift');
const AttendancePunch = require('../models/AttendancePunch');
const holidayService = require('../services/holidayService');
const { todayPktDateStr, dowForDateStr, nowUtcIso } = require('../utils/dateUtils');
const { shiftLengthHours, computeWorked } = require('../utils/attendanceCalc');

const DEFAULT_WORKING_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

/**
 * End-of-day reconciliation for a given PKT date:
 *
 *  1. AUTO CHECK-OUT — any employee who checked in but never checked out has
 *     their punch closed (CheckOutTime = now, worked hours + overtime computed
 *     exactly like a manual check-out). Runs on every day, holidays included,
 *     since a forgotten check-out should always be closed. Only applied when
 *     reconciling *today* — backfilling a past date must not stamp "now" onto
 *     it, which would corrupt worked-hour totals.
 *
 *  2. MARK ABSENT — employees with no punch row at all are marked Absent, but
 *     only when the date is a working day for their shift and not a public
 *     holiday.
 *
 * Idempotent: employees that already have a closed row are left untouched.
 */
async function markAbsentees(dateStr = todayPktDateStr()) {
  const holidays = await holidayService.holidayDateSet(dateStr, dateStr);
  const isHoliday = holidays.has(dateStr);
  const isToday = dateStr === todayPktDateStr();

  const dow = dowForDateStr(dateStr);
  const employees = await Employee.selectWhere("status = 'Active'", [], 'ORDER BY name ASC');

  // Cache shift records to avoid refetching per employee.
  const shiftCache = new Map();
  let marked = 0;
  let checkedOut = 0;

  for (const emp of employees) {
    const shiftId = (emp.fields.AssignedShift || [])[0];
    if (shiftId && !shiftCache.has(shiftId)) {
      shiftCache.set(shiftId, await Shift.get(shiftId));
    }
    const shift = shiftId ? shiftCache.get(shiftId) : null;
    const workingDays = (shift && shift.fields.WorkingDays) || DEFAULT_WORKING_DAYS;

    const existing = await AttendancePunch.findForEmployeeOnDate(emp.id, dateStr);

    // 1. Auto check-out: checked in but never checked out.
    if (isToday && existing && existing.fields.CheckInTime && !existing.fields.CheckOutTime) {
      const now = nowUtcIso();
      const { workedMinutes, workedHours, overtimeHours } = computeWorked(
        existing.fields.CheckInTime,
        now,
        shiftLengthHours(shift)
      );
      await AttendancePunch.update(existing.id, {
        CheckOutTime: now,
        WorkedHours: workedHours,
        WorkedMinutes: workedMinutes,
        OvertimeHours: overtimeHours,
      });
      checkedOut += 1;
      continue;
    }

    if (existing) continue; // already has a row (checked out / absent / leave)

    // 2. Mark absent — only on a working, non-holiday day.
    if (isHoliday) continue;
    if (!workingDays.includes(dow)) continue;

    await AttendancePunch.create({
      Employee: [emp.id],
      Date: dateStr,
      Status: 'Absent',
    });
    marked += 1;
  }

  return { date: dateStr, marked, checkedOut, skipped: isHoliday ? 'holiday' : undefined };
}

/**
 * Schedule the absent-marker. Runs at 23:30 PKT. node-cron uses the server's
 * local time, so a timezone is supplied explicitly.
 */
function schedule() {
  cron.schedule(
    '30 23 * * *',
    async () => {
      try {
        const result = await markAbsentees();
        // eslint-disable-next-line no-console
        console.log('[cron:absentMarker]', result);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[cron:absentMarker] failed:', err.message);
      }
    },
    { timezone: 'Asia/Karachi' }
  );
}

module.exports = { markAbsentees, schedule };
