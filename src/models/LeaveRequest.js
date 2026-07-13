'use strict';

const { makeModel } = require('./_base');

const LeaveRequest = makeModel({
  table: 'leave_requests',
  columns: {
    Employee: { col: 'employee_id', link: true },
    LeaveType: { col: 'leave_type' },
    FromDate: { col: 'from_date' },
    ToDate: { col: 'to_date' },
    Days: { col: 'days' },
    Reason: { col: 'reason' },
    Status: { col: 'status' },
    Manager: { col: 'manager_id', link: true },
    AppliedAt: { col: 'applied_at' },
    DecidedAt: { col: 'decided_at' },
    DecisionToken: { col: 'decision_token' },
  },
});

/** Find a leave request carrying a specific (single-use) decision token. */
LeaveRequest.findByDecisionToken = async function findByDecisionToken(token) {
  const rows = await this.selectWhere('decision_token = $1', [token], 'LIMIT 1');
  return rows[0] || null;
};

/** Filtered list for the leave list endpoint. */
LeaveRequest.query = function query({ employeeId, status } = {}) {
  const where = [];
  const params = [];
  if (employeeId) where.push(`employee_id = $${params.push(employeeId)}`);
  if (status) where.push(`status = $${params.push(status)}`);
  return this.selectWhere(where.join(' AND '), params, 'ORDER BY applied_at DESC');
};

module.exports = LeaveRequest;
