'use strict';

/**
 * Fill Fiza Sheikh absences on 2026-07-01, 02, 03, 10 with Present punches
 * using her average July check-in / check-out times.
 * Run: node scripts/fill-fiza-july-avg.js
 */

require('dotenv').config();
const { pool, query } = require('../src/config/db');
const { computeLateness, computeWorked, shiftLengthHours } = require('../src/utils/attendanceCalc');
const { pktHm } = require('../src/utils/dateUtils');
const strikeService = require('../src/services/strikeService');

const TARGET_DATES = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-10'];

function minutesOfDayPkt(iso) {
  const d = new Date(iso);
  // PKT = UTC+5
  const shifted = new Date(d.getTime() + 5 * 60 * 60 * 1000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

function formatPktLabel(totalMinutes) {
  let m = ((Math.round(totalMinutes) % (24 * 60)) + 24 * 60) % (24 * 60);
  let h24 = Math.floor(m / 60);
  const mins = m % 60;
  const ap = h24 >= 12 ? 'PM' : 'AM';
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${String(mins).padStart(2, '0')} ${ap}`;
}

function pktMinutesToUtcIso(dateStr, totalMinutes) {
  const m = Math.round(totalMinutes);
  const hours = Math.floor(m / 60);
  const minutes = m % 60;
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
    `SELECT e.id, e.name, e.assigned_shift_id,
            s.start_time, s.end_time, s.grace_minutes
       FROM employees e
       LEFT JOIN shifts s ON s.id = e.assigned_shift_id
      WHERE e.name ILIKE '%Fiza%Sheikh%' OR e.name ILIKE '%Fiza%'
      ORDER BY e.name
      LIMIT 1`
  );
  if (!empRes.rows.length) throw new Error('Fiza not found');
  const emp = empRes.rows[0];
  console.log('Employee:', emp.name, emp.id);

  const existing = await query(
    `SELECT date, check_in_time, check_out_time, status
       FROM attendance_punches
      WHERE employee_id = $1
        AND date >= '2026-07-01' AND date <= '2026-07-31'
        AND check_in_time IS NOT NULL
        AND check_out_time IS NOT NULL
        AND date <> ALL($2::date[])
      ORDER BY date`,
    [emp.id, TARGET_DATES]
  );

  if (!existing.rows.length) {
    throw new Error('No existing July present punches to average from');
  }

  let inSum = 0;
  let outSum = 0;
  for (const row of existing.rows) {
    inSum += minutesOfDayPkt(row.check_in_time);
    outSum += minutesOfDayPkt(row.check_out_time);
  }
  const n = existing.rows.length;
  const avgIn = Math.round(inSum / n);
  const avgOut = Math.round(outSum / n);

  console.log(
    `Averaged from ${n} July present days → in ${formatPktLabel(avgIn)} / out ${formatPktLabel(avgOut)} PKT`
  );

  const shift = {
    fields: {
      StartTime: emp.start_time,
      EndTime: emp.end_time,
      GraceMinutes: emp.grace_minutes ?? 0,
    },
  };
  const shiftLen = shiftLengthHours(shift);

  for (const date of TARGET_DATES) {
    const checkIn = pktMinutesToUtcIso(date, avgIn);
    const checkOut = pktMinutesToUtcIso(date, avgOut);
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
         mode = 'Office'`,
      [
        emp.id,
        date,
        checkIn,
        checkOut,
        lateness.isLate,
        lateness.lateByMinutes,
        worked.workedHours,
        worked.workedMinutes,
        worked.overtimeHours,
      ]
    );

    console.log(
      `${date} Present in=${pktHm(checkIn)} out=${pktHm(checkOut)} ` +
        `worked=${worked.workedHours}h late=${lateness.isLate}` +
        (lateness.isLate ? `(+${lateness.lateByMinutes}m)` : '')
    );
  }

  const jul = await strikeService.recomputeForEmployeeMonth(emp.id, '2026-07');
  console.log('\nJuly strikes after update:', {
    lateCount: jul.fields.LateCount,
    strikeCount: jul.fields.StrikeCount,
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
