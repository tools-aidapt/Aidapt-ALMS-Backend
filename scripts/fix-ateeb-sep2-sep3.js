'use strict';

/**
 * Ateeb: Sep 2 check-in 10:05 / check-out 19:30 PKT; Sep 3 check-in 10:06 PKT.
 * Run: node scripts/fix-ateeb-sep2-sep3.js
 */

require('dotenv').config();
const { query, pool } = require('../src/config/db');
const { computeLateness, computeWorked, shiftLengthHours } = require('../src/utils/attendanceCalc');
const strikeService = require('../src/services/strikeService');
const { pktTimeLabel, pktHm } = require('../src/utils/dateUtils');

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

  const shift = {
    fields: {
      StartTime: emp.start_time || '10:00',
      EndTime: emp.end_time || '19:00',
      GraceMinutes: emp.grace_minutes ?? 20,
    },
  };
  const shiftLen = shiftLengthHours(shift);

  const yesterday = (
    await query(
      `SELECT id, date, check_in_time, check_out_time, status, is_late, late_by_minutes, mode
       FROM attendance_punches
       WHERE employee_id = $1 AND date = '2026-09-02'`,
      [emp.id]
    )
  ).rows[0];

  const today = (
    await query(
      `SELECT id, date, check_in_time, check_out_time, status, is_late, late_by_minutes, mode
       FROM attendance_punches
       WHERE employee_id = $1 AND date = '2026-09-03'`,
      [emp.id]
    )
  ).rows[0];

  const yCheckIn = pktToUtcIso('2026-09-02', 10, 5);
  const yCheckOut = pktToUtcIso('2026-09-02', 19, 30);
  const yLate = computeLateness(shift, yCheckIn);
  const yWorked = computeWorked(yCheckIn, yCheckOut, shiftLen);

  if (yesterday) {
    await query(
      `UPDATE attendance_punches SET
         check_in_time = $1,
         check_out_time = $2,
         is_late = $3,
         late_by_minutes = $4,
         worked_hours = $5,
         worked_minutes = $6,
         overtime_hours = $7,
         status = 'Present',
         mode = COALESCE(mode, 'Office')
       WHERE id = $8`,
      [
        yCheckIn,
        yCheckOut,
        yLate.isLate,
        yLate.lateByMinutes,
        yWorked.workedHours,
        yWorked.workedMinutes,
        yWorked.overtimeHours,
        yesterday.id,
      ]
    );
  } else {
    await query(
      `INSERT INTO attendance_punches (
         employee_id, date, check_in_time, check_out_time,
         is_late, late_by_minutes, worked_hours, worked_minutes, overtime_hours, status, mode
       ) VALUES ($1,'2026-09-02',$2,$3,$4,$5,$6,$7,$8,'Present','Office')`,
      [
        emp.id,
        yCheckIn,
        yCheckOut,
        yLate.isLate,
        yLate.lateByMinutes,
        yWorked.workedHours,
        yWorked.workedMinutes,
        yWorked.overtimeHours,
      ]
    );
  }

  const tCheckIn = pktToUtcIso('2026-09-03', 10, 6);
  const tLate = computeLateness(shift, tCheckIn);
  const tWorked = computeWorked(tCheckIn, today?.check_out_time || null, shiftLen);

  if (!today) throw new Error('No punch for Ateeb on 2026-09-03');

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
      tCheckIn,
      tLate.isLate,
      tLate.lateByMinutes,
      tWorked.workedHours,
      tWorked.workedMinutes,
      tWorked.overtimeHours,
      today.id,
    ]
  );

  const month = await strikeService.recomputeForEmployeeMonth(emp.id, '2026-09');

  const after = (
    await query(
      `SELECT date, check_in_time, check_out_time, status, is_late, late_by_minutes, mode,
              worked_hours, worked_minutes
       FROM attendance_punches
       WHERE employee_id = $1 AND date IN ('2026-09-02','2026-09-03')
       ORDER BY date`,
      [emp.id]
    )
  ).rows;

  console.log(
    JSON.stringify(
      {
        employee: emp.name,
        before: {
          sep2: yesterday
            ? {
                status: yesterday.status,
                checkIn: pktHm(yesterday.check_in_time),
                checkOut: pktHm(yesterday.check_out_time),
              }
            : null,
          sep3: {
            checkIn: pktHm(today.check_in_time),
            isLate: today.is_late,
            lateByMinutes: today.late_by_minutes,
            mode: today.mode,
          },
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
          workedMinutes: r.worked_minutes,
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
