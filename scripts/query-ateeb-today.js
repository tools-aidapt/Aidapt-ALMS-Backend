'use strict';

require('dotenv').config();
const { query, pool } = require('../src/config/db');
const { todayPktDateStr, pktTimeLabel, pktHm } = require('../src/utils/dateUtils');

async function main() {
  const today = todayPktDateStr();
  const emp = (
    await query(`SELECT id, name FROM employees WHERE name ILIKE '%Ateeb%' LIMIT 1`)
  ).rows[0];
  if (!emp) throw new Error('Muhammad Ateeb not found');

  const punch = (
    await query(
      `SELECT date, check_in_time, check_out_time, status, is_late, late_by_minutes
       FROM attendance_punches
       WHERE employee_id = $1 AND date = $2`,
      [emp.id, today]
    )
  ).rows[0];

  console.log(
    JSON.stringify(
      {
        employee: emp.name,
        todayPkt: today,
        punch: punch
          ? {
              status: punch.status,
              checkInTimeUtc: punch.check_in_time,
              checkInTimePkt: pktTimeLabel(punch.check_in_time),
              checkInHmPkt: pktHm(punch.check_in_time),
              checkOutTimePkt: pktTimeLabel(punch.check_out_time),
              isLate: punch.is_late,
              lateByMinutes: punch.late_by_minutes,
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
