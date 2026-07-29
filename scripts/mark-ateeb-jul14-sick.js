'use strict';

require('dotenv').config();
const { query, pool, withTransaction } = require('../src/config/db');

async function main() {
  const empRes = await query(
    `SELECT id, name, manager_id FROM employees WHERE name ILIKE '%Ateeb%' LIMIT 1`
  );
  const emp = empRes.rows[0];
  if (!emp) throw new Error('Muhammad Ateeb not found');
  console.log('Employee:', emp.name, emp.id);

  const balRes = await query(`SELECT * FROM leave_balances WHERE employee_id = $1`, [emp.id]);
  let balance = balRes.rows[0];
  if (!balance) {
    const created = await query(
      `INSERT INTO leave_balances (employee_id, annual, sick, casual)
       VALUES ($1, 0, 1, 0) RETURNING *`,
      [emp.id]
    );
    balance = created.rows[0];
    console.log('Created leave balance with 1 sick day');
  } else {
    console.log('Current sick balance:', balance.sick);
  }

  // Ensure enough sick balance for 1 day approval.
  if (Number(balance.sick) < 1) {
    await query(`UPDATE leave_balances SET sick = sick + 1 WHERE employee_id = $1`, [emp.id]);
    console.log('Topped up sick balance by 1 for this leave');
  }

  const existingLeave = await query(
    `SELECT id, leave_type, status, days
     FROM leave_requests
     WHERE employee_id = $1
       AND from_date <= '2026-07-14'
       AND to_date >= '2026-07-14'`,
    [emp.id]
  );
  if (existingLeave.rows.length) {
    console.log('Existing leave covering 14 Jul:', existingLeave.rows);
  }

  let leaveId = existingLeave.rows[0] && existingLeave.rows[0].id;

  await withTransaction(async (client) => {
    if (!leaveId) {
      const ins = await client.query(
        `INSERT INTO leave_requests (
           employee_id, leave_type, from_date, to_date, days, reason,
           status, manager_id, applied_at, decided_at, decision_token
         ) VALUES (
           $1, 'Sick', '2026-07-14', '2026-07-14', 1,
           'Sick leave (Day Off)',
           'Approved', $2, now(), now(), NULL
         ) RETURNING id`,
        [emp.id, emp.manager_id || null]
      );
      leaveId = ins.rows[0].id;
      console.log('Created approved Sick leave:', leaveId);
    } else {
      await client.query(
        `UPDATE leave_requests SET
           leave_type = 'Sick',
           from_date = '2026-07-14',
           to_date = '2026-07-14',
           days = 1,
           reason = 'Sick leave (Day Off)',
           status = 'Approved',
           decided_at = COALESCE(decided_at, now()),
           decision_token = NULL
         WHERE id = $1`,
        [leaveId]
      );
      console.log('Updated existing leave to Approved Sick:', leaveId);
    }

    // Deduct sick balance once if not already deducted for this leave.
    // Simple approach: always deduct 1 if this insert path; for update, only if
    // previous status wasn't Approved.
    const prevStatus = existingLeave.rows[0] ? existingLeave.rows[0].status : null;
    if (prevStatus !== 'Approved') {
      const { rows } = await client.query(
        `SELECT sick FROM leave_balances WHERE employee_id = $1 FOR UPDATE`,
        [emp.id]
      );
      if (!rows[0] || Number(rows[0].sick) < 1) {
        throw new Error('Insufficient sick balance');
      }
      await client.query(
        `UPDATE leave_balances SET sick = sick - 1 WHERE employee_id = $1`,
        [emp.id]
      );
      console.log('Deducted 1 sick day from balance');
    }

    // Mark attendance for 14 Jul as On Leave (no check-in/out).
    await client.query(
      `INSERT INTO attendance_punches (
         employee_id, date, status, is_late, late_by_minutes,
         check_in_time, check_out_time, worked_hours, worked_minutes, overtime_hours
       ) VALUES ($1, '2026-07-14', 'On Leave', false, 0, NULL, NULL, NULL, NULL, NULL)
       ON CONFLICT (employee_id, date) DO UPDATE SET
         status = 'On Leave',
         is_late = false,
         late_by_minutes = 0,
         check_in_time = NULL,
         check_out_time = NULL,
         worked_hours = NULL,
         worked_minutes = NULL,
         overtime_hours = NULL`,
      [emp.id]
    );
    console.log('Attendance 2026-07-14 set to On Leave');
  });

  const leave = await query(`SELECT * FROM leave_requests WHERE id = $1`, [leaveId]);
  const bal = await query(`SELECT annual, sick, casual FROM leave_balances WHERE employee_id = $1`, [
    emp.id,
  ]);
  const punch = await query(
    `SELECT date, status, check_in_time, check_out_time
     FROM attendance_punches WHERE employee_id = $1 AND date = '2026-07-14'`,
    [emp.id]
  );

  console.log('\nLeave record:', leave.rows[0]);
  console.log('Balance:', bal.rows[0]);
  console.log('Punch:', punch.rows[0]);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
