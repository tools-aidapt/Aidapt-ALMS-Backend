'use strict';

const cron = require('node-cron');
const Employee = require('../models/Employee');
const Shift = require('../models/Shift');
const AttendancePunch = require('../models/AttendancePunch');
const Holiday = require('../models/Holiday');
const { claimReminder } = require('../models/AttendanceNotificationLog');
const emailService = require('../services/emailService');
const {
  todayPktDateStr,
  toPkt,
  dowForDateStr,
  parseHhMm,
} = require('../utils/dateUtils');

const DEFAULT_WORKING_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

function hmFromMinutes(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Send check-in / check-out reminders for employees whose shift StartTime /
 * EndTime matches the current PKT clock minute.
 *
 * Check-in reminder: working day, not holiday, no check-in yet.
 * Check-out reminder: has check-in, no check-out yet.
 */
async function runShiftReminders(now = new Date()) {
  const pkt = toPkt(now);
  const dateStr = pkt.dateStr;
  const nowHm = `${String(pkt.hours).padStart(2, '0')}:${String(pkt.minutes).padStart(2, '0')}`;
  const dow = dowForDateStr(dateStr);

  const holidaySet = await Holiday.dateSet(dateStr, dateStr);
  const isHoliday = holidaySet.has(dateStr);

  const employees = await Employee.selectWhere(
    "status = 'Active' AND email IS NOT NULL AND email <> ''",
    [],
    'ORDER BY name ASC'
  );

  const shiftCache = new Map();
  const result = { date: dateStr, nowHm, checkInSent: 0, checkOutSent: 0, skipped: 0 };

  for (const emp of employees) {
    const shiftId = (emp.fields.AssignedShift || [])[0];
    if (!shiftId) {
      result.skipped += 1;
      continue;
    }
    if (!shiftCache.has(shiftId)) {
      shiftCache.set(shiftId, await Shift.get(shiftId));
    }
    const shift = shiftCache.get(shiftId);
    if (!shift) {
      result.skipped += 1;
      continue;
    }

    const workingDays =
      shift.fields.WorkingDays && shift.fields.WorkingDays.length
        ? shift.fields.WorkingDays
        : DEFAULT_WORKING_DAYS;
    const startMin = parseHhMm(shift.fields.StartTime);
    const endMin = parseHhMm(shift.fields.EndTime);
    if (startMin === null || endMin === null) {
      result.skipped += 1;
      continue;
    }

    const startHm = hmFromMinutes(startMin);
    const endHm = hmFromMinutes(endMin);
    const punch = await AttendancePunch.findForEmployeeOnDate(emp.id, dateStr);
    const email = emp.fields.Email;

    // Check-in reminder at shift start.
    if (nowHm === startHm) {
      if (isHoliday || !workingDays.includes(dow)) {
        result.skipped += 1;
      } else if (punch && punch.fields.CheckInTime) {
        result.skipped += 1;
      } else {
        const claimed = await claimReminder({
          employeeId: emp.id,
          kind: 'checkin_reminder',
          forDate: dateStr,
        });
        if (claimed) {
          await emailService.sendAttendanceReminder({
            to: email,
            employeeName: emp.fields.Name,
            type: 'checkin',
            date: dateStr,
            shiftTime: startHm,
          });
          result.checkInSent += 1;
        } else {
          result.skipped += 1;
        }
      }
    }

    // Check-out reminder at shift end.
    if (nowHm === endHm) {
      if (!punch || !punch.fields.CheckInTime || punch.fields.CheckOutTime) {
        result.skipped += 1;
      } else {
        const claimed = await claimReminder({
          employeeId: emp.id,
          kind: 'checkout_reminder',
          forDate: dateStr,
        });
        if (claimed) {
          await emailService.sendAttendanceReminder({
            to: email,
            employeeName: emp.fields.Name,
            type: 'checkout',
            date: dateStr,
            shiftTime: endHm,
            checkInTime: punch.fields.CheckInTime,
          });
          result.checkOutSent += 1;
        } else {
          result.skipped += 1;
        }
      }
    }
  }

  return result;
}

function schedule() {
  // Every minute in PKT — matches shift StartTime/EndTime wall-clock.
  cron.schedule(
    '* * * * *',
    async () => {
      try {
        const result = await runShiftReminders();
        if (result.checkInSent || result.checkOutSent) {
          // eslint-disable-next-line no-console
          console.log('[cron:attendanceReminders]', result);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[cron:attendanceReminders] failed:', err.message);
      }
    },
    { timezone: 'Asia/Karachi' }
  );
}

module.exports = { runShiftReminders, schedule };
