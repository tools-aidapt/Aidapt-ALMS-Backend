'use strict';

const RegularizationRequest = require('../models/RegularizationRequest');
const RegularizationLog = require('../models/RegularizationLog');
const AttendancePunch = require('../models/AttendancePunch');
const Employee = require('../models/Employee');
const Shift = require('../models/Shift');
const attendanceService = require('./attendanceService');
const emailService = require('./emailService');
const { nowUtcIso } = require('../utils/dateUtils');
const { shiftLengthHours, computeWorked, computeLateness } = require('../utils/attendanceCalc');
const { badRequest, conflict, notFound, forbidden } = require('../middleware/errorHandler');

function serialize(rec) {
  const f = rec.fields;
  return {
    id: rec.id,
    employee: f.Employee || [],
    date: f.Date || null,
    requestedCheckInTime: f.RequestedCheckInTime || null,
    requestedCheckOutTime: f.RequestedCheckOutTime || null,
    reason: f.Reason || null,
    status: f.Status || null,
    manager: f.Manager || [],
    punch: f.Punch || [],
    appliedAt: f.AppliedAt || null,
    decidedAt: f.DecidedAt || null,
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

/** Attach employee/manager name + photoUrl to serialized requests (batched). */
async function attachPeople(items) {
  const ids = [];
  for (const it of items) ids.push((it.employee || [])[0], (it.manager || [])[0]);
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

async function withPeople(serialized) {
  const [one] = await attachPeople([serialized]);
  return one;
}

/**
 * Submit a regularization request for a past/forgotten punch. Routes to the
 * employee's assigned manager (HR Admin can also action it). One open request
 * per employee+date.
 */
async function submit(employeeId, { date, requestedCheckInTime, requestedCheckOutTime, reason }) {
  if (!requestedCheckInTime && !requestedCheckOutTime) {
    throw badRequest('Provide requestedCheckInTime and/or requestedCheckOutTime');
  }
  const employee = await Employee.get(employeeId);
  if (!employee) throw notFound('Employee not found');

  const dupe = await RegularizationRequest.findPendingForDate(employeeId, date);
  if (dupe) {
    throw conflict('A pending regularization request already exists for this date', 'DUPLICATE_REQUEST');
  }

  // A check-out is meaningless without a check-in — either in this request or
  // already on the day's punch.
  if (requestedCheckOutTime && !requestedCheckInTime) {
    const punch = await AttendancePunch.findForEmployeeOnDate(employeeId, date);
    if (!punch || !punch.fields.CheckInTime) {
      throw badRequest('Cannot request a check-out without a check-in', 'CHECKOUT_WITHOUT_CHECKIN');
    }
  }

  const managerId = (employee.fields.Manager || [])[0] || null;
  const fields = {
    Employee: [employeeId],
    Date: date,
    Reason: reason || '',
    Status: 'Pending',
    AppliedAt: nowUtcIso(),
  };
  if (requestedCheckInTime) fields.RequestedCheckInTime = requestedCheckInTime;
  if (requestedCheckOutTime) fields.RequestedCheckOutTime = requestedCheckOutTime;
  if (managerId) fields.Manager = [managerId];

  const rec = await RegularizationRequest.create(fields);
  await notifyManager(rec, employee);
  return withPeople(serialize(rec));
}

/**
 * Email the assigned manager that a request needs their decision. Non-fatal:
 * the request stands even if there's no manager/email or the webhook fails.
 */
async function notifyManager(rec, employee) {
  const managerId = (rec.fields.Manager || [])[0] || null;
  if (!managerId) {
    // eslint-disable-next-line no-console
    console.warn(
      `[regularization] approval email skipped for request ${rec.id}: employee has no assigned Manager`
    );
    return;
  }
  try {
    const manager = await Employee.get(managerId);
    if (manager && manager.fields.Email) {
      await emailService.sendRegularizationApprovalRequest({
        managerEmail: manager.fields.Email,
        employeeName: employee.fields.Name,
        employeeEmail: employee.fields.Email,
        request: rec,
      });
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `[regularization] approval email skipped for request ${rec.id}: manager ${managerId} has no Email`
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[regularization] approval email failed:', err.message);
  }
}

const normalise = (v) => (v === undefined || v === null ? '' : String(v));

/**
 * Apply an approved request to the day's attendance punch: upsert the punch
 * with the requested times, re-derive lateness + worked/overtime, and write one
 * regularization_log row per changed field (audit trail). Marks the request
 * Approved and links the punch.
 */
async function applyApproval(request, approverId) {
  const employeeId = (request.fields.Employee || [])[0];
  const date = request.fields.Date;

  const existing = await AttendancePunch.findForEmployeeOnDate(employeeId, date);
  const finalCheckIn = request.fields.RequestedCheckInTime || (existing && existing.fields.CheckInTime) || null;
  const finalCheckOut = request.fields.RequestedCheckOutTime || (existing && existing.fields.CheckOutTime) || null;
  if (finalCheckOut && !finalCheckIn) {
    throw badRequest('Cannot set a check-out time without a check-in', 'CHECKOUT_WITHOUT_CHECKIN');
  }

  // Employee's shift drives lateness + shift length for overtime.
  const employee = await Employee.get(employeeId);
  const shiftId = employee && (employee.fields.AssignedShift || [])[0];
  const shift = shiftId ? await Shift.get(shiftId) : null;

  const lateness = finalCheckIn ? computeLateness(shift, finalCheckIn) : { isLate: false, lateByMinutes: 0 };
  const worked = computeWorked(finalCheckIn, finalCheckOut, shiftLengthHours(shift));

  const fieldUpdates = {
    CheckInTime: finalCheckIn,
    CheckOutTime: finalCheckOut,
    Status: 'Present',
    IsLate: lateness.isLate,
    LateByMinutes: lateness.lateByMinutes,
    WorkedHours: worked.workedHours,
    WorkedMinutes: worked.workedMinutes,
    OvertimeHours: worked.overtimeHours,
  };

  // Persist the punch (create if the day had none, e.g. an absent/no-show day).
  const punch = existing
    ? await AttendancePunch.update(existing.id, fieldUpdates)
    : await AttendancePunch.create({ Employee: [employeeId], Date: date, ...fieldUpdates });

  // Audit: log every field whose value actually changed.
  for (const [field, newValue] of Object.entries(fieldUpdates)) {
    const oldValue = existing ? existing.fields[field] : undefined;
    if (normalise(oldValue) === normalise(newValue)) continue;
    await RegularizationLog.create({
      Punch: [punch.id],
      EditedBy: [approverId],
      FieldChanged: field,
      OldValue: normalise(oldValue),
      NewValue: normalise(newValue),
    });
  }

  await RegularizationRequest.update(request.id, {
    Status: 'Approved',
    DecidedAt: nowUtcIso(),
    Punch: [punch.id],
  });

  const updated = await RegularizationRequest.get(request.id);
  return {
    request: await withPeople(serialize(updated)),
    punch: attendanceService.serialize(punch),
  };
}

/**
 * In-app approve/reject. A Manager may only decide requests where they are the
 * assigned approver; HR Admin may decide any.
 */
async function decideInApp(requestId, action, caller) {
  const request = await RegularizationRequest.get(requestId);
  if (!request) throw notFound('Regularization request not found');
  if (request.fields.Status !== 'Pending') {
    throw conflict(`Request already ${request.fields.Status}`, 'ALREADY_DECIDED');
  }

  const isHrAdmin = caller.role === 'HR Admin';
  const isAssignedManager = (request.fields.Manager || []).includes(caller.id);
  if (!isHrAdmin && !isAssignedManager) {
    throw forbidden('You are not the approver for this request');
  }

  if (action === 'approve') {
    return applyApproval(request, caller.id);
  }

  await RegularizationRequest.update(request.id, {
    Status: 'Rejected',
    DecidedAt: nowUtcIso(),
  });
  const updated = await RegularizationRequest.get(request.id);
  return { request: await withPeople(serialize(updated)), punch: null };
}

async function list({ employeeId, managerId, status } = {}) {
  const rows = await RegularizationRequest.query({ employeeId, managerId, status });
  return attachPeople(rows.map(serialize));
}

async function getById(id) {
  const rec = await RegularizationRequest.get(id);
  if (!rec) throw notFound('Regularization request not found');
  return withPeople(serialize(rec));
}

/**
 * Owner edits their own request while it is still Pending. Re-validates the
 * merged times, guards duplicates on a changed date, keeps it Pending, and
 * re-notifies the manager with the updated details.
 */
async function updateRequest(requestId, employeeId, patch) {
  const request = await RegularizationRequest.get(requestId);
  if (!request) throw notFound('Regularization request not found');
  if (!(request.fields.Employee || []).includes(employeeId)) {
    throw forbidden('You can only edit your own regularization requests');
  }
  if (request.fields.Status !== 'Pending') {
    throw conflict(`Cannot edit a request that is already ${request.fields.Status}`, 'ALREADY_DECIDED');
  }

  const date = patch.date ?? request.fields.Date;
  const checkIn =
    'requestedCheckInTime' in patch ? patch.requestedCheckInTime : request.fields.RequestedCheckInTime;
  const checkOut =
    'requestedCheckOutTime' in patch ? patch.requestedCheckOutTime : request.fields.RequestedCheckOutTime;
  const reason = patch.reason ?? request.fields.Reason ?? '';

  if (!checkIn && !checkOut) {
    throw badRequest('Provide requestedCheckInTime and/or requestedCheckOutTime');
  }

  // Guard a duplicate pending request if the date is being moved.
  if (date !== request.fields.Date) {
    const dupe = await RegularizationRequest.findPendingForDate(employeeId, date);
    if (dupe && dupe.id !== requestId) {
      throw conflict('A pending regularization request already exists for this date', 'DUPLICATE_REQUEST');
    }
  }

  // Check-out needs a check-in — in this request or already on the day's punch.
  if (checkOut && !checkIn) {
    const punch = await AttendancePunch.findForEmployeeOnDate(employeeId, date);
    if (!punch || !punch.fields.CheckInTime) {
      throw badRequest('Cannot request a check-out without a check-in', 'CHECKOUT_WITHOUT_CHECKIN');
    }
  }

  await RegularizationRequest.update(requestId, {
    Date: date,
    RequestedCheckInTime: checkIn || null,
    RequestedCheckOutTime: checkOut || null,
    Reason: reason,
    Status: 'Pending',
  });

  const updated = await RegularizationRequest.get(requestId);
  const employee = await Employee.get(employeeId);
  await notifyManager(updated, employee);
  return withPeople(serialize(updated));
}

/** Owner cancels their own request while it is still Pending. */
async function cancel(requestId, employeeId) {
  const request = await RegularizationRequest.get(requestId);
  if (!request) throw notFound('Regularization request not found');
  if (!(request.fields.Employee || []).includes(employeeId)) {
    throw forbidden('You can only cancel your own regularization requests');
  }
  if (request.fields.Status !== 'Pending') {
    throw conflict(`Cannot cancel a request that is already ${request.fields.Status}`, 'ALREADY_DECIDED');
  }
  await RegularizationRequest.remove(requestId);
  return { id: requestId, deleted: true };
}

module.exports = {
  submit,
  updateRequest,
  decideInApp,
  list,
  getById,
  cancel,
  serialize,
};
