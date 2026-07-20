'use strict';

const LeaveRequest = require('../models/LeaveRequest');
const LeaveBalance = require('../models/LeaveBalance');
const Employee = require('../models/Employee');
const Shift = require('../models/Shift');
const { withTransaction } = require('../config/db');
const holidayService = require('./holidayService');
const emailService = require('./emailService');
const { generateDecisionToken, safeEquals } = require('../utils/tokenGenerator');
const { nowUtcIso, dateRangeInclusive, dowForDateStr } = require('../utils/dateUtils');
const {
  badRequest,
  conflict,
  notFound,
  forbidden,
} = require('../middleware/errorHandler');

const LEAVE_TYPES = ['Annual', 'Sick', 'Casual'];
const DEFAULT_WORKING_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

function serialize(rec) {
  const f = rec.fields;
  return {
    id: rec.id,
    employee: f.Employee || [],
    leaveType: f.LeaveType || null,
    fromDate: f.FromDate || null,
    toDate: f.ToDate || null,
    days: f.Days ?? null,
    reason: f.Reason || null,
    status: f.Status || null,
    manager: f.Manager || [],
    appliedAt: f.AppliedAt || null,
    decidedAt: f.DecidedAt || null,
    // DecisionToken deliberately omitted from API output.
  };
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
 * Attach the employee's and manager's name + photoUrl to serialized leave
 * records. Batches the lookups so a list of N requests costs one query, not N.
 */
async function attachPeople(items) {
  const ids = [];
  for (const it of items) {
    ids.push((it.employee || [])[0], (it.manager || [])[0]);
  }
  const people = await peopleMap(ids);
  return items.map((it) => {
    const emp = people.get((it.employee || [])[0]);
    const mgr = people.get((it.manager || [])[0]);
    return {
      ...it,
      employeeName: emp ? emp.name : null,
      employeePhotoUrl: emp ? emp.photoUrl : null,
      managerName: mgr ? mgr.name : null,
      managerPhotoUrl: mgr ? mgr.photoUrl : null,
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

/**
 * Submit a leave request. Computes Days, copies the approver, stores a
 * single-use decision token, and emails the manager.
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
  const token = generateDecisionToken();

  const fields = {
    Employee: [employeeId],
    LeaveType: leaveType,
    FromDate: fromDate,
    ToDate: toDate,
    Days: days,
    Reason: reason || '',
    Status: 'Pending',
    AppliedAt: nowUtcIso(),
    DecisionToken: token,
  };
  if (managerId) fields.Manager = [managerId];

  const rec = await LeaveRequest.create(fields);

  // Fire off the approval email (non-fatal if it fails).
  if (managerId) {
    try {
      const manager = await Employee.get(managerId);
      if (manager && manager.fields.Email) {
        // eslint-disable-next-line no-console
        console.log(
          `[leave] submitting approval email for request ${rec.id} to manager ${managerId} <${manager.fields.Email}>`
        );
        await emailService.sendLeaveApprovalRequest({
          managerEmail: manager.fields.Email,
          employeeName: employee.fields.Name,
          employeeEmail: employee.fields.Email,
          request: rec,
          token,
        });
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          `[leave] approval email skipped for request ${rec.id}: manager ${managerId} has no Email on record`
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[leave] approval email failed:', err.message);
    }
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      `[leave] approval email skipped for request ${rec.id}: employee ${employeeId} has no assigned Manager`
    );
  }

  return withPeople(serialize(rec));
}

// Whitelist of leave-type -> balance column, so it can be interpolated safely.
const BALANCE_COLUMN = { Annual: 'annual', Sick: 'sick', Casual: 'casual' };

/**
 * Core decision transition, shared by in-app and email paths.
 *
 * Approval is atomic: balance check + deduction + status flip run in one
 * transaction with a row lock (SELECT ... FOR UPDATE), so a crash or a
 * concurrent approval can't double-deduct or half-apply.
 * @param {'Approved'|'Rejected'} decision
 */
async function applyDecision(request, decision) {
  if (request.fields.Status !== 'Pending') {
    throw conflict(`Request already ${request.fields.Status}`, 'ALREADY_DECIDED');
  }
  const employeeId = (request.fields.Employee || [])[0];

  if (decision === 'Approved') {
    const col = BALANCE_COLUMN[request.fields.LeaveType];
    if (!col) throw conflict('Unknown leave type', 'BAD_LEAVE_TYPE');
    const days = request.fields.Days;

    await withTransaction(async (client) => {
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
        `UPDATE leave_requests SET status = $1, decided_at = now(), decision_token = NULL WHERE id = $2`,
        ['Approved', request.id]
      );
    });
  } else {
    await LeaveRequest.update(request.id, {
      Status: decision,
      DecidedAt: nowUtcIso(),
      DecisionToken: '', // invalidate single-use token on rejection
    });
  }

  const updated = await LeaveRequest.get(request.id);

  // Notify the employee (non-fatal).
  try {
    const employee = employeeId ? await Employee.get(employeeId) : null;
    if (employee && employee.fields.Email) {
      await emailService.sendLeaveDecisionNotice({
        employeeEmail: employee.fields.Email,
        employeeName: employee.fields.Name,
        request: updated,
        decision,
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[leave] decision notice failed:', err.message);
  }

  return withPeople(serialize(updated));
}

/**
 * In-app approve/reject. The caller (Manager/HR Admin) is authorised here:
 * a Manager may only decide requests where they are the assigned approver;
 * HR Admin may decide any.
 */
async function decideInApp(requestId, action, caller) {
  const request = await LeaveRequest.get(requestId);
  if (!request) throw notFound('Leave request not found');

  const isHrAdmin = caller.role === 'HR Admin';
  const isAssignedManager = (request.fields.Manager || []).includes(caller.id);
  if (!isHrAdmin && !isAssignedManager) {
    throw forbidden('You are not the approver for this request');
  }

  const decision = action === 'approve' ? 'Approved' : 'Rejected';
  return applyDecision(request, decision);
}

/**
 * Email-link decision, gated purely by the single-use token.
 */
async function decideByToken(requestId, token, action) {
  if (!token) throw badRequest('Missing token', 'MISSING_TOKEN');
  if (!['approve', 'reject'].includes(action)) {
    throw badRequest("action must be 'approve' or 'reject'");
  }
  const request = await LeaveRequest.get(requestId);
  if (!request) throw notFound('Leave request not found');

  const stored = request.fields.DecisionToken;
  if (!stored || !safeEquals(stored, token)) {
    throw forbidden('Invalid or already-used token', 'TOKEN_INVALID');
  }

  const decision = action === 'approve' ? 'Approved' : 'Rejected';
  return applyDecision(request, decision);
}

/**
 * Owner edits their own leave request. Allowed only while the request has NOT
 * been approved (an approved request already deducted balance, so it's locked).
 * Any edit recomputes Days, returns the request to Pending, and re-issues the
 * single-use decision token — invalidating any approval link already emailed —
 * then re-sends the approval request to the manager.
 */
async function updateRequest(requestId, employeeId, patch) {
  const request = await LeaveRequest.get(requestId);
  if (!request) throw notFound('Leave request not found');

  if (!(request.fields.Employee || []).includes(employeeId)) {
    throw forbidden('You can only edit your own leave requests');
  }
  if (request.fields.Status === 'Approved') {
    throw conflict('An approved leave request cannot be edited', 'ALREADY_APPROVED');
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

  const token = generateDecisionToken();
  await LeaveRequest.update(requestId, {
    LeaveType: leaveType,
    FromDate: fromDate,
    ToDate: toDate,
    Days: days,
    Reason: reason,
    Status: 'Pending',
    DecidedAt: null,
    DecisionToken: token,
  });

  const updated = await LeaveRequest.get(requestId);

  // Re-send the approval email so the manager acts on the latest details.
  const managerId = (request.fields.Manager || [])[0] || null;
  if (managerId) {
    try {
      const manager = await Employee.get(managerId);
      if (manager && manager.fields.Email) {
        // eslint-disable-next-line no-console
        console.log(
          `[leave] re-sending approval email for edited request ${requestId} to manager ${managerId} <${manager.fields.Email}>`
        );
        await emailService.sendLeaveApprovalRequest({
          managerEmail: manager.fields.Email,
          employeeName: employee.fields.Name,
          employeeEmail: employee.fields.Email,
          request: updated,
          token,
        });
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          `[leave] approval email skipped for edited request ${requestId}: manager ${managerId} has no Email on record`
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[leave] approval email failed:', err.message);
    }
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      `[leave] approval email skipped for edited request ${requestId}: employee ${employeeId} has no assigned Manager`
    );
  }

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
  if (request.fields.Status === 'Approved') {
    throw conflict('An approved leave request cannot be deleted', 'ALREADY_APPROVED');
  }

  await LeaveRequest.remove(requestId);
  return { id: requestId, deleted: true };
}

async function list({ employeeId, status } = {}) {
  const rows = await LeaveRequest.query({ employeeId, status });
  return attachPeople(rows.map(serialize));
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
  getById,
  balancesFor,
  setBalance,
  computeLeaveDays,
  serialize,
  LEAVE_TYPES,
};
