'use strict';

const { makeModel } = require('./_base');
const { query } = require('../config/db');

const EmployeeMonthlyStrike = makeModel({
  table: 'employee_monthly_strikes',
  createdColumn: 'updated_at',
  columns: {
    Employee: { col: 'employee_id', link: true },
    YearMonth: { col: 'year_month' },
    LateCount: { col: 'late_count' },
    StrikeCount: { col: 'strike_count' },
    StrikeItems: { col: 'strike_items' },
    UpdatedAt: { col: 'updated_at' },
  },
});

/** One row for an employee in a calendar month (YYYY-MM), or null. */
EmployeeMonthlyStrike.findForEmployeeMonth = async function findForEmployeeMonth(
  employeeId,
  yearMonth
) {
  const rows = await this.selectWhere(
    'employee_id = $1 AND year_month = $2',
    [employeeId, yearMonth],
    'LIMIT 1'
  );
  return rows[0] || null;
};

/**
 * Insert or replace the monthly strike snapshot for one employee + month.
 * @returns {Promise<object>} the upserted record
 */
EmployeeMonthlyStrike.upsertForEmployeeMonth = async function upsertForEmployeeMonth({
  employeeId,
  yearMonth,
  lateCount,
  strikeCount,
  strikeItems,
}) {
  const { rows } = await query(
    `INSERT INTO employee_monthly_strikes
       (employee_id, year_month, late_count, strike_count, strike_items)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (employee_id, year_month) DO UPDATE SET
       late_count = EXCLUDED.late_count,
       strike_count = EXCLUDED.strike_count,
       strike_items = EXCLUDED.strike_items,
       updated_at = now()
     RETURNING *`,
    [employeeId, yearMonth, lateCount, strikeCount, JSON.stringify(strikeItems || [])]
  );
  return this.rowToRecord(rows[0]);
};

module.exports = EmployeeMonthlyStrike;
