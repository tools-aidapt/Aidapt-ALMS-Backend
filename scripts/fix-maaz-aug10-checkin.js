'use strict';

require('dotenv').config();
const { query, pool } = require('../src/config/db');
const { computeLateness, computeWorked, shiftLengthHours } = require('../src/utils/attendanceCalc');
const strikeService = require('../src/services/strikeService');
const { pktTimeLabel, pktHm } = require('../src/utils/dateUtils');

const DATE = '2026-08-10';

function pktToUtcIso(dateStr, hours, minutes) {
  const utcMs = Date.UTC(
    Number(dateStr.slice(0, 4)),
    Number(dateStr.slice(5, 7)) - 1,
    Number(dateStr.slice(8, 10)),
    hours - 5,
    minutes,
    0
  );
  return new Date(utcMs).toISOString();
}

async function main() {
  const emp = (
    await query(
      `SELECT e.id, e.name, s.start_time, s.end_time, s.grace_minutes
       FROM employees e
       LEFT JOIN shifts s ON s.id = e.assigned_shift_id
       WHERE e.name ILIKE '%Maaz%Ahmed%' OR e.name ILIKE '%Maaz Ahmed%'
       LIMIT 1`
    )
  ).rows[0];
  if (!emp) throw new Error('Maaz Ahmed not found');

  const beforePunch = (
    await query(
      `SELECT id, date, check_in_time, check_out_time, status, is_late, late_by_minutes,
              worked_hours, worked_minutes, overtime_hours
       FROM attendance_punches
       WHERE employee_id = $1 AND date = $2`,
      [emp.id, DATE]
    )
  ).rows[0];
  if (!beforePunch) throw new Error(`No punch for Maaz on ${DATE}`);

  const beforeStrike = (
    await query(
      `SELECT year_month, late_count, strike_count, strike_items
       FROM employee_monthly_strikes
       WHERE employee_id = $1 AND year_month = '2026-08'`,
      [emp.id]
    )
  ).rows[0];

  console.log(
    'BEFORE',
    JSON.stringify(
      {
        employee: emp.name,
        punch: {
          checkInPkt: pktTimeLabel(beforePunch.check_in_time),
          checkInHm: pktHm(beforePunch.check_in_time),
          checkOutPkt: pktTimeLabel(beforePunch.check_out_time),
          isLate: beforePunch.is_late,
          lateByMinutes: beforePunch.late_by_minutes,
          status: beforePunch.status,
        },
        strike: beforeStrike || null,
      },
      null,
      2
    )
  );

  const shift = {
    fields: {
      StartTime: emp.start_time || '10:00',
      EndTime: emp.end_time || '19:00',
      GraceMinutes: emp.grace_minutes ?? 20,
    },
  };

  const checkIn = pktToUtcIso(DATE, 10, 15); // 10:15 AM PKT
  // Force not late so this day does not count toward strikes.
  const lateness = { isLate: false, lateByMinutes: 0, isImmediateStrike: false };
  const worked = computeWorked(checkIn, beforePunch.check_out_time, shiftLengthHours(shift));

  // Sanity: what would auto-calc say?
  const autoLate = computeLateness(shift, checkIn);

  await query(
    `UPDATE attendance_punches SET
       check_in_time = $1,
       is_late = $2,
       late_by_minutes = $3,
       worked_hours = $4,
       worked_minutes = $5,
       overtime_hours = $6,
       status = 'Present'
     WHERE id = $7`,
    [
      checkIn,
      lateness.isLate,
      lateness.lateByMinutes,
      worked.workedHours,
      worked.workedMinutes,
      worked.overtimeHours,
      beforePunch.id,
    ]
  );

  const month = await strikeService.recomputeForEmployeeMonth(emp.id, DATE);

  const afterPunch = (
    await query(
      `SELECT date, check_in_time, check_out_time, status, is_late, late_by_minutes
       FROM attendance_punches WHERE id = $1`,
      [beforePunch.id]
    )
  ).rows[0];

  console.log(
    'AFTER',
    JSON.stringify(
      {
        employee: emp.name,
        date: DATE,
        checkInTimePkt: pktTimeLabel(afterPunch.check_in_time),
        checkInHmPkt: pktHm(afterPunch.check_in_time),
        checkOutTimePkt: pktTimeLabel(afterPunch.check_out_time),
        isLate: afterPunch.is_late,
        lateByMinutes: afterPunch.late_by_minutes,
        autoWouldBeLate: autoLate.isLate,
        autoLateByMinutes: autoLate.lateByMinutes,
        monthStrikes: month
          ? {
              lateCount: month.fields?.LateCount ?? month.late_count,
              strikeCount: month.fields?.StrikeCount ?? month.strike_count,
              strikeItems: month.fields?.StrikeItems ?? month.strike_items,
            }
          : null,
        workedHours: worked.workedHours,
      },
      null,
      2
    )
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
