'use strict';

const { badRequest, forbidden } = require('../middleware/errorHandler');
const { dowForDateStr } = require('./dateUtils');

/** Working days. One sick day never needs a file; two or more do, after the employee is back. */
const SICK_EVIDENCE_MIN_DAYS = 2;
const EVIDENCE_PURPOSE = 'sick_leave_evidence';

/** Statuses that still count as leave on attendance and reports. */
const COVERING_LEAVE_STATUSES = ['Approved', 'Awaiting Prescription', 'Prescription Submitted'];
const COVERING_LEAVE_STATUS_SQL = `status IN ('Approved', 'Awaiting Prescription', 'Prescription Submitted')`;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function needsEvidence(leaveType, days) {
  return leaveType === 'Sick' && Number(days) >= SICK_EVIDENCE_MIN_DAYS;
}

function uploadIdFromUrl(url) {
  const match = String(url || '').match(/\/api\/uploads\/([0-9a-fA-F-]{36})(?:\?|#|$)/);
  return match ? match[1].toLowerCase() : null;
}

function canonicalEvidenceUrl(appBaseUrl, uploadId) {
  const base = String(appBaseUrl || '').replace(/\/$/, '');
  return `${base}/api/uploads/${uploadId}`;
}

function addCalendarDays(dateStr, days) {
  const start = Date.parse(`${String(dateStr).slice(0, 10)}T12:00:00Z`);
  return new Date(start + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * First working day after toDate. Weekends follow the shift; public holidays are skipped.
 * workingDays is a Set (or array) of 'Mon'..'Sun'. holidays is a Set (or array) of YYYY-MM-DD.
 */
function returnDayAfter(toDate, workingDays, holidays) {
  const working = workingDays instanceof Set ? workingDays : new Set(workingDays || []);
  const holidaySet = holidays instanceof Set ? holidays : new Set(holidays || []);
  let cursor = addCalendarDays(toDate, 1);
  for (let i = 0; i < 21; i += 1) {
    if (working.has(dowForDateStr(cursor)) && !holidaySet.has(cursor)) return cursor;
    cursor = addCalendarDays(cursor, 1);
  }
  return cursor;
}

/** Upload is allowed from the return day onward. */
function returnWindowOpen(today, returnDay) {
  return String(today) >= String(returnDay);
}

/** The return day is over once today's date is after it. The day itself is still open. */
function returnWindowOver(today, returnDay) {
  return String(today) > String(returnDay);
}

function shouldCloseForMissingPrescription({ status, today, returnDay }) {
  return status === 'Awaiting Prescription' && String(returnDay) <= String(today);
}

/**
 * Validate a prescription upload URL. An empty URL returns null — applying for
 * leave does not require the file. The later evidence endpoint rejects null.
 */
function resolveSickLeaveEvidence({ evidenceUrl, upload, employeeId, appBaseUrl }) {
  const raw = evidenceUrl == null ? '' : String(evidenceUrl).trim();
  if (!raw) return null;

  const id = uploadIdFromUrl(raw);
  const uploadId = upload && upload.id ? String(upload.id).toLowerCase() : '';
  if (!id || !upload || uploadId !== id) {
    throw badRequest(
      "evidenceUrl must be the URL returned after uploading a doctor's prescription.",
      'INVALID_EVIDENCE'
    );
  }
  if (upload.purpose !== EVIDENCE_PURPOSE) {
    throw badRequest(
      'That file is not a sick-leave prescription. Upload it with purpose sick_leave_evidence.',
      'INVALID_EVIDENCE'
    );
  }
  if (String(upload.employee_id) !== String(employeeId)) {
    throw forbidden('That prescription belongs to another employee.', 'INVALID_EVIDENCE');
  }
  return canonicalEvidenceUrl(appBaseUrl, id);
}

module.exports = {
  SICK_EVIDENCE_MIN_DAYS,
  EVIDENCE_PURPOSE,
  COVERING_LEAVE_STATUSES,
  COVERING_LEAVE_STATUS_SQL,
  needsEvidence,
  uploadIdFromUrl,
  canonicalEvidenceUrl,
  addCalendarDays,
  returnDayAfter,
  returnWindowOpen,
  returnWindowOver,
  shouldCloseForMissingPrescription,
  resolveSickLeaveEvidence,
};
