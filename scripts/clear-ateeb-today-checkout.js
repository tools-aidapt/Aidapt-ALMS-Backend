'use strict';

require('dotenv').config();
const { query, pool } = require('../src/config/db');
const { todayPktDateStr, pktTimeLabel } = require('../src/utils/dateUtils');

async function main() {
  const today = todayPktDateStr();
  const emp = (
    await query(`SELECT id, name FROM employees WHERE name ILIKE '%Ateeb%' LIMIT 1`)
  ).rows[0];
  if (!emp) throw new Error('Ateeb not found');

  const r = await query(
    `UPDATE attendance_punches SET
       check_out_time = NULL,
       worked_hours = NULL,
       worked_minutes = NULL,
       overtime_hours = NULL
     WHERE employee_id = $1 AND date = $2
     RETURNING date, check_in_time, check_out_time, status`,
    [emp.id, today]
  );

  if (!r.rows[0]) throw new Error(`No punch for ${today}`);

  console.log(
    JSON.stringify(
      {
        employee: emp.name,
        date: today,
        checkInPkt: pktTimeLabel(r.rows[0].check_in_time),
        checkOut: r.rows[0].check_out_time,
        status: r.rows[0].status,
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
