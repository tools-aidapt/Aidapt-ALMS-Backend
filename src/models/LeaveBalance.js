'use strict';

const { makeModel } = require('./_base');

const LeaveBalance = makeModel({
  table: 'leave_balances',
  createdColumn: 'last_updated',
  columns: {
    Employee: { col: 'employee_id', link: true },
    Annual: { col: 'annual' },
    Sick: { col: 'sick' },
    Casual: { col: 'casual' },
    LastUpdated: { col: 'last_updated' },
  },
});

/** The balance row for one employee (or null). One row per employee. */
LeaveBalance.findForEmployee = async function findForEmployee(employeeId) {
  const rows = await this.selectWhere('employee_id = $1', [employeeId], 'LIMIT 1');
  return rows[0] || null;
};

module.exports = LeaveBalance;
