'use strict';

/**
 * Ensure every active employee has a check-in (and check-out) on 2026-07-10,
 * then print each PKT check-in and the org-wide average for that day only.
 *
 * If an employee already has July punches with check-in times, reuse their
 * average July in/out for Jul 10. Otherwise use shift start + ~8 hours out.
 *
 * Run: node scripts/seed-all-employees-jul10.js
 */

require('dotenv').config();
const { query, pool } = require('../src/config/db');
const { computeLateness, computeWorked, shiftLengthHours } = require('../src/utils/attendanceCalc');
const strikeService = require('../src/services/strikeService');
const { pktHm, parseHhMm } = require('../src/utils/dateUtils');

const DATE = '2026-07-10';

function minutesOfDayPkt(iso) {
  const d = new Date(iso);
  const shifted = new Date(d.getTime() + 5 * 60 * 60 * 1000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

function pktMinutesToUtcIso(dateStr, totalMinutes) {
  let m = Math.round(totalMinutes);
  m = ((m % (24 * 60)) + 24 * 60) % (24 * 60);
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

function formatPktLabel(totalMinutes) {
  let m = ((Math.round(totalMinutes) % (24 * 60)) + 24 * 60) % (24 * 60);
  const h24 = Math.floor(m / 60);
  const mins = m % 60;
  return `${String(h24).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

async function main() {
  const emps = (
    await query(
      `SELECT e.id, e.name, e.assigned_shift_id,
              s.start_time, s.end_time, s.grace_minutes AS shift_grace
         FROM employees e
         LEFT JOIN shifts s ON s.id = e.assigned_shift_id
        WHERE e.status = 'Active'
        ORDER BY e.name ASC`
    )
  ).rows;

  if (!emps.length) throw new Error('No active employees');

  const results = [];

  for (const emp of emps) {
    const startMin = parseHhMm(emp.start_time || '10:00') ?? 10 * 60;
    const endMin = parseHhMm(emp.end_time || '19:00') ?? 19 * 60;
    const grace = emp.shift_grace ?? 20;

    // Prefer personal July average (excluding Jul 10) when available
    const prior = await query(
      `SELECT check_in_time, check_out_time
         FROM attendance_punches
        WHERE employee_id = $1
          AND date >= '2026-07-01' AND date <= '2026-07-31'
          AND date <> $2::date
          AND check_in_time IS NOT NULL`,
      [emp.id, DATE]
    );

    let inMin;
    let outMin;
    if (prior.rows.length) {
      inMin = Math.round(
        prior.rows.reduce((s, r) => s + minutesOfDayPkt(r.check_in_time), 0) / prior.rows.length
      );
      const outs = prior.rows.filter((r) => r.check_out_time);
      outMin = outs.length
        ? Math.round(outs.reduce((s, r) => s + minutesOfDayPkt(r.check_out_time), 0) / outs.length)
        : inMin + (endMin - startMin > 0 ? endMin - startMin : 8 * 60);
    } else {
      // Mild variation so people aren't identical (±0–20 min after start)
      const seed = [...String(emp.id)].reduce((a, c) => a + c.charCodeAt(0), 0);
      inMin = startMin + (seed % 21);
      outMin = endMin + (seed % 15);
    }

    const checkIn = pktMinutesToUtcIso(DATE, inMin);
    const checkOut = pktMinutesToUtcIso(DATE, outMin);
    const shift = {
      fields: {
        StartTime: emp.start_time || '10:00',
        EndTime: emp.end_time || '19:00',
        GraceMinutes: grace,
      },
    };
    const lateness = computeLateness(shift, checkIn);
    const worked = computeWorked(checkIn, checkOut, shiftLengthHours(shift));

    await query(
      `INSERT INTO attendance_punches
         (employee_id, date, check_in_time, check_out_time,
          is_late, late_by_minutes, worked_hours, worked_minutes, overtime_hours, status, mode)
       VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, 'Present', 'Office')
       ON CONFLICT (employee_id, date) DO UPDATE SET
         check_in_time = EXCLUDED.check_in_time,
         check_out_time = EXCLUDED.check_out_time,
         is_late = EXCLUDED.is_late,
         late_by_minutes = EXCLUDED.late_by_minutes,
         worked_hours = EXCLUDED.worked_hours,
         worked_minutes = EXCLUDED.worked_minutes,
         overtime_hours = EXCLUDED.overtime_hours,
         status = EXCLUDED.status,
         mode = EXCLUDED.mode`,
      [
        emp.id,
        DATE,
        checkIn,
        checkOut,
        lateness.isLate,
        lateness.lateByMinutes,
        worked.workedHours,
        worked.workedMinutes,
        worked.overtimeHours,
      ]
    );

    await strikeService.recomputeForEmployeeMonth(emp.id, DATE);

    results.push({
      name: emp.name,
      checkInPkt: pktHm(checkIn),
      checkOutPkt: pktHm(checkOut),
      checkInMinutes: inMin,
      isLate: lateness.isLate,
      lateByMinutes: lateness.lateByMinutes,
      source: prior.rows.length ? 'july-avg' : 'shift-default',
    });
  }

  const avgMin = Math.round(
    results.reduce((s, r) => s + r.checkInMinutes, 0) / results.length
  );

  console.log(JSON.stringify(
    {
      date: DATE,
      employeeCount: results.length,
      averageCheckInPkt: formatPktLabel(avgMin),
      averageCheckInMinutes: avgMin,
      employees: results.map((r) => ({
        name: r.name,
        checkInPkt: r.checkInPkt,
        checkOutPkt: r.checkOutPkt,
        isLate: r.isLate,
        lateByMinutes: r.lateByMinutes,
        source: r.source,
      })),
    },
    null,
    2
  ));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
