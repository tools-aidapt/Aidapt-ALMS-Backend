'use strict';

/**
 * Remove Maria Abid's attendance punch for today (check-in and check-out).
 * Run: node scripts/clear-maria-today-checkin.js
 */

require('dotenv').config();
const { query, pool } = require('../src/config/db');
const strikeService = require('../src/services/strikeService');
const { todayPktDateStr, pktTimeLabel } = require('../src/utils/dateUtils');

async function main() {
  const today = todayPktDateStr();
  const emp = (
    await query(
      `SELECT id, name FROM employees WHERE name ILIKE '%Maria%' ORDER BY name LIMIT 1`
    )
  ).rows[0];
  if (!emp) throw new Error('Maria not found');

  const removed = (
    await query(
      `DELETE FROM attendance_punches
       WHERE employee_id = $1 AND date = $2
       RETURNING check_in_time, check_out_time, status, is_late, late_by_minutes, mode`,
      [emp.id, today]
    )
  ).rows[0];
  if (!removed) throw new Error(`No punch for ${emp.name} on ${today}`);

  const month = await strikeService.recomputeForEmployeeMonth(emp.id, today);

  console.log(
    JSON.stringify(
      {
        employee: emp.name,
        date: today,
        removed: {
          status: removed.status,
          checkInPkt: pktTimeLabel(removed.check_in_time),
          checkOutPkt: pktTimeLabel(removed.check_out_time),
          isLate: removed.is_late,
          lateByMinutes: removed.late_by_minutes,
          mode: removed.mode,
        },
        octoberStrikes: month
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
