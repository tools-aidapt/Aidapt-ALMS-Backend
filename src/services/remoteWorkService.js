'use strict';

const RemoteWorkRequest = require('../models/RemoteWorkRequest');
const Employee = require('../models/Employee');
const { query } = require('../config/db');
const leaveService = require('./leaveService');
const strikeService = require('./strikeService');
const emailService = require('./emailService');
const { generateDecisionToken, safeEquals } = require('../utils/tokenGenerator');
const { nowUtcIso } = require('../utils/dateUtils');
const { badRequest, conflict, notFound, forbidden } = require('../middleware/errorHandler');

function asDateStr(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

function serialize(rec) {
  const f = rec.fields;
  const employee = f.Employee || [];
  return {
    id: rec.id,
    employee,
    employeeId: employee[0] || null,
    fromDate: asDateStr(f.FromDate),
    toDate: asDateStr(f.ToDate),
    days: f.Days ?? null,
    reason: f.Reason || null,
    status: f.Status || null,
    manager: f.Manager || [],
    appliedAt: f.AppliedAt || null,
    decidedAt: f.DecidedAt || null,
    decidedBy: f.DecidedBy || [],
  };
}

async function peopleMap(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const rows = await Employee.selectWhere('id = ANY($1)', [unique]);
  const map = new Map();
  for (const e of rows) {
    map.set(e.id, { name: e.fields.Name || null, photoUrl: e.fields.PhotoUrl || null });
  }
  return map;
}

async function attachPeople(items) {
  const ids = [];
  for (const it of items) {
    ids.push((it.employee || [])[0], (it.manager || [])[0], (it.decidedBy || [])[0]);
  }
  const people = await peopleMap(ids);
  return items.map((it) => {
    const emp = people.get((it.employee || [])[0]);
    const mgr = people.get((it.manager || [])[0]);
    const decider = people.get((it.decidedBy || [])[0]);
    return {
      ...it,
      employeeName: emp ? emp.name : null,
      employeePhotoUrl: emp ? emp.photoUrl : null,
      managerName: mgr ? mgr.name : null,
      managerPhotoUrl: mgr ? mgr.photoUrl : null,
      decidedByName: decider ? decider.name : null,
      decidedByPhotoUrl: decider ? decider.photoUrl : null,
    };
  });
}

async function withPeople(serialized) {
  const [one] = await attachPeople([serialized]);
  return one;
}

/** True when an Approved remote-work request covers `dateStr` for this employee. */
async function isApprovedForDate(employeeId, dateStr) {
  return RemoteWorkRequest.isApprovedOnDate(employeeId, dateStr);
}

/**
 * After approval, remote check-ins in the range that were stored as Absent
 * become Present. Days with no check-in stay absent — approval authorizes
 * remote attendance, it does not invent a punch.
 */
async function promoteApprovedRemotePunches(employeeId, fromDate, toDate) {
  const { rows } = await query(
    `UPDATE attendance_punches
        SET status = 'Present'
      WHERE employee_id = $1
        AND date >= $2::date
        AND date <= $3::date
        AND mode = 'Remote In'
        AND status = 'Absent'
        AND check_in_time IS NOT NULL
      RETURNING date`,
    [employeeId, fromDate, toDate]
  );
  const months = new Set(rows.map((r) => asDateStr(r.date).slice(0, 7)));
  for (const month of months) {
    await strikeService.recomputeForEmployeeMonth(employeeId, month);
  }
  return rows.length;
}

async function notifyManager(rec, employee, token) {
  const managerId = (rec.fields.Manager || [])[0] || null;
  if (!managerId) {
    // eslint-disable-next-line no-console
    console.warn(
      `[remote-work] approval email skipped for request ${rec.id}: employee has no assigned Manager`
    );
    return;
  }
  try {
    const manager = await Employee.get(managerId);
    if (manager && manager.fields.Email) {
      await emailService.sendRemoteWorkApprovalRequest({
        managerEmail: manager.fields.Email,
        employeeName: employee.fields.Name,
        employeeEmail: employee.fields.Email,
        request: rec,
        token,
      });
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `[remote-work] approval email skipped for request ${rec.id}: manager ${managerId} has no Email`
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[remote-work] approval email failed:', err.message);
  }
}

/**
 * Submit a remote-work request. Days follow the same working-day rules as leave
 * (shift weekdays minus holidays). The assigned manager is the approver.
 */
async function submit(employeeId, { fromDate, toDate, reason }) {
  const employee = await Employee.get(employeeId);
  if (!employee) throw notFound('Employee not found');

  const days = await leaveService.computeLeaveDays(employee, fromDate, toDate);
  if (days <= 0) {
    throw badRequest('Requested range contains no working days', 'NO_WORKING_DAYS');
  }

  const overlap = await RemoteWorkRequest.findOpenOverlap(employeeId, fromDate, toDate);
  if (overlap) {
    throw conflict(
      'A pending or approved remote work request already covers these dates',
      'OVERLAPPING_REQUEST'
    );
  }

  const managerId = (employee.fields.Manager || [])[0] || null;
  const token = generateDecisionToken();
  const fields = {
    Employee: [employeeId],
    FromDate: fromDate,
    ToDate: toDate,
    Days: days,
    Reason: reason || '',
    Status: 'Pending',
    AppliedAt: nowUtcIso(),
    DecisionToken: token,
  };
  if (managerId) fields.Manager = [managerId];

  const rec = await RemoteWorkRequest.create(fields);
  await notifyManager(rec, employee, token);
  return withPeople(serialize(rec));
}

async function applyDecision(request, decision, decidedById = null) {
  if (request.fields.Status !== 'Pending') {
    throw conflict(`Request already ${request.fields.Status}`, 'ALREADY_DECIDED');
  }
  const employeeId = (request.fields.Employee || [])[0];

  await RemoteWorkRequest.update(request.id, {
    Status: decision,
    DecidedAt: nowUtcIso(),
    DecidedBy: decidedById ? [decidedById] : [],
    DecisionToken: null,
  });

  if (decision === 'Approved' && employeeId) {
    await promoteApprovedRemotePunches(
      employeeId,
      asDateStr(request.fields.FromDate),
      asDateStr(request.fields.ToDate)
    );
  }

  const updated = await RemoteWorkRequest.get(request.id);

  try {
    const employee = employeeId ? await Employee.get(employeeId) : null;
    if (employee && employee.fields.Email) {
      await emailService.sendRemoteWorkDecisionNotice({
        employeeEmail: employee.fields.Email,
        employeeName: employee.fields.Name,
        request: updated,
        decision,
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[remote-work] decision notice failed:', err.message);
  }

  return withPeople(serialize(updated));
}

/**
 * In-app approve/reject. A Manager may only decide requests assigned to them;
 * HR Admin and leadership may decide any. Nobody may decide their own request.
 */
async function decideInApp(requestId, action, caller) {
  const request = await RemoteWorkRequest.get(requestId);
  if (!request) throw notFound('Remote work request not found');

  if ((request.fields.Employee || []).includes(caller.id)) {
    throw forbidden('You cannot decide your own remote work request');
  }

  const isHrAdmin = caller.role === 'HR Admin' || caller.isLeadership;
  const isAssignedManager = (request.fields.Manager || []).includes(caller.id);
  if (!isHrAdmin && !isAssignedManager) {
    throw forbidden('You are not the approver for this request');
  }

  const decision = action === 'approve' ? 'Approved' : 'Rejected';
  return applyDecision(request, decision, caller.id);
}

/** Email-link decision, gated by the single-use token. */
async function decideByToken(requestId, token, action) {
  if (!token) throw badRequest('Missing token', 'MISSING_TOKEN');
  if (!['approve', 'reject'].includes(action)) {
    throw badRequest("action must be 'approve' or 'reject'");
  }
  const request = await RemoteWorkRequest.get(requestId);
  if (!request) throw notFound('Remote work request not found');

  const stored = request.fields.DecisionToken;
  if (!stored || !safeEquals(stored, token)) {
    throw forbidden('Invalid or already-used token', 'TOKEN_INVALID');
  }

  const decision = action === 'approve' ? 'Approved' : 'Rejected';
  const decidedById = (request.fields.Manager || [])[0] || null;
  return applyDecision(request, decision, decidedById);
}

/**
 * Owner edits their own request while it has not been approved. The edit
 * returns it to Pending and re-issues the decision token.
 */
async function updateRequest(requestId, employeeId, patch) {
  const request = await RemoteWorkRequest.get(requestId);
  if (!request) throw notFound('Remote work request not found');

  if (!(request.fields.Employee || []).includes(employeeId)) {
    throw forbidden('You can only edit your own remote work requests');
  }
  if (request.fields.Status === 'Approved') {
    throw conflict('An approved remote work request cannot be edited', 'ALREADY_APPROVED');
  }

  const fromDate = patch.fromDate ?? asDateStr(request.fields.FromDate);
  const toDate = patch.toDate ?? asDateStr(request.fields.ToDate);
  const reason = patch.reason ?? request.fields.Reason ?? '';

  const employee = await Employee.get(employeeId);
  if (!employee) throw notFound('Employee not found');

  const days = await leaveService.computeLeaveDays(employee, fromDate, toDate);
  if (days <= 0) {
    throw badRequest('Requested range contains no working days', 'NO_WORKING_DAYS');
  }

  const overlap = await RemoteWorkRequest.findOpenOverlap(employeeId, fromDate, toDate, requestId);
  if (overlap) {
    throw conflict(
      'A pending or approved remote work request already covers these dates',
      'OVERLAPPING_REQUEST'
    );
  }

  const token = generateDecisionToken();
  await RemoteWorkRequest.update(requestId, {
    FromDate: fromDate,
    ToDate: toDate,
    Days: days,
    Reason: reason,
    Status: 'Pending',
    DecidedAt: null,
    DecidedBy: [],
    DecisionToken: token,
  });

  const updated = await RemoteWorkRequest.get(requestId);
  await notifyManager(updated, employee, token);
  return withPeople(serialize(updated));
}

/** Owner deletes their own request while it has not been approved. */
async function deleteRequest(requestId, employeeId) {
  const request = await RemoteWorkRequest.get(requestId);
  if (!request) throw notFound('Remote work request not found');

  if (!(request.fields.Employee || []).includes(employeeId)) {
    throw forbidden('You can only delete your own remote work requests');
  }
  if (request.fields.Status === 'Approved') {
    throw conflict('An approved remote work request cannot be deleted', 'ALREADY_APPROVED');
  }

  await RemoteWorkRequest.remove(requestId);
  return { id: requestId, deleted: true };
}

async function list({ employeeId, managerId, status, excludeEmployeeId } = {}) {
  const rows = await RemoteWorkRequest.query({
    employeeId,
    managerId,
    status,
    excludeEmployeeId,
  });
  return attachPeople(rows.map(serialize));
}

/**
 * Approver inbox: Pending requests for direct reports (Manager) or company-wide
 * (HR Admin / Leadership). Never includes the caller's own submissions.
 */
async function listPendingForApprover(caller) {
  const { hasCompanyWideDataAccess } = require('../utils/leadershipAccess');
  if (caller.role === 'Employee' && !hasCompanyWideDataAccess(caller)) {
    throw forbidden('Employees do not have a remote work approval queue');
  }
  if (
    !hasCompanyWideDataAccess(caller) &&
    caller.role !== 'Manager' &&
    caller.role !== 'HR Admin'
  ) {
    throw forbidden('Employees do not have a remote work approval queue');
  }
  const filters = {
    status: 'Pending',
    excludeEmployeeId: caller.id,
  };
  if (!hasCompanyWideDataAccess(caller) && caller.role === 'Manager') {
    filters.managerId = caller.id;
  }
  return module.exports.list(filters);
}

async function getById(id) {
  const rec = await RemoteWorkRequest.get(id);
  if (!rec) throw notFound('Remote work request not found');
  return withPeople(serialize(rec));
}

module.exports = {
  submit,
  updateRequest,
  deleteRequest,
  decideInApp,
  decideByToken,
  list,
  listPendingForApprover,
  getById,
  isApprovedForDate,
  serialize,
};
