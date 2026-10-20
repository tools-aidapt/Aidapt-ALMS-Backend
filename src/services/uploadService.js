'use strict';

const { query } = require('../config/db');

const PURPOSES = new Set(['photo', 'cnic_front', 'cnic_back', 'sick_leave_evidence']);
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
// Prescriptions may also be a PDF. Photo and CNIC stay image-only.
const EVIDENCE_TYPES = new Set([...ALLOWED_TYPES, 'application/pdf']);
const ACCEPTED_UPLOAD_TYPES = EVIDENCE_TYPES;
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB

async function create({ employeeId, purpose, contentType, data }) {
  const { rows } = await query(
    `INSERT INTO employee_uploads (employee_id, purpose, content_type, byte_size, data)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, employee_id, purpose, content_type, byte_size, created_at`,
    [employeeId, purpose, contentType, data.length, data]
  );
  return rows[0];
}

async function getById(id) {
  const { rows } = await query(
    `SELECT id, employee_id, purpose, content_type, byte_size, data, created_at
     FROM employee_uploads WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

/**
 * Transfer ownership of uploads referenced by CNIC / photo URL so the subject
 * employee (not only the HR uploader) can fetch gated CNIC files.
 * `url` forms: absolute `${appBase}/api/uploads/:id` or path `/api/uploads/:id`.
 */
async function reassignUploadOwnerFromUrl(url, newEmployeeId) {
  if (!url || !newEmployeeId) return;
  const match = String(url).match(/\/api\/uploads\/([0-9a-fA-F-]{36})(?:\?|$)/);
  if (!match) return;
  await query(`UPDATE employee_uploads SET employee_id = $1 WHERE id = $2`, [
    newEmployeeId,
    match[1],
  ]);
}

/**
 * Pure auth rule for serving an upload (no DB). Used by the controller and tests.
 *
 * - photo: any authenticated caller (semi-public avatar; UUID is unguessable)
 * - cnic_* and sick_leave_evidence: owner, HR Admin, or leadership
 *   (a manager or final approver is allowed separately in isEvidenceReviewer)
 */
function canAccessUpload(uploadMeta, caller) {
  if (!uploadMeta || !caller) return false;
  if (uploadMeta.purpose === 'photo') return true;
  // HR Admin or Leadership team (CEO etc.) may view CNIC scans company-wide.
  if (caller.role === 'HR Admin' || caller.isLeadership) return true;
  return caller.id === uploadMeta.employee_id;
}

/**
 * Manager of the employee, or the manager / final approver on a leave request
 * that cites this prescription. HR and the owner are already covered by
 * canAccessUpload.
 */
async function isEvidenceReviewer(uploadMeta, caller) {
  if (!uploadMeta || !caller || !caller.id || uploadMeta.purpose !== 'sick_leave_evidence') {
    return false;
  }
  const { rows } = await query(
    `SELECT 1
       FROM employees
      WHERE id = $1 AND manager_id = $2
     UNION ALL
     SELECT 1
       FROM leave_requests
      WHERE (manager_id = $2 OR final_approver_id = $2)
        AND evidence_url LIKE '%/api/uploads/' || $3::text
      LIMIT 1`,
    [uploadMeta.employee_id, caller.id, uploadMeta.id]
  );
  return rows.length > 0;
}

/**
 * Email approval links append ?token= so the approver can open the prescription
 * without a separate login. The token is the live decision token for that
 * request, and it stops working once the stage is decided.
 */
async function evidenceTokenGrantsAccess(uploadId, token) {
  if (!uploadId || !token) return false;
  const { rows } = await query(
    `SELECT 1
       FROM leave_requests
      WHERE decision_token = $1
        AND status IN ('Pending', 'Manager Approved')
        AND evidence_url LIKE '%/api/uploads/' || $2::text
      LIMIT 1`,
    [String(token), String(uploadId)]
  );
  return rows.length > 0;
}

module.exports = {
  PURPOSES,
  ALLOWED_TYPES,
  EVIDENCE_TYPES,
  ACCEPTED_UPLOAD_TYPES,
  MAX_BYTES,
  create,
  getById,
  reassignUploadOwnerFromUrl,
  canAccessUpload,
  isEvidenceReviewer,
  evidenceTokenGrantsAccess,
};
