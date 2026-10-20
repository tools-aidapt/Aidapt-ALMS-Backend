'use strict';

/**
 * Muhammad Ateeb: today's check-in 10:10 AM PKT.
 * Run: node scripts/fix-ateeb-today-1010.js
 */

require('dotenv').config();
const { query, pool } = require('../src/config/db');
const { computeLateness, computeWorked, shiftLengthHours } = require('../src/utils/attendanceCalc');
const strikeService = require('../src/services/strikeService');
const { todayPktDateStr, pktTimeLabel, pktHm } = require('../src/utils/dateUtils');

function pktToUtcIso(dateStr, hours, minutes, seconds = 0) {
  const utcMs = Date.UTC(
    Number(dateStr.slice(0, 4)),
    Number(dateStr.slice(5, 7)) - 1,
    Number(dateStr.slice(8, 10)),
    hours - 5,
    minutes,
    seconds
  );
  return new Date(utcMs).toISOString();
}

async function main() {
  const today = todayPktDateStr();
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
      [emp.id, today]
    )
  ).rows[0];

  const shift = {
    fields: {
      StartTime: emp.start_time || '10:00',
      EndTime: emp.end_time || '19:00',
      GraceMinutes: emp.grace_minutes ?? 20,
    },
  };

  const checkIn = pktToUtcIso(today, 10, 10);
  const lateness = computeLateness(shift, checkIn);
  const worked = computeWorked(checkIn, existing?.check_out_time || null, shiftLengthHours(shift));

  await query(
    `INSERT INTO attendance_punches (
       employee_id, date, check_in_time, check_out_time,
       is_late, late_by_minutes, worked_hours, worked_minutes, overtime_hours, status, mode
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Present','Office')
     ON CONFLICT (employee_id, date) DO UPDATE SET
       check_in_time = EXCLUDED.check_in_time,
       is_late = EXCLUDED.is_late,
       late_by_minutes = EXCLUDED.late_by_minutes,
       worked_hours = EXCLUDED.worked_hours,
       worked_minutes = EXCLUDED.worked_minutes,
       overtime_hours = EXCLUDED.overtime_hours,
       status = 'Present',
       mode = COALESCE(attendance_punches.mode, 'Office')`,
    [
      emp.id,
      today,
      checkIn,
      existing?.check_out_time || null,
      lateness.isLate,
      lateness.lateByMinutes,
      worked.workedHours,
      worked.workedMinutes,
      worked.overtimeHours,
    ]
  );

  await strikeService.recomputeForEmployeeMonth(emp.id, today);

  console.log(
    JSON.stringify(
      {
        employee: emp.name,
        date: today,
        before: existing
          ? {
              status: existing.status,
              checkIn: pktHm(existing.check_in_time),
              checkOut: pktHm(existing.check_out_time),
              isLate: existing.is_late,
            }
          : null,
        after: {
          checkInTimePkt: pktTimeLabel(checkIn),
          checkInIso: checkIn,
          checkOutTimePkt: pktTimeLabel(existing?.check_out_time || null),
          isLate: lateness.isLate,
          lateByMinutes: lateness.lateByMinutes,
          isImmediateStrike: lateness.isImmediateStrike,
          workedHours: worked.workedHours,
        },
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
