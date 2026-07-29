'use strict';

/**
 * One-off: seed/update Umer attendance from the provided sheet.
 * Run: node scripts/seed-umer-attendance.js
 *
 * Pre-joining: 24 Jun – 7 Jul (inclusive) — no punch rows.
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

function dateRangeInclusive(from, to) {
  const out = [];
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  let cur = Date.UTC(fy, fm - 1, fd);
  const end = Date.UTC(ty, tm - 1, td);
  while (cur <= end) {
    const d = new Date(cur);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    out.push(`${y}-${m}-${day}`);
    cur += 24 * 60 * 60 * 1000;
  }
  return out;
}

const PRESENT_ROWS = [
  { date: '2026-07-13', in: '10:00 AM', out: '07:05 PM' },
  { date: '2026-07-14', in: '10:14 AM', out: '06:55 PM' },
  { date: '2026-07-15', in: '10:15 AM', out: '07:08 PM' },
  { date: '2026-07-16', in: '10:00 AM', out: '07:00 PM' },
  { date: '2026-07-17', in: '10:08 AM', out: '07:00 PM' },
  { date: '2026-07-20', in: '09:15 AM', out: '07:15 PM' },
  { date: '2026-07-21', in: '10:12 AM', out: '07:15 PM' },
];

const ABSENT_DATES = ['2026-07-08', '2026-07-09', '2026-07-10'];

const PRE_JOINING_DATES = dateRangeInclusive('2026-06-24', '2026-07-07');

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
     WHERE e.name ILIKE '%Umer%' OR e.name ILIKE '%Umar%'`
  );

  if (!empRes.rows.length) throw new Error('Employee Umer not found');
  if (empRes.rows.length > 1) {
    console.log(
      'Matches:',
      empRes.rows.map((r) => ({ id: r.id, name: r.name, doj: r.date_of_joining }))
    );
  }

  const emp =
    empRes.rows.find((r) => /^umer\b/i.test(r.name) || /\bumer\b/i.test(r.name)) ||
    empRes.rows[0];
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

  await query(
    `DELETE FROM attendance_punches
     WHERE employee_id = $1 AND date = ANY($2::date[])`,
    [emp.id, PRE_JOINING_DATES]
  );
  console.log(
    `Cleared pre-joining dates: ${PRE_JOINING_DATES[0]} .. ${PRE_JOINING_DATES[PRE_JOINING_DATES.length - 1]} (${PRE_JOINING_DATES.length} days)`
  );

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
    console.log(`${date} marked Absent`);
  }

  const jun = await strikeService.recomputeForEmployeeMonth(emp.id, '2026-06');
  const jul = await strikeService.recomputeForEmployeeMonth(emp.id, '2026-07');
  console.log('\nPresent punches:', presentCount);
  console.log('Absent days:', ABSENT_DATES.length);
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
