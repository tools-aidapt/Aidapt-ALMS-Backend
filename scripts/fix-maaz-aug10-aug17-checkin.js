'use strict';

/**
 * One-off: set Maaz Ahmed check-in to 10:29 (Aug 10) and 10:23 (Aug 17) PKT.
 * Recalculates lateness, worked hours, and August strikes.
 * Run: node scripts/fix-maaz-aug10-aug17-checkin.js
 */

require('dotenv').config();
const { query, pool } = require('../src/config/db');
const { computeLateness, computeWorked, shiftLengthHours } = require('../src/utils/attendanceCalc');
const strikeService = require('../src/services/strikeService');
const { pktTimeLabel, pktHm } = require('../src/utils/dateUtils');

const FIXES = [
  { date: '2026-08-10', hours: 10, minutes: 29 },
  { date: '2026-08-17', hours: 10, minutes: 23 },
];

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

  const shift = {
    fields: {
      StartTime: emp.start_time || '10:00',
      EndTime: emp.end_time || '19:00',
      GraceMinutes: emp.grace_minutes ?? 20,
    },
  };
  const shiftLen = shiftLengthHours(shift);

  console.log(
    JSON.stringify(
      {
        employee: emp.name,
        shiftStart: shift.fields.StartTime,
        shiftEnd: shift.fields.EndTime,
        graceMinutes: shift.fields.GraceMinutes,
      },
      null,
      2
    )
  );

  for (const fix of FIXES) {
    const punch = (
      await query(
        `SELECT id, date, check_in_time, check_out_time, status, is_late, late_by_minutes,
                worked_hours, worked_minutes, overtime_hours
         FROM attendance_punches
         WHERE employee_id = $1 AND date = $2`,
        [emp.id, fix.date]
      )
    ).rows[0];
    if (!punch) throw new Error(`No punch for Maaz on ${fix.date}`);

    const checkIn = pktToUtcIso(fix.date, fix.hours, fix.minutes);
    const lateness = computeLateness(shift, checkIn);
    const worked = computeWorked(checkIn, punch.check_out_time, shiftLen);

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

    console.log(
      JSON.stringify(
        {
          date: fix.date,
          before: {
            checkInPkt: pktHm(punch.check_in_time),
            checkOutPkt: pktHm(punch.check_out_time),
            isLate: punch.is_late,
            lateByMinutes: punch.late_by_minutes,
          },
          after: {
            checkInPkt: pktHm(checkIn),
            checkOutPkt: pktHm(punch.check_out_time),
            checkInTimePkt: pktTimeLabel(checkIn),
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

  const month = await strikeService.recomputeForEmployeeMonth(emp.id, '2026-08');
  console.log(
    'August strikes:',
    JSON.stringify(
      {
        lateCount: month.fields?.LateCount ?? month.late_count,
        strikeCount: month.fields?.StrikeCount ?? month.strike_count,
        strikeItems: month.fields?.StrikeItems ?? month.strike_items,
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
