'use strict';

/**
 * Remove Syed Muhammad Irtaza's test sick leave for this week
 * (21–22 Oct 2026) and restore sick balance deducted on approval.
 * Run: node scripts/remove-irtaza-week-test-leave.js
 */

require('dotenv').config();
const { pool, withTransaction } = require('../src/config/db');

const IDS = [
  'daf9f6a7-1ddb-4ebc-a42c-149089752a02', // 21 Oct Approved
  '944f33b6-6ca1-4bbd-bbd6-4c04c22c66cc', // 22 Oct Rejected
  'b955f166-a080-49a6-9c82-ef8ad18b9d90', // 22 Oct Approved
];

async function main() {
  const result = await withTransaction(async (client) => {
    const emp = (
      await client.query(
        `SELECT id, name FROM employees WHERE name ILIKE '%Irtaza%' LIMIT 1`
      )
    ).rows[0];
    if (!emp) throw new Error('Irtaza not found');

    const beforeBal = (
      await client.query(
        `SELECT annual, sick, casual FROM leave_balances WHERE employee_id = $1 FOR UPDATE`,
        [emp.id]
      )
    ).rows[0];

    const leaves = (
      await client.query(
        `SELECT id, leave_type, from_date::text, to_date::text, days, status, reason
         FROM leave_requests
         WHERE employee_id = $1 AND id = ANY($2::uuid[])
         ORDER BY from_date, applied_at`,
        [emp.id, IDS]
      )
    ).rows;

    if (leaves.length !== IDS.length) {
      throw new Error(`Expected ${IDS.length} leave rows, found ${leaves.length}`);
    }

    const restoreSick = leaves
      .filter((row) => row.status === 'Approved' && row.leave_type === 'Sick')
      .reduce((sum, row) => sum + Number(row.days), 0);

    await client.query(`DELETE FROM leave_requests WHERE id = ANY($1::uuid[])`, [IDS]);

    if (restoreSick > 0) {
      await client.query(
        `UPDATE leave_balances SET sick = sick + $1, last_updated = now() WHERE employee_id = $2`,
        [restoreSick, emp.id]
      );
    }

    const afterBal = (
      await client.query(
        `SELECT annual, sick, casual FROM leave_balances WHERE employee_id = $1`,
        [emp.id]
      )
    ).rows[0];

    return { employee: emp.name, removed: leaves, beforeBal, afterBal, restoreSick };
  });

  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
