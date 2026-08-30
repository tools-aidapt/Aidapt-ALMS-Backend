'use strict';

/**
 * One-off: mark Syed Muhammad Irtaza On Leave for 2026-08-17
 * and deduct 1 day from Casual leave balance.
 * Run: node scripts/mark-irtaza-aug17-casual.js
 */

require('dotenv').config();
const { query, pool, withTransaction } = require('../src/config/db');
const strikeService = require('../src/services/strikeService');

const LEAVE_DATE = '2026-08-17';

async function main() {
  const empRes = await query(
    `SELECT id, name, manager_id, email
     FROM employees
     WHERE name ILIKE '%Syed%Muhammad%Irtaza%'
        OR name ILIKE '%Muhammad Irtaza%'
        OR (name ILIKE '%Irtaza%' AND email ILIKE '%irtaza%')
     ORDER BY CASE
       WHEN name ILIKE '%Syed%Muhammad%Irtaza%' THEN 0
       WHEN name ILIKE '%Muhammad Irtaza%' THEN 1
       ELSE 2
     END
     LIMIT 1`
  );
  const emp = empRes.rows[0];
  if (!emp) throw new Error('Syed Muhammad Irtaza not found');
  console.log('Employee:', emp.name, emp.email, emp.id);

  const balRes = await query(`SELECT * FROM leave_balances WHERE employee_id = $1`, [emp.id]);
  let balance = balRes.rows[0];
  if (!balance) {
    throw new Error('No leave_balances row for Irtaza — create balance before deducting Casual');
  }
  console.log('Current balance:', {
    annual: balance.annual,
    sick: balance.sick,
    casual: balance.casual,
  });

  if (Number(balance.casual) < 1) {
    throw new Error(`Insufficient Casual balance (${balance.casual})`);
  }

  const existingLeave = await query(
    `SELECT id, leave_type, status, days, from_date, to_date
     FROM leave_requests
     WHERE employee_id = $1
       AND from_date <= $2
       AND to_date >= $2`,
    [emp.id, LEAVE_DATE]
  );
  if (existingLeave.rows.length) {
    console.log('Existing leave covering date:', existingLeave.rows);
  }

  let leaveId = existingLeave.rows[0] && existingLeave.rows[0].id;
  const prevStatus = existingLeave.rows[0] ? existingLeave.rows[0].status : null;

  await withTransaction(async (client) => {
    if (!leaveId) {
      const ins = await client.query(
        `INSERT INTO leave_requests (
           employee_id, leave_type, from_date, to_date, days, reason,
           status, manager_id, applied_at, decided_at, decision_token
         ) VALUES (
           $1, 'Casual', $2, $2, 1,
           'Casual leave',
           'Approved', $3, now(), now(), NULL
         ) RETURNING id`,
        [emp.id, LEAVE_DATE, emp.manager_id || null]
      );
      leaveId = ins.rows[0].id;
      console.log('Created approved Casual leave:', leaveId);
    } else {
      await client.query(
        `UPDATE leave_requests SET
           leave_type = 'Casual',
           from_date = $2,
           to_date = $2,
           days = 1,
           reason = COALESCE(NULLIF(reason, ''), 'Casual leave'),
           status = 'Approved',
           decided_at = COALESCE(decided_at, now()),
           decision_token = NULL
         WHERE id = $1`,
        [leaveId, LEAVE_DATE]
      );
      console.log('Updated existing leave to Approved Casual:', leaveId);
    }

    if (prevStatus !== 'Approved') {
      const { rows } = await client.query(
        `SELECT casual FROM leave_balances WHERE employee_id = $1 FOR UPDATE`,
        [emp.id]
      );
      if (!rows[0] || Number(rows[0].casual) < 1) {
        throw new Error('Insufficient Casual balance');
      }
      await client.query(
        `UPDATE leave_balances SET casual = casual - 1 WHERE employee_id = $1`,
        [emp.id]
      );
      console.log('Deducted 1 Casual day from balance');
    } else {
      console.log('Leave already Approved — skipped Casual deduction');
    }

    await client.query(
      `INSERT INTO attendance_punches (
         employee_id, date, status, is_late, late_by_minutes,
         check_in_time, check_out_time, worked_hours, worked_minutes, overtime_hours
       ) VALUES ($1, $2, 'On Leave', false, 0, NULL, NULL, NULL, NULL, NULL)
       ON CONFLICT (employee_id, date) DO UPDATE SET
         status = 'On Leave',
         is_late = false,
         late_by_minutes = 0,
         check_in_time = NULL,
         check_out_time = NULL,
         worked_hours = NULL,
         worked_minutes = NULL,
         overtime_hours = NULL`,
      [emp.id, LEAVE_DATE]
    );
    console.log(`Attendance ${LEAVE_DATE} set to On Leave`);
  });

  await strikeService.recomputeForEmployeeMonth(emp.id, LEAVE_DATE);

  const leave = await query(`SELECT * FROM leave_requests WHERE id = $1`, [leaveId]);
  const bal = await query(`SELECT annual, sick, casual FROM leave_balances WHERE employee_id = $1`, [
    emp.id,
  ]);
  const punch = await query(
    `SELECT date, status, check_in_time, check_out_time, is_late
     FROM attendance_punches WHERE employee_id = $1 AND date = $2`,
    [emp.id, LEAVE_DATE]
  );

  console.log(
    JSON.stringify(
      {
        employee: emp.name,
        leave: {
          id: leave.rows[0].id,
          type: leave.rows[0].leave_type,
          from: leave.rows[0].from_date,
          to: leave.rows[0].to_date,
          days: leave.rows[0].days,
          status: leave.rows[0].status,
        },
        balance: bal.rows[0],
        punch: punch.rows[0],
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
