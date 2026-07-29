'use strict';

/**
 * One-off: seed Muhammad Ateeb attendance punches from the provided sheet.
 * Run: node scripts/seed-ateeb-attendance.js
 */

require('dotenv').config();
const { pool, query } = require('../src/config/db');
const { computeLateness, computeWorked, shiftLengthHours } = require('../src/utils/attendanceCalc');
const strikeService = require('../src/services/strikeService');

/** Parse "10:14 AM" / "08:15 PM" into { hours, minutes } 24h. */
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

/** PKT wall clock on date YYYY-MM-DD -> UTC ISO. PKT = UTC+5. */
function pktToUtcIso(dateStr, timeLabel) {
  const { hours, minutes } = parseAmPm(timeLabel);
  // Represent as if local PKT, then subtract 5h for UTC.
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

const ROWS = [
  { date: '2026-06-24', in: '10:14 AM', out: '08:15 PM' },
  { date: '2026-06-25', in: '10:12 AM', out: '08:22 PM' },
  { date: '2026-06-26', in: '10:08 AM', out: '08:15 PM' },
  { date: '2026-06-29', in: '10:10 AM', out: '08:45 PM' },
  { date: '2026-06-30', in: '10:10 AM', out: '08:55 PM' },
  { date: '2026-07-01', in: '10:15 AM', out: '08:15 PM' },
  { date: '2026-07-02', in: '10:15 AM', out: '08:55 PM' },
  { date: '2026-07-03', in: '10:10 AM', out: '10:00 PM' },
  { date: '2026-07-06', in: '10:10 AM', out: '08:10 PM' },
  { date: '2026-07-07', in: '10:11 AM', out: '09:15 PM' },
  { date: '2026-07-08', in: '10:15 AM', out: '07:56 PM' },
  { date: '2026-07-09', in: '10:13 AM', out: '09:40 PM' },
  { date: '2026-07-10', in: '10:13 AM', out: '08:25 PM' },
  { date: '2026-07-13', in: '10:05 AM', out: '07:10 PM' },
  // 2026-07-14 OFF — skip
  { date: '2026-07-15', in: '10:00 AM', out: '09:30 PM' },
  { date: '2026-07-16', in: '10:05 AM', out: '07:03 PM' },
  { date: '2026-07-17', in: '10:11 AM', out: '07:15 PM' },
  { date: '2026-07-20', in: '10:11 AM', out: '07:08 PM' },
  { date: '2026-07-21', in: '10:15 AM', out: '06:57 PM' },
];

async function main() {
  const empRes = await query(
    `SELECT e.id, e.name, e.assigned_shift_id,
            s.start_time, s.end_time, s.grace_minutes
     FROM employees e
     LEFT JOIN shifts s ON s.id = e.assigned_shift_id
     WHERE e.name ILIKE '%Ateeb%' OR e.name ILIKE '%Muhammad Ateeb%'`
  );

  if (!empRes.rows.length) {
    throw new Error('Employee Muhammad Ateeb not found');
  }
  if (empRes.rows.length > 1) {
    console.log('Matches:', empRes.rows.map((r) => ({ id: r.id, name: r.name })));
  }

  const emp = empRes.rows.find((r) => /ateeb/i.test(r.name)) || empRes.rows[0];
  console.log('Using employee:', emp.name, emp.id);

  // Ensure a shift is assigned so lateness/overtime can be computed.
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

  const shift = emp.assigned_shift_id
    ? {
        fields: {
          StartTime: emp.start_time,
          EndTime: emp.end_time,
          GraceMinutes: emp.grace_minutes ?? 0,
        },
      }
    : null;
  const shiftLen = shiftLengthHours(shift);

  let upserted = 0;
  for (const row of ROWS) {
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
    upserted += 1;
    console.log(
      `${row.date} in=${row.in} out=${row.out} late=${lateness.isLate}` +
        (lateness.isLate ? `(+${lateness.lateByMinutes}m)` : '') +
        (lateness.isImmediateStrike ? ' IMMEDIATE_STRIKE' : '') +
        ` worked=${worked.workedHours}h`
    );
  }

  const jun = await strikeService.recomputeForEmployeeMonth(emp.id, '2026-06');
  const jul = await strikeService.recomputeForEmployeeMonth(emp.id, '2026-07');
  console.log('\nUpserted punches:', upserted);
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
