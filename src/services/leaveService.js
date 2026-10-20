'use strict';

const LeaveRequest = require('../models/LeaveRequest');
const LeaveBalance = require('../models/LeaveBalance');
const Employee = require('../models/Employee');
const Shift = require('../models/Shift');
const { withTransaction } = require('../config/db');
const env = require('../config/env');
const holidayService = require('./holidayService');
const emailService = require('./emailService');
const { generateDecisionToken, safeEquals } = require('../utils/tokenGenerator');
const { nowUtcIso, dateRangeInclusive, dowForDateStr } = require('../utils/dateUtils');
const {
  AppError,
  badRequest,
  conflict,
  notFound,
  forbidden,
} = require('../middleware/errorHandler');

const LEAVE_TYPES = ['Annual', 'Sick', 'Casual'];
const DEFAULT_WORKING_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const STATUS = {
  PENDING: 'Pending',
  MANAGER_APPROVED: 'Manager Approved',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

function serialize(rec) {
  const f = rec.fields;
  const employee = f.Employee || [];
  return {
    id: rec.id,
    employee,
    // Scalar owner id — same defence-in-depth shape as regularizations.
    employeeId: employee[0] || null,
    leaveType: f.LeaveType || null,
    fromDate: f.FromDate || null,
    toDate: f.ToDate || null,
    days: f.Days ?? null,
    reason: f.Reason || null,
    status: f.Status || null,
    approvalStage: approvalStage(f.Status),
    manager: f.Manager || [],
    finalApprover: f.FinalApprover || [],
    appliedAt: f.AppliedAt || null,
    managerApprovedAt: f.ManagerApprovedAt || null,
    managerApprovedBy: f.ManagerApprovedBy || [],
    decidedAt: f.DecidedAt || null,
    decidedBy: f.DecidedBy || [],
    // DecisionToken deliberately omitted from API output.
  };
}

/** Whose action the request is waiting on. Null once it is fully decided. */
function approvalStage(status) {
  if (status === STATUS.PENDING) return 'manager';
  if (status === STATUS.MANAGER_APPROVED) return 'final';
  return null;
}

/** Batch-fetch { id -> { name, photoUrl } } for a set of employee ids. */
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

/**
 * Attach the employee's, manager's, and decider's name + photoUrl to serialized
 * leave records. Batches the lookups so a list of N requests costs one query.
 */
async function attachPeople(items) {
  const ids = [];
  for (const it of items) {
    ids.push(
      (it.employee || [])[0],
      (it.manager || [])[0],
      (it.finalApprover || [])[0],
      (it.managerApprovedBy || [])[0],
      (it.decidedBy || [])[0]
    );
  }
  const people = await peopleMap(ids);
  return items.map((it) => {
    const emp = people.get((it.employee || [])[0]);
    const mgr = people.get((it.manager || [])[0]);
    const finalApprover = people.get((it.finalApprover || [])[0]);
    const managerApprover = people.get((it.managerApprovedBy || [])[0]);
    const decider = people.get((it.decidedBy || [])[0]);
    return {
      ...it,
      employeeName: emp ? emp.name : null,
      employeePhotoUrl: emp ? emp.photoUrl : null,
      managerName: mgr ? mgr.name : null,
      managerPhotoUrl: mgr ? mgr.photoUrl : null,
      finalApproverName: finalApprover ? finalApprover.name : null,
      finalApproverPhotoUrl: finalApprover ? finalApprover.photoUrl : null,
      managerApprovedByName: managerApprover ? managerApprover.name : null,
      decidedByName: decider ? decider.name : null,
      decidedByPhotoUrl: decider ? decider.photoUrl : null,
    };
  });
}

/** Enrich a single serialized leave record with people info. */
async function withPeople(serialized) {
  const [one] = await attachPeople([serialized]);
  return one;
}

/** Working-day set for an employee, from their assigned shift (fallback Mon–Fri). */
async function workingDaysFor(employee) {
  const shiftId = (employee.fields.AssignedShift || [])[0];
  if (!shiftId) return new Set(DEFAULT_WORKING_DAYS);
  const shift = await Shift.get(shiftId);
  const days = shift && shift.fields.WorkingDays;
  return new Set(days && days.length ? days : DEFAULT_WORKING_DAYS);
}

/**
 * Count leave days between fromDate and toDate inclusive, excluding non-working
 * weekdays (per shift) and holidays. Pure once the inputs are gathered.
 */
async function computeLeaveDays(employee, fromDate, toDate) {
  const dates = dateRangeInclusive(fromDate, toDate);
  if (!dates.length) throw badRequest('toDate must be on or after fromDate');
  const working = await workingDaysFor(employee);
  const holidays = await holidayService.holidayDateSet(fromDate, toDate);
  let count = 0;
  for (const d of dates) {
    if (!working.has(dowForDateStr(d))) continue; // weekend / non-working day
    if (holidays.has(d)) continue; // public holiday
    count += 1;
  }
  return count;
}

/** The person who gives final approval after the manager (Hitesh). */
async function resolveFinalApprover() {
  const email = String(env.leave.finalApproverEmail || '').trim();
  if (!email) {
    throw new AppError(503, 'NO_FINAL_APPROVER', 'Final leave approver is not configured.');
  }
  const rows = await Employee.selectWhere('lower(email) = lower($1)', [email], 'LIMIT 1');
  const approver = rows[0];
  if (!approver || approver.fields.Status === 'Inactive') {
    throw new AppError(
      503,
      'NO_FINAL_APPROVER',
      'Final leave approver is not available. Contact an administrator.'
    );
  }
  return approver;
}

/**
 * Email the person who must act on this stage. Non-fatal: the request stands
 * even if the webhook fails, and they can still decide in the app.
 */
async function emailStageApprover({ stage, approver, employee, request, token, finalApprover, manager }) {
  if (!approver || !approver.fields.Email) {
    // eslint-disable-next-line no-console
    console.warn(
      `[leave] ${stage} approval email skipped for request ${request.id}: approver has no Email`
    );
    return;
  }
  // eslint-disable-next-line no-console
  console.log(
    `[leave] ${stage} approval email for request ${request.id} to ${approver.id} <${approver.fields.Email}>`
  );
  await emailService.sendLeaveApprovalRequest({
    approverEmail: approver.fields.Email,
    approverName: approver.fields.Name,
    managerEmail: approver.fields.Email,
    managerName: manager ? manager.fields.Name : null,
    finalApproverName: finalApprover ? finalApprover.fields.Name : null,
    stage,
    employeeName: employee ? employee.fields.Name : 'Employee',
    employeeEmail: employee ? employee.fields.Email : null,
    request,
    token,
  });
}

async function emailStageApproverSafe(args) {
  try {
    await emailStageApprover(args);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[leave] ${args.stage} approval email failed:`, err.message);
  }
}

/**
 * Submit a leave request. Computes Days, stores a single-use decision token,
 * and emails only the employee's manager. Hitesh is emailed after that
 * manager approves.
 */
async function submit(employeeId, { leaveType, fromDate, toDate, reason }) {
  if (!LEAVE_TYPES.includes(leaveType)) {
    throw badRequest(`leaveType must be one of ${LEAVE_TYPES.join(', ')}`);
  }
  const employee = await Employee.get(employeeId);
  if (!employee) throw notFound('Employee not found');

  const days = await computeLeaveDays(employee, fromDate, toDate);
  if (days <= 0) {
    throw badRequest('Requested range contains no working days', 'NO_WORKING_DAYS');
  }

  const managerId = (employee.fields.Manager || [])[0] || null;
  if (!managerId) {
    throw badRequest(
      'A manager must be assigned before you can apply for leave. Your manager approves first, then it goes to Hitesh for final approval.',
      'NO_MANAGER'
    );
  }

  const finalApprover = await resolveFinalApprover();
  const token = generateDecisionToken();
  const rec = await LeaveRequest.create({
    Employee: [employeeId],
    LeaveType: leaveType,
    FromDate: fromDate,
    ToDate: toDate,
    Days: days,
    Reason: reason || '',
    Status: STATUS.PENDING,
    Manager: [managerId],
    FinalApprover: [finalApprover.id],
    AppliedAt: nowUtcIso(),
    DecisionToken: token,
  });

  const manager = await Employee.get(managerId);
  await emailStageApproverSafe({
    stage: 'manager',
    approver: manager,
    employee,
    request: rec,
    token,
    finalApprover,
    manager,
  });

  return withPeople(serialize(rec));
}

// Whitelist of leave-type -> balance column, so it can be interpolated safely.
const BALANCE_COLUMN = { Annual: 'annual', Sick: 'sick', Casual: 'casual' };

async function lockLeaveStatus(client, requestId) {
  const { rows } = await client.query(
    `SELECT status FROM leave_requests WHERE id = $1 FOR UPDATE`,
    [requestId]
  );
  if (!rows[0]) throw notFound('Leave request not found');
  return rows[0].status;
}

async function notifyEmployee(request, decision, stage) {
  const employeeId = (request.fields.Employee || [])[0];
  try {
    const employee = employeeId ? await Employee.get(employeeId) : null;
    if (employee && employee.fields.Email) {
      await emailService.sendLeaveDecisionNotice({
        employeeEmail: employee.fields.Email,
        employeeName: employee.fields.Name,
        request,
        decision,
        stage,
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[leave] decision notice failed:', err.message);
  }
}

/**
 * Manager approved. Move the request to Hitesh and email him a fresh token.
 * Balance is not touched yet. If the applicant is Hitesh, the manager's
 * approval is final — he cannot be asked to approve his own leave.
 */
async function grantManagerApproval(request, managerId) {
  const employeeId = (request.fields.Employee || [])[0];
  const finalApprover = await resolveFinalApprover();

  if (finalApprover.id === employeeId) {
    return grantFinalApproval(request, managerId, { allowPending: true });
  }

  const token = generateDecisionToken();
  const manager = managerId ? await Employee.get(managerId) : null;
  const updated = await withTransaction(async (client) => {
    const status = await lockLeaveStatus(client, request.id);
    if (status !== STATUS.PENDING) {
      throw conflict(`Request already ${status}`, 'ALREADY_DECIDED');
    }
    return LeaveRequest.update(
      request.id,
      {
        Status: STATUS.MANAGER_APPROVED,
        ManagerApprovedAt: nowUtcIso(),
        ManagerApprovedBy: managerId ? [managerId] : [],
        FinalApprover: [finalApprover.id],
        DecisionToken: token,
      },
      client
    );
  });

  const employee = employeeId ? await Employee.get(employeeId) : null;
  await emailStageApproverSafe({
    stage: 'final',
    approver: finalApprover,
    employee,
    request: updated,
    token,
    finalApprover,
    manager,
  });

  return withPeople(serialize(updated));
}

/**
 * Final approval. Deducts balance and marks the request Approved.
 * Atomic with a row lock so a double-click cannot deduct twice.
 * @param {{ allowPending?: boolean }} [opts] true only when the applicant is
 *   the final approver, so the manager's yes closes the request.
 */
async function grantFinalApproval(request, decidedById, { allowPending = false } = {}) {
  const employeeId = (request.fields.Employee || [])[0];
  const col = BALANCE_COLUMN[request.fields.LeaveType];
  if (!col) throw conflict('Unknown leave type', 'BAD_LEAVE_TYPE');
  const days = request.fields.Days;

  await withTransaction(async (client) => {
    const status = await lockLeaveStatus(client, request.id);
    const open =
      status === STATUS.MANAGER_APPROVED || (allowPending && status === STATUS.PENDING);
    if (!open) {
      throw conflict(
        status === STATUS.PENDING
          ? 'Manager approval is required before final approval'
          : `Request already ${status}`,
        status === STATUS.PENDING ? 'MANAGER_APPROVAL_REQUIRED' : 'ALREADY_DECIDED'
      );
    }

    const { rows } = await client.query(
      `SELECT ${col} AS bal FROM leave_balances WHERE employee_id = $1 FOR UPDATE`,
      [employeeId]
    );
    if (!rows[0]) throw conflict('No leave balance record for employee', 'NO_BALANCE');
    const current = Number(rows[0].bal);
    if (current < days) {
      throw conflict(
        `Insufficient ${request.fields.LeaveType} balance: have ${current}, need ${days}`,
        'INSUFFICIENT_BALANCE'
      );
    }
    await client.query(
      `UPDATE leave_balances SET ${col} = ${col} - $1 WHERE employee_id = $2`,
      [days, employeeId]
    );
    await client.query(
      `UPDATE leave_requests
         SET status = $1, decided_at = now(), decided_by = $2, decision_token = NULL
       WHERE id = $3`,
      [STATUS.APPROVED, decidedById, request.id]
    );
  });

  const updated = await LeaveRequest.get(request.id);
  await notifyEmployee(updated, STATUS.APPROVED, 'final');
  return withPeople(serialize(updated));
}

/** Reject at either step. Does not change the leave balance. */
async function rejectLeave(request, decidedById) {
  const stage = request.fields.Status === STATUS.MANAGER_APPROVED ? 'final' : 'manager';
  await withTransaction(async (client) => {
    const status = await lockLeaveStatus(client, request.id);
    if (status !== STATUS.PENDING && status !== STATUS.MANAGER_APPROVED) {
      throw conflict(`Request already ${status}`, 'ALREADY_DECIDED');
    }
    await LeaveRequest.update(
      request.id,
      {
        Status: STATUS.REJECTED,
        DecidedAt: nowUtcIso(),
        DecidedBy: decidedById ? [decidedById] : [],
        DecisionToken: '',
      },
      client
    );
  });

  const updated = await LeaveRequest.get(request.id);
  await notifyEmployee(updated, STATUS.REJECTED, stage);
  return withPeople(serialize(updated));
}

/**
 * Who may act on the current stage. Pending belongs to the assigned manager.
 * Manager Approved belongs to the final approver. Nobody decides their own request.
 * @returns {'manager'|'final'}
 */
function assertStageActor(request, caller) {
  if ((request.fields.Employee || []).includes(caller.id)) {
    throw forbidden('You cannot decide your own leave request');
  }

  if (request.fields.Status === STATUS.PENDING) {
    const isAssignedManager = (request.fields.Manager || []).includes(caller.id);
    if (!isAssignedManager) {
      throw forbidden("This leave is waiting for the employee's manager");
    }
    return 'manager';
  }

  if (request.fields.Status === STATUS.MANAGER_APPROVED) {
    const finalId = (request.fields.FinalApprover || [])[0];
    if (caller.id !== finalId) {
      throw forbidden('This leave is waiting for final approval');
    }
    return 'final';
  }

  throw conflict(`Request already ${request.fields.Status}`, 'ALREADY_DECIDED');
}

/**
 * In-app approve/reject.
 * Pending → the assigned manager only.
 * Manager Approved → the final approver only.
 */
async function decideInApp(requestId, action, caller) {
  const request = await LeaveRequest.get(requestId);
  if (!request) throw notFound('Leave request not found');

  const stage = assertStageActor(request, caller);
  if (action === 'reject') return rejectLeave(request, caller.id);
  if (stage === 'manager') return grantManagerApproval(request, caller.id);
  return grantFinalApproval(request, caller.id);
}

/**
 * Email-link decision, gated by the single-use token for the current stage.
 * Approving at the manager stage rotates the token and emails the final approver.
 */
async function decideByToken(requestId, token, action) {
  if (!token) throw badRequest('Missing token', 'MISSING_TOKEN');
  if (!['approve', 'reject'].includes(action)) {
    throw badRequest("action must be 'approve' or 'reject'");
  }
  const request = await LeaveRequest.get(requestId);
  if (!request) throw notFound('Leave request not found');

  const status = request.fields.Status;
  if (status !== STATUS.PENDING && status !== STATUS.MANAGER_APPROVED) {
    throw conflict(`Request already ${status}`, 'ALREADY_DECIDED');
  }

  const stored = request.fields.DecisionToken;
  if (!stored || !safeEquals(stored, token)) {
    throw forbidden('Invalid or already-used token', 'TOKEN_INVALID');
  }

  const actorId =
    status === STATUS.PENDING
      ? (request.fields.Manager || [])[0] || null
      : (request.fields.FinalApprover || [])[0] || null;

  if (action === 'reject') return rejectLeave(request, actorId);
  if (status === STATUS.PENDING) return grantManagerApproval(request, actorId);
  return grantFinalApproval(request, actorId);
}

/**
 * Owner edits their own leave request. Allowed while it is still with the
 * manager, or after a rejection. Locked once the manager has approved (it is
 * with the final approver) or once it is fully approved.
 * Any edit returns the request to Pending, issues a new decision token, and
 * emails the manager again.
 */
async function updateRequest(requestId, employeeId, patch) {
  const request = await LeaveRequest.get(requestId);
  if (!request) throw notFound('Leave request not found');

  if (!(request.fields.Employee || []).includes(employeeId)) {
    throw forbidden('You can only edit your own leave requests');
  }
  if (request.fields.Status === STATUS.APPROVED) {
    throw conflict('An approved leave request cannot be edited', 'ALREADY_APPROVED');
  }
  if (request.fields.Status === STATUS.MANAGER_APPROVED) {
    throw conflict(
      'This leave is with the final approver and can no longer be edited',
      'AWAITING_FINAL_APPROVAL'
    );
  }

  const leaveType = patch.leaveType ?? request.fields.LeaveType;
  const fromDate = patch.fromDate ?? request.fields.FromDate;
  const toDate = patch.toDate ?? request.fields.ToDate;
  const reason = patch.reason ?? request.fields.Reason ?? '';

  if (!LEAVE_TYPES.includes(leaveType)) {
    throw badRequest(`leaveType must be one of ${LEAVE_TYPES.join(', ')}`);
  }

  const employee = await Employee.get(employeeId);
  if (!employee) throw notFound('Employee not found');

  const days = await computeLeaveDays(employee, fromDate, toDate);
  if (days <= 0) {
    throw badRequest('Requested range contains no working days', 'NO_WORKING_DAYS');
  }

  const managerId = (employee.fields.Manager || [])[0] || (request.fields.Manager || [])[0] || null;
  if (!managerId) {
    throw badRequest(
      'A manager must be assigned before you can apply for leave. Your manager approves first, then it goes to Hitesh for final approval.',
      'NO_MANAGER'
    );
  }
  const finalApprover = await resolveFinalApprover();
  const token = generateDecisionToken();
  await LeaveRequest.update(requestId, {
    LeaveType: leaveType,
    FromDate: fromDate,
    ToDate: toDate,
    Days: days,
    Reason: reason,
    Status: STATUS.PENDING,
    Manager: [managerId],
    FinalApprover: [finalApprover.id],
    ManagerApprovedAt: null,
    ManagerApprovedBy: [],
    DecidedAt: null,
    DecidedBy: [],
    DecisionToken: token,
  });

  const updated = await LeaveRequest.get(requestId);
  const manager = await Employee.get(managerId);
  await emailStageApproverSafe({
    stage: 'manager',
    approver: manager,
    employee,
    request: updated,
    token,
    finalApprover,
    manager,
  });

  return withPeople(serialize(updated));
}

/**
 * Owner deletes their own leave request. Allowed only while the request has NOT
 * been approved.
 */
async function deleteRequest(requestId, employeeId) {
  const request = await LeaveRequest.get(requestId);
  if (!request) throw notFound('Leave request not found');

  if (!(request.fields.Employee || []).includes(employeeId)) {
    throw forbidden('You can only delete your own leave requests');
  }
  if (request.fields.Status === STATUS.APPROVED) {
    throw conflict('An approved leave request cannot be deleted', 'ALREADY_APPROVED');
  }
  if (request.fields.Status === STATUS.MANAGER_APPROVED) {
    throw conflict(
      'This leave is with the final approver and can no longer be deleted',
      'AWAITING_FINAL_APPROVAL'
    );
  }

  await LeaveRequest.remove(requestId);
  return { id: requestId, deleted: true };
}

async function list({
  employeeId,
  managerId,
  finalApproverId,
  approverId,
  status,
  excludeEmployeeId,
} = {}) {
  const rows = await LeaveRequest.query({
    employeeId,
    managerId,
    finalApproverId,
    approverId,
    status,
    excludeEmployeeId,
  });
  return attachPeople(rows.map(serialize));
}

/**
 * Approver inbox. A manager sees their reports' requests that are still
 * waiting on them. The final approver sees requests the manager has already
 * approved. Never includes the caller's own submissions.
 */
async function listPendingForApprover(caller) {
  const { hasCompanyWideDataAccess } = require('../utils/leadershipAccess');
  const canQueue =
    caller.role === 'Manager' ||
    caller.role === 'HR Admin' ||
    hasCompanyWideDataAccess(caller);
  if (!canQueue) {
    throw forbidden('Employees do not have a leave approval queue');
  }
  return module.exports.list({
    approverId: caller.id,
    excludeEmployeeId: caller.id,
  });
}

async function getById(id) {
  const rec = await LeaveRequest.get(id);
  if (!rec) throw notFound('Leave request not found');
  return withPeople(serialize(rec));
}

function serializeBalance(balance) {
  return {
    id: balance.id,
    employee: balance.fields.Employee || [],
    annual: Number(balance.fields.Annual || 0),
    sick: Number(balance.fields.Sick || 0),
    casual: Number(balance.fields.Casual || 0),
    lastUpdated: balance.fields.LastUpdated || null,
  };
}

async function balancesFor(employeeId) {
  const balance = await LeaveBalance.findForEmployee(employeeId);
  if (!balance) throw notFound('No leave balance record for employee');
  return serializeBalance(balance);
}

/**
 * HR Admin sets an employee's leave balance (absolute values). Any of
 * annual/sick/casual may be provided; omitted ones are left unchanged. Creates
 * the balance row if the employee never had one. The last_updated trigger keeps
 * the timestamp fresh.
 */
async function setBalance(employeeId, patch) {
  const employee = await Employee.get(employeeId);
  if (!employee) throw notFound('Employee not found');

  const fields = {};
  if (patch.annual !== undefined) fields.Annual = patch.annual;
  if (patch.sick !== undefined) fields.Sick = patch.sick;
  if (patch.casual !== undefined) fields.Casual = patch.casual;
  if (!Object.keys(fields).length) {
    throw badRequest('Provide at least one of annual, sick, casual');
  }

  const existing = await LeaveBalance.findForEmployee(employeeId);
  const balance = existing
    ? await LeaveBalance.update(existing.id, fields)
    : await LeaveBalance.create({ Employee: [employeeId], Annual: 0, Sick: 0, Casual: 0, ...fields });

  return serializeBalance(balance);
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
  balancesFor,
  setBalance,
  computeLeaveDays,
  serialize,
  LEAVE_TYPES,
};
