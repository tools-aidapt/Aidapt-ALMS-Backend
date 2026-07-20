'use strict';

const { makeModel } = require('./_base');

const RegularizationRequest = makeModel({
  table: 'regularization_requests',
  createdColumn: 'applied_at',
  columns: {
    Employee: { col: 'employee_id', link: true },
    Date: { col: 'date' },
    RequestedCheckInTime: { col: 'requested_check_in_time' },
    RequestedCheckOutTime: { col: 'requested_check_out_time' },
    Reason: { col: 'reason' },
    Status: { col: 'status' },
    Manager: { col: 'manager_id', link: true },
    Punch: { col: 'punch_id', link: true },
    AppliedAt: { col: 'applied_at' },
    DecidedAt: { col: 'decided_at' },
  },
});

/** Filtered list for the regularization list endpoint. */
RegularizationRequest.query = function query({ employeeId, managerId, status } = {}) {
  const where = [];
  const params = [];
  if (employeeId) where.push(`employee_id = $${params.push(employeeId)}`);
  if (managerId) where.push(`manager_id = $${params.push(managerId)}`);
  if (status) where.push(`status = $${params.push(status)}`);
  return this.selectWhere(where.join(' AND '), params, 'ORDER BY applied_at DESC');
};

/** A still-open request for the same employee+date, or null (dedupe guard). */
RegularizationRequest.findPendingForDate = async function findPendingForDate(employeeId, dateStr) {
  const rows = await this.selectWhere(
    "employee_id = $1 AND date = $2 AND status = 'Pending'",
    [employeeId, dateStr],
    'LIMIT 1'
  );
  return rows[0] || null;
};

module.exports = RegularizationRequest;
