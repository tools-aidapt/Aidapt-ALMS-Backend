'use strict';

/**
 * Ateeb: 24 Sep 2026 check-in 12:12 PM PKT, check-out 8:19 PM PKT.
 * Run: node scripts/fix-ateeb-sep24.js
 */

require('dotenv').config();
const { query, pool } = require('../src/config/db');
const { computeLateness, computeWorked, shiftLengthHours } = require('../src/utils/attendanceCalc');
const strikeService = require('../src/services/strikeService');
const { pktTimeLabel, pktHm } = require('../src/utils/dateUtils');

const DATE = '2026-09-24';

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
       WHERE e.name ILIKE '%Ateeb%'
       LIMIT 1`
    )
  ).rows[0];
  if (!emp) throw new Error('Muhammad Ateeb not found');

  const existing = (
    await query(
      `SELECT id, check_in_time, check_out_time, status, is_late, late_by_minutes, mode
       FROM attendance_punches
       WHERE employee_id = $1 AND date = $2`,
      [emp.id, DATE]
    )
  ).rows[0];

  const shift = {
    fields: {
      StartTime: emp.start_time || '10:00',
      EndTime: emp.end_time || '19:00',
      GraceMinutes: emp.grace_minutes ?? 20,
    },
  };

  const checkIn = pktToUtcIso(DATE, 12, 12); // 12:12 PM PKT
  const checkOut = pktToUtcIso(DATE, 20, 19); // 8:19 PM PKT
  const lateness = computeLateness(shift, checkIn);
  const worked = computeWorked(checkIn, checkOut, shiftLengthHours(shift));

  await query(
    `INSERT INTO attendance_punches (
       employee_id, date, check_in_time, check_out_time,
       is_late, late_by_minutes, worked_hours, worked_minutes, overtime_hours, status, mode
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Present','Office')
     ON CONFLICT (employee_id, date) DO UPDATE SET
       check_in_time = EXCLUDED.check_in_time,
       check_out_time = EXCLUDED.check_out_time,
       is_late = EXCLUDED.is_late,
       late_by_minutes = EXCLUDED.late_by_minutes,
       worked_hours = EXCLUDED.worked_hours,
       worked_minutes = EXCLUDED.worked_minutes,
       overtime_hours = EXCLUDED.overtime_hours,
       status = 'Present',
       mode = COALESCE(attendance_punches.mode, 'Office')`,
    [
      emp.id,
      DATE,
      checkIn,
      checkOut,
      lateness.isLate,
      lateness.lateByMinutes,
      worked.workedHours,
      worked.workedMinutes,
      worked.overtimeHours,
    ]
  );

  const month = await strikeService.recomputeForEmployeeMonth(emp.id, DATE);

  console.log(
    JSON.stringify(
      {
        employee: emp.name,
        date: DATE,
        before: existing
          ? {
              status: existing.status,
              checkIn: pktHm(existing.check_in_time),
              checkOut: pktHm(existing.check_out_time),
              isLate: existing.is_late,
            }
          : null,
        after: {
          checkInPkt: pktTimeLabel(checkIn),
          checkOutPkt: pktTimeLabel(checkOut),
          isLate: lateness.isLate,
          lateByMinutes: lateness.lateByMinutes,
          isImmediateStrike: lateness.isImmediateStrike,
          workedHours: worked.workedHours,
          workedMinutes: worked.workedMinutes,
          overtimeHours: worked.overtimeHours,
        },
        septemberStrikes: month
          ? {
              lateCount: month.fields?.LateCount ?? month.late_count,
              strikeCount: month.fields?.StrikeCount ?? month.strike_count,
              strikeItems: month.fields?.StrikeItems ?? month.strike_items,
            }
          : null,
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
