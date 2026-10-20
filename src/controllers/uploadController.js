'use strict';

const multer = require('multer');
const { z } = require('zod');
const { asyncHandler } = require('../utils/asyncHandler');
const env = require('../config/env');
const uploadService = require('../services/uploadService');
const { badRequest, notFound, forbidden } = require('../middleware/errorHandler');
const { resolveContentType, contentDisposition, sniffContentType } = require('../utils/fileType');
const { EVIDENCE_PURPOSE } = require('../utils/sickLeaveEvidence');

const memory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: uploadService.MAX_BYTES, files: 1 },
  fileFilter(req, file, cb) {
    if (!uploadService.ACCEPTED_UPLOAD_TYPES.has(file.mimetype)) {
      return cb(
        badRequest('Only JPEG, PNG, WEBP, or PDF files are allowed', 'INVALID_FILE_TYPE')
      );
    }
    return cb(null, true);
  },
});

const uploadMiddleware = (req, res, next) => {
  memory.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(badRequest('File exceeds the 8 MB limit', 'FILE_TOO_LARGE'));
      }
      return next(badRequest(err.message, 'UPLOAD_ERROR'));
    }
    return next(err);
  });
};

const schemas = {
  // purpose arrives as a multipart text field; validated after multer parses.
  purpose: z.enum(['photo', 'cnic_front', 'cnic_back', EVIDENCE_PURPOSE]),
};

function publicUrlFor(id) {
  const base = String(env.appBaseUrl || '').replace(/\/$/, '');
  return `${base}/api/uploads/${id}`;
}

/**
 * POST /api/uploads — multipart: file + purpose=photo|cnic_front|cnic_back
 * → { data: { url } }
 *
 * CNIC files are private: the returned URL requires Authorization when fetched
 * (self owner or HR Admin). Photo purpose is reachable by any authenticated
 * caller with the unguessable UUID.
 */
const create = asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('Missing file field', 'MISSING_FILE');
  if (req.file.size > uploadService.MAX_BYTES) {
    throw badRequest('File exceeds the 8 MB limit', 'FILE_TOO_LARGE');
  }
  const purposeResult = schemas.purpose.safeParse(req.body.purpose);
  if (!purposeResult.success) {
    throw badRequest(
      'purpose must be photo, cnic_front, cnic_back, or sick_leave_evidence',
      'VALIDATION_ERROR'
    );
  }
  const purpose = purposeResult.data;

  let contentType = req.file.mimetype;
  if (purpose === EVIDENCE_PURPOSE) {
    const sniffed = sniffContentType(req.file.buffer);
    if (!sniffed || !uploadService.EVIDENCE_TYPES.has(sniffed)) {
      throw badRequest(
        "A doctor's prescription must be a JPEG, PNG, WEBP, or PDF file",
        'INVALID_FILE_TYPE'
      );
    }
    contentType = sniffed;
  } else if (!uploadService.ALLOWED_TYPES.has(req.file.mimetype)) {
    throw badRequest('Only image/jpeg, image/png, or image/webp are allowed', 'INVALID_FILE_TYPE');
  }

  const row = await uploadService.create({
    employeeId: req.user.id,
    purpose,
    contentType,
    data: req.file.buffer,
  });

  res.status(200).json({ data: { url: publicUrlFor(row.id) } });
});

/**
 * GET /api/uploads/:id — stream stored bytes with purpose-based authorisation.
 */
const serve = asyncHandler(async (req, res) => {
  const row = await uploadService.getById(req.params.id);
  if (!row) throw notFound('Upload not found');

  // Photo: unguessable UUID is enough (team avatars / img tags without auth).
  // Prescriptions: the approval-email token can open the file while that stage
  // is still open. Otherwise the owner, HR, the employee's manager, or the
  // final approver must be signed in.
  // CNIC: owner or HR Admin only — never serve publicly.
  if (row.purpose === EVIDENCE_PURPOSE && req.query && req.query.token) {
    const ok = await uploadService.evidenceTokenGrantsAccess(row.id, req.query.token);
    if (!ok) throw forbidden('Invalid or expired prescription link', 'TOKEN_INVALID');
  } else if (row.purpose !== 'photo') {
    if (!req.user) throw forbidden('Authentication required for this file', 'FORBIDDEN');
    const allowed =
      uploadService.canAccessUpload(row, req.user) ||
      (row.purpose === EVIDENCE_PURPOSE && (await uploadService.isEvidenceReviewer(row, req.user)));
    if (!allowed) {
      throw forbidden('Not authorised to view this document', 'FORBIDDEN');
    }
  }

  const type = resolveContentType({
    upstreamType: row.content_type,
    bytes: row.data,
  });
  const ext = type === 'application/pdf' ? '.pdf' : '';
  const downloadName =
    row.purpose === EVIDENCE_PURPOSE ? `prescription${ext}` : `${row.purpose || 'image'}`;
  res.setHeader('Content-Type', type);
  // inline so a browser tab shows the picture or PDF instead of only offering download.
  res.setHeader('Content-Disposition', contentDisposition(type, downloadName));
  res.setHeader('Content-Length', String(row.byte_size));
  res.setHeader('Cache-Control', row.purpose === 'photo' ? 'private, max-age=86400' : 'private, no-store');
  res.status(200).send(row.data);
});

module.exports = { create, serve, uploadMiddleware, schemas, publicUrlFor };
