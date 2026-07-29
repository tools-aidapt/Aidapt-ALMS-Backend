'use strict';

require('dotenv').config();
const { query, pool } = require('../src/config/db');
const { computeLateness, computeWorked, shiftLengthHours } = require('../src/utils/attendanceCalc');
const strikeService = require('../src/services/strikeService');

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
  const empRes = await query(
    `SELECT e.id, e.name, s.start_time, s.end_time, s.grace_minutes
     FROM employees e
     LEFT JOIN shifts s ON s.id = e.assigned_shift_id
     WHERE e.name ILIKE '%Ateeb%'
     LIMIT 1`
  );
  const emp = empRes.rows[0];
  if (!emp) throw new Error('Ateeb not found');

  const punches = (
    await query(
      `SELECT id, date::text AS date, check_out_time
       FROM attendance_punches
       WHERE employee_id = $1
         AND date BETWEEN '2026-06-24' AND '2026-07-21'
         AND check_in_time IS NOT NULL
       ORDER BY date`,
      [emp.id]
    )
  ).rows;

  if (punches.length < 2) throw new Error('Need at least 2 punches to mark strikes');

  const poolDays = [...punches];
  for (let i = poolDays.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [poolDays[i], poolDays[j]] = [poolDays[j], poolDays[i]];
  }
  const picked = poolDays.slice(0, 2).sort((a, b) => a.date.localeCompare(b.date));

  const shift = {
    fields: {
      StartTime: emp.start_time || '10:00',
      EndTime: emp.end_time || '19:00',
      GraceMinutes: emp.grace_minutes ?? 20,
    },
  };
  const shiftLen = shiftLengthHours(shift);

  // Immediate-strike arrivals (> start + 30): 10:35 and 10:42 PKT
  const lateIns = [
    { h: 10, m: 35 },
    { h: 10, m: 42 },
  ];

  for (let i = 0; i < picked.length; i += 1) {
    const row = picked[i];
    const checkIn = pktToUtcIso(row.date, lateIns[i].h, lateIns[i].m);
    const checkOut = row.check_out_time;
    const lateness = computeLateness(shift, checkIn);
    const worked = computeWorked(checkIn, checkOut, shiftLen);

    await query(
      `UPDATE attendance_punches SET
         check_in_time = $1,
         is_late = $2,
         late_by_minutes = $3,
         worked_hours = $4,
         worked_minutes = $5,
         overtime_hours = $6
       WHERE id = $7`,
      [
        checkIn,
        lateness.isLate,
        lateness.lateByMinutes,
        worked.workedHours,
        worked.workedMinutes,
        worked.overtimeHours,
        row.id,
      ]
    );

    console.log(
      `Marked strike day ${row.date} check-in ${lateIns[i].h}:${String(lateIns[i].m).padStart(2, '0')} PKT` +
        ` late=${lateness.isLate} immediate=${lateness.isImmediateStrike}`
    );
  }

  const jun = await strikeService.recomputeForEmployeeMonth(emp.id, '2026-06');
  const jul = await strikeService.recomputeForEmployeeMonth(emp.id, '2026-07');

  console.log('\nJune', {
    lateCount: jun.fields.LateCount,
    strikeCount: jun.fields.StrikeCount,
    items: jun.fields.StrikeItems,
  });
  console.log('July', {
    lateCount: jul.fields.LateCount,
    strikeCount: jul.fields.StrikeCount,
    items: jul.fields.StrikeItems,
  });
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
