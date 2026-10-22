'use strict';

const LeaveRequest = require('../models/LeaveRequest');
const LeaveBalance = require('../models/LeaveBalance');
const Employee = require('../models/Employee');
const Shift = require('../models/Shift');
const db = require('../config/db');
const env = require('../config/env');
const holidayService = require('./holidayService');
const emailService = require('./emailService');
const { generateDecisionToken, safeEquals } = require('../utils/tokenGenerator');
const uploadService = require('./uploadService');
const {
  needsEvidence,
  uploadIdFromUrl,
  resolveSickLeaveEvidence,
  returnDayAfter,
  returnWindowOpen,
  returnWindowOver,
  shouldCloseForMissingPrescription,
  addCalendarDays,
} = require('../utils/sickLeaveEvidence');
const { nowUtcIso, todayPktDateStr, dateRangeInclusive, dowForDateStr } = require('../utils/dateUtils');
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
  AWAITING_PRESCRIPTION: 'Awaiting Prescription',
  PRESCRIPTION_SUBMITTED: 'Prescription Submitted',
  PRESCRIPTION_MISSING: 'Prescription Missing',
};

/** Once the manager has approved, the employee can no longer change dates. */
const LOCKED_FROM_EMPLOYEE = new Set([
  STATUS.MANAGER_APPROVED,
  STATUS.APPROVED,
  STATUS.AWAITING_PRESCRIPTION,
  STATUS.PRESCRIPTION_SUBMITTED,
  STATUS.PRESCRIPTION_MISSING,
]);

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
    evidenceUrl: f.EvidenceUrl || null,
    evidenceRequired: needsEvidence(f.LeaveType, f.Days),
    prescriptionStatus: prescriptionState(f.LeaveType, f.Days, f.Status, f.EvidenceUrl),
    prescriptionNote: prescriptionNote(f.LeaveType, f.Days, f.Status, f.EvidenceUrl),
    // DecisionToken deliberately omitted from API output.
  };
}

/**
 * not_required — one sick day, annual, or casual.
 * not_submitted — 2+ sick days and no file yet (including while the manager
 *   and Hitesh are still approving).
 * submitted — file is in and waiting for the manager.
 * accepted — manager accepted the file and the leave is Approved.
 * missing — the window closed without an accepted file.
 */
function prescriptionState(leaveType, days, status, evidenceUrl) {
  if (!needsEvidence(leaveType, days)) return 'not_required';
  if (status === STATUS.PRESCRIPTION_MISSING) return 'missing';
  if (status === STATUS.APPROVED) return 'accepted';
  if (evidenceUrl) return 'submitted';
  return 'not_submitted';
}

function prescriptionNote(leaveType, days, status, evidenceUrl) {
  const state = prescriptionState(leaveType, days, status, evidenceUrl);
  if (state === 'not_submitted') {
    return "No doctor's prescription yet. The employee uploads it when they are back. Approving this leave does not replace that.";
  }
  if (state === 'submitted') {
    if (status === STATUS.PRESCRIPTION_SUBMITTED) {
      return "A doctor's prescription is attached and waiting for the manager to accept it.";
    }
    return "A doctor's prescription was attached with this request.";
  }
  if (state === 'missing') {
    return "The doctor's prescription was not accepted. These dates are not sick leave.";
  }
  return null;
}

