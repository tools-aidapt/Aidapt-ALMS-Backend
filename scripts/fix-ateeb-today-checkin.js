'use strict';

require('dotenv').config();
const { query, pool } = require('../src/config/db');
const { computeLateness, computeWorked, shiftLengthHours } = require('../src/utils/attendanceCalc');
const strikeService = require('../src/services/strikeService');
const { todayPktDateStr, pktTimeLabel, pktHm } = require('../src/utils/dateUtils');

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

  const punch = (
    await query(
      `SELECT id, check_out_time FROM attendance_punches
       WHERE employee_id = $1 AND date = $2`,
      [emp.id, today]
    )
  ).rows[0];
  if (!punch) throw new Error(`No punch for ${today}`);

  const shift = {
    fields: {
      StartTime: emp.start_time || '10:00',
      EndTime: emp.end_time || '19:00',
      GraceMinutes: emp.grace_minutes ?? 20,
    },
  };

  const checkIn = pktToUtcIso(today, 10, 15); // 10:15 AM PKT
  const lateness = computeLateness(shift, checkIn);
  const worked = computeWorked(checkIn, punch.check_out_time, shiftLengthHours(shift));

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
      punch.id,
    ]
  );

  await strikeService.recomputeForEmployeeMonth(emp.id, today);

  console.log(
    JSON.stringify(
      {
        employee: emp.name,
        date: today,
        checkInTimePkt: pktTimeLabel(checkIn),
        checkInHmPkt: pktHm(checkIn),
        checkOutTimePkt: pktTimeLabel(punch.check_out_time),
        isLate: lateness.isLate,
        lateByMinutes: lateness.lateByMinutes,
        isImmediateStrike: lateness.isImmediateStrike,
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
