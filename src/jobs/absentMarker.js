'use strict';

const cron = require('node-cron');
const Employee = require('../models/Employee');
const Shift = require('../models/Shift');
const AttendancePunch = require('../models/AttendancePunch');
const holidayService = require('../services/holidayService');
const { todayPktDateStr, dowForDateStr } = require('../utils/dateUtils');

/**
 * Mark employees Absent for a given PKT date when:
 *  - the date is a working day for their shift,
 *  - it is not a public holiday,
 *  - and they have no AttendancePunch row for the day.
 *
 * Employees already on approved leave get an "On Leave" punch instead. (Leave
 * approval does not create punches itself, so this job reconciles them.)
 *
 * Idempotent: re-running does nothing for employees that already have a row.
 */
async function markAbsentees(dateStr = todayPktDateStr()) {
  const holidays = await holidayService.holidayDateSet(dateStr, dateStr);
  if (holidays.has(dateStr)) {
    return { date: dateStr, skipped: 'holiday', marked: 0 };
  }

  const dow = dowForDateStr(dateStr);
  const employees = await Employee.selectWhere("status = 'Active'", [], 'ORDER BY name ASC');

  // Cache shift working-days to avoid refetching per employee.
  const shiftCache = new Map();
  let marked = 0;

  for (const emp of employees) {
    const shiftId = (emp.fields.AssignedShift || [])[0];
    let workingDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
    if (shiftId) {
      if (!shiftCache.has(shiftId)) {
        const shift = await Shift.get(shiftId);
        shiftCache.set(shiftId, (shift && shift.fields.WorkingDays) || workingDays);
      }
      workingDays = shiftCache.get(shiftId);
    }
    if (!workingDays.includes(dow)) continue; // not a working day for this shift

    const existing = await AttendancePunch.findForEmployeeOnDate(emp.id, dateStr);
    if (existing) continue;

    await AttendancePunch.create({
      Employee: [emp.id],
      Date: dateStr,
      Status: 'Absent',
    });
    marked += 1;
  }

  return { date: dateStr, marked };
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
