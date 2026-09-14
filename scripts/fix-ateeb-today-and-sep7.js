'use strict';

/**
 * Ateeb: today check-in 10:14 AM PKT; 7 Sep 2026 check-in 10:05 AM / check-out 8:00 PM.
 * Run: node scripts/fix-ateeb-today-and-sep7.js
 */

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

async function upsertPunch(empId, date, checkIn, checkOut, lateness, worked, modeFallback) {
  await query(
    `INSERT INTO attendance_punches (
       employee_id, date, check_in_time, check_out_time,
       is_late, late_by_minutes, worked_hours, worked_minutes, overtime_hours, status, mode
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Present',$10)
     ON CONFLICT (employee_id, date) DO UPDATE SET
       check_in_time = EXCLUDED.check_in_time,
       check_out_time = EXCLUDED.check_out_time,
       is_late = EXCLUDED.is_late,
       late_by_minutes = EXCLUDED.late_by_minutes,
       worked_hours = EXCLUDED.worked_hours,
       worked_minutes = EXCLUDED.worked_minutes,
       overtime_hours = EXCLUDED.overtime_hours,
       status = 'Present',
       mode = COALESCE(attendance_punches.mode, EXCLUDED.mode)`,
    [
      empId,
      date,
      checkIn,
      checkOut,
      lateness.isLate,
      lateness.lateByMinutes,
      worked.workedHours,
      worked.workedMinutes,
      worked.overtimeHours,
      modeFallback,
    ]
  );
}

async function main() {
  const today = todayPktDateStr();
  const sep7 = '2026-09-07';

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

  const shift = {
    fields: {
      StartTime: emp.start_time || '10:00',
      EndTime: emp.end_time || '19:00',
      GraceMinutes: emp.grace_minutes ?? 20,
    },
  };
  const shiftLen = shiftLengthHours(shift);

  const existingToday = (
    await query(
      `SELECT id, check_in_time, check_out_time, status, is_late, late_by_minutes, mode
       FROM attendance_punches WHERE employee_id = $1 AND date = $2`,
      [emp.id, today]
    )
  ).rows[0];

  const existingSep7 = (
    await query(
      `SELECT id, check_in_time, check_out_time, status, is_late, late_by_minutes, mode
       FROM attendance_punches WHERE employee_id = $1 AND date = $2`,
      [emp.id, sep7]
    )
  ).rows[0];

  const todayIn = pktToUtcIso(today, 10, 14);
  const todayLate = computeLateness(shift, todayIn);
  const todayWorked = computeWorked(
    todayIn,
    existingToday?.check_out_time || null,
    shiftLen
  );
  await upsertPunch(
    emp.id,
    today,
    todayIn,
    existingToday?.check_out_time || null,
    todayLate,
    todayWorked,
    'Office'
  );

  const sep7In = pktToUtcIso(sep7, 10, 5);
  const sep7Out = pktToUtcIso(sep7, 20, 0);
  const sep7Late = computeLateness(shift, sep7In);
  const sep7Worked = computeWorked(sep7In, sep7Out, shiftLen);
  await upsertPunch(emp.id, sep7, sep7In, sep7Out, sep7Late, sep7Worked, 'Office');

  const month = await strikeService.recomputeForEmployeeMonth(emp.id, today);

  const after = (
    await query(
      `SELECT date, check_in_time, check_out_time, status, is_late, late_by_minutes, mode,
              worked_hours, worked_minutes, overtime_hours
       FROM attendance_punches
       WHERE employee_id = $1 AND date IN ($2, $3)
       ORDER BY date`,
      [emp.id, sep7, today]
    )
  ).rows;

  console.log(
    JSON.stringify(
      {
        employee: emp.name,
        todayPkt: today,
        before: {
          today: existingToday
            ? {
                status: existingToday.status,
                checkIn: pktHm(existingToday.check_in_time),
                checkOut: pktHm(existingToday.check_out_time),
                isLate: existingToday.is_late,
              }
            : null,
          sep7: existingSep7
            ? {
                status: existingSep7.status,
                checkIn: pktHm(existingSep7.check_in_time),
                checkOut: pktHm(existingSep7.check_out_time),
                isLate: existingSep7.is_late,
              }
            : null,
        },
        after: after.map((r) => ({
          date: r.date,
          status: r.status,
          checkInPkt: pktTimeLabel(r.check_in_time),
          checkOutPkt: pktTimeLabel(r.check_out_time),
          isLate: r.is_late,
          lateByMinutes: r.late_by_minutes,
          mode: r.mode,
          workedHours: r.worked_hours,
          overtimeHours: r.overtime_hours,
        })),
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
