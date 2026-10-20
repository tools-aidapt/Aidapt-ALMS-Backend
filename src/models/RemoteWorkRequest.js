'use strict';

const { makeModel } = require('./_base');

const RemoteWorkRequest = makeModel({
  table: 'remote_work_requests',
  createdColumn: 'applied_at',
  columns: {
    Employee: { col: 'employee_id', link: true },
    FromDate: { col: 'from_date' },
    ToDate: { col: 'to_date' },
    Days: { col: 'days' },
    Reason: { col: 'reason' },
    Status: { col: 'status' },
    Manager: { col: 'manager_id', link: true },
    AppliedAt: { col: 'applied_at' },
    DecidedAt: { col: 'decided_at' },
    DecidedBy: { col: 'decided_by', link: true },
    DecisionToken: { col: 'decision_token' },
  },
});

/** Find a request carrying a specific (single-use) decision token. */
RemoteWorkRequest.findByDecisionToken = async function findByDecisionToken(token) {
  const rows = await this.selectWhere('decision_token = $1', [token], 'LIMIT 1');
  return rows[0] || null;
};

/** Filtered list for the remote-work list and approver-queue endpoints. */
RemoteWorkRequest.query = function query({
  employeeId,
  managerId,
  status,
  excludeEmployeeId,
} = {}) {
  const where = [];
  const params = [];
  if (employeeId) where.push(`employee_id = $${params.push(employeeId)}`);
  if (managerId) where.push(`manager_id = $${params.push(managerId)}`);
  if (status) where.push(`status = $${params.push(status)}`);
  if (excludeEmployeeId) {
    where.push(`employee_id <> $${params.push(excludeEmployeeId)}`);
  }
  return this.selectWhere(where.join(' AND '), params, 'ORDER BY applied_at DESC');
};

/**
 * Pending or Approved request whose range overlaps [fromDate, toDate].
 * Rejected requests do not block a new application.
 */
RemoteWorkRequest.findOpenOverlap = async function findOpenOverlap(
  employeeId,
  fromDate,
  toDate,
  excludeId
) {
  const where = [
    'employee_id = $1',
    "status IN ('Pending', 'Approved')",
    'from_date <= $3',
    'to_date >= $2',
  ];
  const params = [employeeId, fromDate, toDate];
  if (excludeId) where.push(`id <> $${params.push(excludeId)}`);
  const rows = await this.selectWhere(where.join(' AND '), params, 'LIMIT 1');
  return rows[0] || null;
};

/** True when an Approved request covers this calendar date. */
RemoteWorkRequest.isApprovedOnDate = async function isApprovedOnDate(employeeId, dateStr) {
  const rows = await this.selectWhere(
    "employee_id = $1 AND status = 'Approved' AND from_date <= $2 AND to_date >= $2",
    [employeeId, dateStr],
    'LIMIT 1'
  );
  return Boolean(rows[0]);
};

module.exports = RemoteWorkRequest;
