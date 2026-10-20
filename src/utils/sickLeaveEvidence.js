'use strict';

const { badRequest, forbidden } = require('../middleware/errorHandler');

/** Working days. One sick day does not need a file; two or more do. */
const SICK_EVIDENCE_MIN_DAYS = 2;
const EVIDENCE_PURPOSE = 'sick_leave_evidence';

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

/**
 * Sick leave of 2+ working days must cite an upload this employee made with
 * purpose sick_leave_evidence. Other leave may omit it. A URL that is present
 * is always checked, so a casual request cannot point at someone else's file.
 * Returns the canonical evidence URL, or null when none is required or given.
 */
function resolveSickLeaveEvidence({
  leaveType,
  days,
  evidenceUrl,
  upload,
  employeeId,
  appBaseUrl,
}) {
  const required = needsEvidence(leaveType, days);
  const raw = evidenceUrl == null ? '' : String(evidenceUrl).trim();
  if (!raw) {
    if (required) {
      throw badRequest(
        "Sick leave of 2 or more working days requires a doctor's prescription or other medical evidence. Upload the file, then include evidenceUrl.",
        'EVIDENCE_REQUIRED'
      );
    }
    return null;
  }

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
  needsEvidence,
  uploadIdFromUrl,
  canonicalEvidenceUrl,
  resolveSickLeaveEvidence,
};