/** Whose action the request is waiting on. Null once it is fully decided. */
function approvalStage(status) {
  if (status === STATUS.PENDING) return 'manager';
  if (status === STATUS.MANAGER_APPROVED) return 'final';
  if (status === STATUS.AWAITING_PRESCRIPTION) return 'evidence';
  if (status === STATUS.PRESCRIPTION_SUBMITTED) return 'evidence_review';
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
    prescriptionLater: needsEvidence(request.fields.LeaveType, request.fields.Days),
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
 * Validate a prescription URL owned by this employee. Empty input returns null.
 * Callers that require a file check for null themselves.
 */
async function checkedEvidenceUrl(employeeId, evidenceUrl) {
  const id = uploadIdFromUrl(evidenceUrl);
  const upload = id ? await uploadService.getById(id) : null;
  return resolveSickLeaveEvidence({
    evidenceUrl,
    upload,
    employeeId,
    appBaseUrl: env.appBaseUrl,
  });
}

/** First working day after the leave ends, skipping the shift's off days and holidays. */
async function returnDayFor(employee, toDate) {
  const to = String(toDate).slice(0, 10);
  const working = employee ? await workingDaysFor(employee) : new Set(DEFAULT_WORKING_DAYS);
  const from = addCalendarDays(to, 1);
  const holidays = await holidayService.holidayDateSet(from, addCalendarDays(to, 21));
  return returnDayAfter(to, working, holidays);
}

/**
 * Optional prescription at apply time. Empty means they will upload it when
 * they are back. A file is only valid on sick leave of 2 or more working days.
 */
async function evidenceOnApply(employeeId, leaveType, days, evidenceUrl) {
  const raw = evidenceUrl == null ? '' : String(evidenceUrl).trim();
  if (!raw || !needsEvidence(leaveType, days)) return null;
  const url = await checkedEvidenceUrl(employeeId, raw);
  if (!url) {
    throw badRequest(
      "Upload the doctor's prescription first, then include evidenceUrl.",
      'EVIDENCE_REQUIRED'
    );
  }
  return url;
}

/**
 * Submit a leave request. Computes Days, stores a single-use decision token,
 * and emails only the employee's manager. Hitesh is emailed after that
 * manager approves. A doctor's prescription may be attached now, or later
 * when the employee is back.
 */
async function submit(employeeId, { leaveType, fromDate, toDate, reason, evidenceUrl }) {
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

  const evidence = await evidenceOnApply(employeeId, leaveType, days, evidenceUrl);
  const finalApprover = await resolveFinalApprover();
  const token = generateDecisionToken();
  const rec = await LeaveRequest.create({
    Employee: [employeeId],
    LeaveType: leaveType,
    FromDate: fromDate,
    ToDate: toDate,
    Days: days,
    Reason: reason || '',
    EvidenceUrl: evidence,
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

async function notifyEmployee(request, decision, stage, { note, subject } = {}) {
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
        note,
        subject,
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[leave] decision notice failed:', err.message);
  }
}

/**
 * Deduct the leave balance and mark the request Approved.
 * `expected` locks the status this transition requires. When it is omitted,
 * the open states are Manager Approved, or Pending when allowPending is set.
 */
async function deductBalanceAndApprove(client, request, decidedById, { allowPending = false, expected } = {}) {
  const employeeId = (request.fields.Employee || [])[0];
  const col = BALANCE_COLUMN[request.fields.LeaveType];
  if (!col) throw conflict('Unknown leave type', 'BAD_LEAVE_TYPE');
  const days = request.fields.Days;
  const status = await lockLeaveStatus(client, request.id);
  const allowed = expected
    ? status === expected
    : status === STATUS.MANAGER_APPROVED || (allowPending && status === STATUS.PENDING);
  if (!allowed) {
    if (expected === STATUS.PRESCRIPTION_SUBMITTED) {
      throw conflict('There is no prescription waiting for review', 'EVIDENCE_NOT_SUBMITTED');
    }
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
  const updated = await db.withTransaction(async (client) => {
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
 * Hitesh approved sick leave that still needs a prescription. The employee is
 * on leave, but the balance is not deducted until their manager accepts the file.
 */
async function grantProvisionalApproval(request, decidedById, { allowPending = false } = {}) {
  await db.withTransaction(async (client) => {
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
    const hasFile = Boolean(request.fields.EvidenceUrl);
    const nextStatus = hasFile ? STATUS.PRESCRIPTION_SUBMITTED : STATUS.AWAITING_PRESCRIPTION;
    const reviewToken = hasFile ? generateDecisionToken() : null;
    await client.query(
      `UPDATE leave_requests
         SET status = $1, decided_at = now(), decided_by = $2, decision_token = $3
       WHERE id = $4`,
      [nextStatus, decidedById, reviewToken, request.id]
    );
  });

  const updated = await LeaveRequest.get(request.id);
  const employeeId = (updated.fields.Employee || [])[0];
  const employee = employeeId ? await Employee.get(employeeId) : null;

  if (updated.fields.EvidenceUrl) {
    await emailEvidenceReview(updated, employee);
    await notifyEmployee(updated, 'Provisionally approved', 'provisional', {
      subject: 'Your sick leave is provisionally approved',
      note: "Your doctor's prescription is with your manager. Your sick balance is not deducted until they accept it.",
    });
    return withPeople(serialize(updated));
  }

  const returnDay = await returnDayFor(employee, updated.fields.ToDate);
  await notifyEmployee(updated, 'Provisionally approved', 'provisional', {
    subject: 'Your sick leave is provisionally approved',
    note: `Upload a doctor's prescription on or after ${returnDay}, when you are back. Your sick balance is not deducted until your manager accepts that file. If it is still missing at the end of that day, these dates will show as absent.`,
  });
  return withPeople(serialize(updated));
}

/**
 * Final approval. Deducts balance and marks the request Approved, except
 * sick leave of 2 or more working days, which stays provisional until the
 * prescription is accepted. Atomic with a row lock so a double-click cannot
 * deduct twice.
 * @param {{ allowPending?: boolean }} [opts] true only when the applicant is
 *   the final approver, so the manager's yes closes the request.
 */
async function grantFinalApproval(request, decidedById, { allowPending = false } = {}) {
  if (needsEvidence(request.fields.LeaveType, request.fields.Days)) {
    return grantProvisionalApproval(request, decidedById, { allowPending });
  }

  await db.withTransaction(async (client) => {
    await deductBalanceAndApprove(client, request, decidedById, { allowPending });
  });

  const updated = await LeaveRequest.get(request.id);
  await notifyEmployee(updated, STATUS.APPROVED, 'final');
  return withPeople(serialize(updated));
}

/** Reject at either step. Does not change the leave balance. */
async function rejectLeave(request, decidedById) {
  const stage = request.fields.Status === STATUS.MANAGER_APPROVED ? 'final' : 'manager';
  await db.withTransaction(async (client) => {
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

function assertAssignedManager(request, caller) {
  if ((request.fields.Employee || []).includes(caller.id)) {
    throw forbidden('You cannot review your own prescription');
  }
  if (!(request.fields.Manager || []).includes(caller.id)) {
    throw forbidden("Only the employee's manager can review this prescription");
  }
}

function evidenceLinks(requestId, token) {
  const base = env.appBaseUrl.replace(/\/$/, '');
  const link = (action) =>
    `${base}/api/leave/requests/${requestId}/evidence/decide?token=${encodeURIComponent(token)}&action=${action}`;
  return { acceptUrl: link('accept'), rejectUrl: link('reject') };
}

/**
 * Employee uploads the prescription on or after the return day.
 * Status must be Awaiting Prescription.
 */
async function submitEvidence(requestId, employeeId, { evidenceUrl } = {}) {
  const request = await LeaveRequest.get(requestId);
  if (!request) throw notFound('Leave request not found');
  if (!(request.fields.Employee || []).includes(employeeId)) {
    throw forbidden('You can only add a prescription to your own leave');
  }
  if (request.fields.Status !== STATUS.AWAITING_PRESCRIPTION) {
    throw conflict(
      'A prescription can only be added while the leave is waiting for one',
      'EVIDENCE_NOT_DUE'
    );
  }

  const employee = await Employee.get(employeeId);
  if (!employee) throw notFound('Employee not found');
  const returnDay = await returnDayFor(employee, request.fields.ToDate);
  const today = todayPktDateStr();
  if (!returnWindowOpen(today, returnDay)) {
    throw badRequest(
      `You can submit the doctor's prescription on or after ${returnDay}, when you are back.`,
      'NOT_BACK_YET'
    );
  }

  const url = await checkedEvidenceUrl(employeeId, evidenceUrl);
  if (!url) {
    throw badRequest(
      "Upload the doctor's prescription first, then include evidenceUrl.",
      'EVIDENCE_REQUIRED'
    );
  }

  const token = generateDecisionToken();
  const updated = await LeaveRequest.update(requestId, {
    EvidenceUrl: url,
    Status: STATUS.PRESCRIPTION_SUBMITTED,
    DecisionToken: token,
  });

  await emailEvidenceReview(updated, employee);
  return withPeople(serialize(updated));
}

/** Ask the assigned manager to accept or reject a prescription already on file. */
async function emailEvidenceReview(request, employee) {
  const managerId = (request.fields.Manager || [])[0];
  const manager = managerId ? await Employee.get(managerId) : null;
  const token = request.fields.DecisionToken;
  if (!manager || !manager.fields.Email || !token) return;
  const links = evidenceLinks(request.id, token);
  try {
    await emailService.sendLeaveEvidenceReview({
      managerEmail: manager.fields.Email,
      managerName: manager.fields.Name,
      employeeName: employee ? employee.fields.Name : '',
      employeeEmail: employee ? employee.fields.Email : '',
      request,
      token,
      acceptUrl: links.acceptUrl,
      rejectUrl: links.rejectUrl,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[leave] prescription review email failed:', err.message);
  }
}

/** Assigned manager accepts the file. This deducts the sick balance. */
async function acceptEvidence(requestId, caller) {
  const request = await LeaveRequest.get(requestId);
  if (!request) throw notFound('Leave request not found');
  assertAssignedManager(request, caller);
  if (request.fields.Status !== STATUS.PRESCRIPTION_SUBMITTED) {
    throw conflict('There is no prescription waiting for review', 'EVIDENCE_NOT_SUBMITTED');
  }

  await db.withTransaction(async (client) => {
    await deductBalanceAndApprove(client, request, caller.id, {
      expected: STATUS.PRESCRIPTION_SUBMITTED,
    });
  });

  const updated = await LeaveRequest.get(requestId);
  await notifyEmployee(updated, STATUS.APPROVED, 'evidence', {
    subject: 'Your sick leave prescription was accepted',
    note: 'Your manager accepted the prescription. The sick days have been deducted from your balance.',
  });
  return withPeople(serialize(updated));
}

/**
 * Assigned manager rejects the file. Before the return day ends the employee
 * can upload again. After that, the leave is closed and the dates are absent.
 */
async function rejectEvidence(requestId, caller) {
  const request = await LeaveRequest.get(requestId);
  if (!request) throw notFound('Leave request not found');
  assertAssignedManager(request, caller);
  if (request.fields.Status !== STATUS.PRESCRIPTION_SUBMITTED) {
    throw conflict('There is no prescription waiting for review', 'EVIDENCE_NOT_SUBMITTED');
  }

  const employeeId = (request.fields.Employee || [])[0];
  const employee = employeeId ? await Employee.get(employeeId) : null;
  const returnDay = await returnDayFor(employee, request.fields.ToDate);
  const over = returnWindowOver(todayPktDateStr(), returnDay);
  const next = over ? STATUS.PRESCRIPTION_MISSING : STATUS.AWAITING_PRESCRIPTION;

  const updated = await LeaveRequest.update(requestId, {
    Status: next,
    EvidenceUrl: null,
    DecisionToken: '',
  });

  if (over) {
    await notifyEmployee(updated, 'Prescription missing', 'evidence', {
      subject: 'Your sick leave was closed — prescription rejected',
      note: `Your manager rejected the prescription and ${returnDay} has already ended. Those dates will show as absent, and your sick balance was not deducted.`,
    });
  } else {
    await notifyEmployee(updated, 'Prescription rejected', 'evidence', {
      subject: 'Your sick leave prescription was rejected',
      note: `Your manager rejected the file. Upload another doctor's prescription on or before the end of ${returnDay}.`,
    });
  }
  return withPeople(serialize(updated));
}

/** Email-link accept or reject of a prescription, gated by the review token. */
async function decideEvidenceByToken(requestId, token, action) {
  if (!token) throw badRequest('Missing token', 'MISSING_TOKEN');
  if (!['accept', 'reject'].includes(action)) {
    throw badRequest("action must be 'accept' or 'reject'");
  }
  const request = await LeaveRequest.get(requestId);
  if (!request) throw notFound('Leave request not found');
  if (request.fields.Status !== STATUS.PRESCRIPTION_SUBMITTED) {
    throw conflict(`Request already ${request.fields.Status}`, 'ALREADY_DECIDED');
  }
  const stored = request.fields.DecisionToken;
  if (!stored || !safeEquals(stored, token)) {
    throw forbidden('Invalid or already-used token', 'TOKEN_INVALID');
  }
  const managerId = (request.fields.Manager || [])[0];
  if (!managerId) throw conflict('This leave has no manager to review the prescription', 'NO_MANAGER');
  const caller = { id: managerId };
  if (action === 'accept') return acceptEvidence(requestId, caller);
  return rejectEvidence(requestId, caller);
}

/**
 * End of the return day: sick leave still waiting for a file is closed.
 * Dates then show as absent. A file already in review is left alone.
 * Run from the 23:30 PKT absent job so the return day itself stays open.
 */
async function closeMissingPrescriptions(dateStr = todayPktDateStr()) {
  const rows = await LeaveRequest.selectWhere('status = $1', [STATUS.AWAITING_PRESCRIPTION]);
  let closed = 0;
  for (const rec of rows) {
    const employeeId = (rec.fields.Employee || [])[0];
    const employee = employeeId ? await Employee.get(employeeId) : null;
    const returnDay = await returnDayFor(employee, rec.fields.ToDate);
    if (
      !shouldCloseForMissingPrescription({
        status: rec.fields.Status,
        today: dateStr,
        returnDay,
      })
    ) {
      continue;
    }
    await LeaveRequest.update(rec.id, {
      Status: STATUS.PRESCRIPTION_MISSING,
      EvidenceUrl: null,
      DecisionToken: '',
      DecidedAt: nowUtcIso(),
    });
    const updated = await LeaveRequest.get(rec.id);
    await notifyEmployee(updated, 'Prescription missing', 'evidence', {
      subject: 'Your sick leave was closed — prescription missing',
      note: `The doctor's prescription was still missing at the end of ${returnDay}. Those dates will show as absent, and your sick balance was not deducted.`,
    });
    closed += 1;
  }
  return { date: dateStr, closed };
}

/**
 * Owner edits their own leave request. Allowed while it is still with the
 * manager, or after a rejection. Locked once the manager has approved.
 * Any edit returns the request to Pending, issues a new decision token, and
 * emails the manager again. A prescription is not accepted on this edit.
 */
async function updateRequest(requestId, employeeId, patch) {
  const request = await LeaveRequest.get(requestId);
  if (!request) throw notFound('Leave request not found');

  if (!(request.fields.Employee || []).includes(employeeId)) {
    throw forbidden('You can only edit your own leave requests');
  }
  if (LOCKED_FROM_EMPLOYEE.has(request.fields.Status)) {
    if (request.fields.Status === STATUS.MANAGER_APPROVED) {
      throw conflict(
        'This leave is with the final approver and can no longer be edited',
        'AWAITING_FINAL_APPROVAL'
      );
    }
    if (request.fields.Status === STATUS.AWAITING_PRESCRIPTION) {
      throw conflict(
        "This leave is waiting for a doctor's prescription and can no longer be edited",
        'AWAITING_PRESCRIPTION'
      );
    }
    if (request.fields.Status === STATUS.PRESCRIPTION_SUBMITTED) {
      throw conflict(
        'This leave is waiting for the manager to review the prescription and can no longer be edited',
        'PRESCRIPTION_IN_REVIEW'
      );
    }
    throw conflict('This leave request can no longer be edited', 'ALREADY_DECIDED');
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
  const keptEvidence =
    patch.evidenceUrl !== undefined
      ? patch.evidenceUrl
      : needsEvidence(leaveType, days)
        ? request.fields.EvidenceUrl
        : null;
  const evidence = await evidenceOnApply(employeeId, leaveType, days, keptEvidence);
  const finalApprover = await resolveFinalApprover();
  const token = generateDecisionToken();
  await LeaveRequest.update(requestId, {
    LeaveType: leaveType,
    FromDate: fromDate,
    ToDate: toDate,
    Days: days,
    Reason: reason,
    EvidenceUrl: evidence,
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
  if (LOCKED_FROM_EMPLOYEE.has(request.fields.Status)) {
    if (request.fields.Status === STATUS.MANAGER_APPROVED) {
      throw conflict(
        'This leave is with the final approver and can no longer be deleted',
        'AWAITING_FINAL_APPROVAL'
      );
    }
    throw conflict('This leave request can no longer be deleted', 'ALREADY_DECIDED');
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
 * Approver inbox. A manager sees reports still waiting on them, including a
 * prescription that has been uploaded. The final approver sees requests the
 * manager has already approved. Never includes the caller's own submissions.
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
  submitEvidence,
  grantFinalApproval,
  acceptEvidence,
  rejectEvidence,
  decideEvidenceByToken,
  closeMissingPrescriptions,
  deductBalanceAndApprove,
  returnDayFor,
  list,
  listPendingForApprover,
  getById,
  balancesFor,
  setBalance,
  computeLeaveDays,
  serialize,
  LEAVE_TYPES,
  STATUS,
};
