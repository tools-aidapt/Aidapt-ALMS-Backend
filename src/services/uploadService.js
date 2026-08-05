'use strict';

const { query } = require('../config/db');

const PURPOSES = new Set(['photo', 'cnic_front', 'cnic_back']);
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
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
 * - cnic_*: owner employee or HR Admin only
 */
function canAccessUpload(uploadMeta, caller) {
  if (!uploadMeta || !caller) return false;
  if (uploadMeta.purpose === 'photo') return true;
  if (caller.role === 'HR Admin') return true;
  return caller.id === uploadMeta.employee_id;
}

module.exports = {
  PURPOSES,
  ALLOWED_TYPES,
  MAX_BYTES,
  create,
  getById,
  reassignUploadOwnerFromUrl,
  canAccessUpload,
};
