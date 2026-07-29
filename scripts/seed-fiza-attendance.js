'use strict';

/**
 * One-off: seed/update Fiza attendance from the provided sheet.
 * Run: node scripts/seed-fiza-attendance.js
 *
 * Notes:
 * - Pre-joining days are skipped (no punch rows).
 * - 08 Jul checkout "6:27 AM" treated as 06:27 PM (clear sheet typo).
 * - 15 Jul Day Off -> Absent placeholder (no check-in/out).
 */

require('dotenv').config();
const { pool, query } = require('../src/config/db');
const { computeLateness, computeWorked, shiftLengthHours } = require('../src/utils/attendanceCalc');
const strikeService = require('../src/services/strikeService');

function parseAmPm(label) {
  const m = String(label)
    .trim()
    .match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) throw new Error(`Bad time: ${label}`);
  let hours = Number(m[1]);
  const minutes = Number(m[2]);
  const ap = m[3].toUpperCase();
  if (ap === 'AM') {
    if (hours === 12) hours = 0;
  } else if (hours !== 12) {
    hours += 12;
  }
  return { hours, minutes };
}

function pktToUtcIso(dateStr, timeLabel) {
  const { hours, minutes } = parseAmPm(timeLabel);
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

const PRESENT_ROWS = [
  { date: '2026-07-06', in: '10:07 AM', out: '06:32 PM' },
  { date: '2026-07-07', in: '10:10 AM', out: '06:20 PM' },
  // Sheet says 6:27 AM — treat as 06:27 PM
  { date: '2026-07-08', in: '10:14 AM', out: '06:27 PM' },
  { date: '2026-07-09', in: '10:14 AM', out: '06:30 PM' },
  { date: '2026-07-13', in: '09:55 AM', out: '06:32 PM' },
  { date: '2026-07-14', in: '10:14 AM', out: '07:15 PM' },
  { date: '2026-07-16', in: '10:14 AM', out: '06:55 PM' },
  { date: '2026-07-17', in: '08:22 AM', out: '06:45 PM' },
  { date: '2026-07-20', in: '10:05 AM', out: '07:00 PM' },
  { date: '2026-07-21', in: '10:11 AM', out: '07:12 PM' },
];

const ABSENT_DATES = [
  '2026-06-30',
  '2026-07-01',
  '2026-07-02',
  '2026-07-03',
  '2026-07-10',
  '2026-07-15', // Day Off
];

const PRE_JOINING_DATES = [
  '2026-06-24',
  '2026-06-25',
  '2026-06-26',
  '2026-06-29',
];

async function upsertAbsent(employeeId, date) {
  await query(
    `INSERT INTO attendance_punches (
       employee_id, date, status, is_late, late_by_minutes,
       check_in_time, check_out_time, worked_hours, worked_minutes, overtime_hours
     ) VALUES ($1, $2, 'Absent', false, 0, NULL, NULL, NULL, NULL, NULL)
     ON CONFLICT (employee_id, date) DO UPDATE SET
       status = 'Absent',
       is_late = false,
       late_by_minutes = 0,
       check_in_time = NULL,
       check_out_time = NULL,
       worked_hours = NULL,
       worked_minutes = NULL,
       overtime_hours = NULL`,
    [employeeId, date]
  );
}

async function main() {
  let empRes = await query(
    `SELECT e.id, e.name, e.assigned_shift_id, e.date_of_joining,
            s.start_time, s.end_time, s.grace_minutes
     FROM employees e
     LEFT JOIN shifts s ON s.id = e.assigned_shift_id
     WHERE e.name ILIKE '%Fiza%'`
  );

  if (!empRes.rows.length) throw new Error('Employee Fiza not found');
  if (empRes.rows.length > 1) {
    console.log(
      'Matches:',
      empRes.rows.map((r) => ({ id: r.id, name: r.name, doj: r.date_of_joining }))
    );
  }

  const emp = empRes.rows[0];
  console.log('Using employee:', emp.name, emp.id, 'DOJ:', emp.date_of_joining);

  if (!emp.assigned_shift_id) {
    const shiftRes = await query(
      `SELECT id, shift_name, start_time, end_time, grace_minutes
       FROM shifts ORDER BY shift_name LIMIT 1`
    );
    if (!shiftRes.rows.length) throw new Error('No shifts found to assign');
    const s = shiftRes.rows[0];
    await query(`UPDATE employees SET assigned_shift_id = $1 WHERE id = $2`, [s.id, emp.id]);
    emp.assigned_shift_id = s.id;
    emp.start_time = s.start_time;
    emp.end_time = s.end_time;
    emp.grace_minutes = s.grace_minutes;
    console.log(`Assigned shift "${s.shift_name}" (${s.id}) to employee`);
  }

  console.log('Shift:', emp.start_time, '-', emp.end_time, 'grace', emp.grace_minutes);

  // Remove any accidental punches on pre-joining days
  if (PRE_JOINING_DATES.length) {
    await query(
      `DELETE FROM attendance_punches
       WHERE employee_id = $1 AND date = ANY($2::date[])`,
      [emp.id, PRE_JOINING_DATES]
    );
    console.log('Cleared pre-joining dates:', PRE_JOINING_DATES.join(', '));
  }

  const shift = {
    fields: {
      StartTime: emp.start_time,
      EndTime: emp.end_time,
      GraceMinutes: emp.grace_minutes ?? 0,
    },
  };
  const shiftLen = shiftLengthHours(shift);

  let presentCount = 0;
  for (const row of PRESENT_ROWS) {
    const checkIn = pktToUtcIso(row.date, row.in);
    const checkOut = pktToUtcIso(row.date, row.out);
    const lateness = computeLateness(shift, checkIn);
    const worked = computeWorked(checkIn, checkOut, shiftLen);

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
        row.date,
        checkIn,
        checkOut,
        lateness.isLate,
        lateness.lateByMinutes,
        worked.workedHours,
        worked.workedMinutes,
        worked.overtimeHours,
      ]
    );
    presentCount += 1;
    console.log(
      `${row.date} Present in=${row.in} out=${row.out} late=${lateness.isLate}` +
        (lateness.isLate ? `(+${lateness.lateByMinutes}m)` : '') +
        (lateness.isImmediateStrike ? ' IMMEDIATE_STRIKE' : '') +
        ` worked=${worked.workedHours}h`
    );
  }

  for (const date of ABSENT_DATES) {
    await upsertAbsent(emp.id, date);
    console.log(`${date} marked Absent/Day Off`);
  }

  const jun = await strikeService.recomputeForEmployeeMonth(emp.id, '2026-06');
  const jul = await strikeService.recomputeForEmployeeMonth(emp.id, '2026-07');
  console.log('\nPresent punches:', presentCount);
  console.log('Absent/Day Off days:', ABSENT_DATES.length);
  console.log('June strikes:', {
    lateCount: jun.fields.LateCount,
    strikeCount: jun.fields.StrikeCount,
    items: jun.fields.StrikeItems,
  });
  console.log('July strikes:', {
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
