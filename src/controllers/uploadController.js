'use strict';

const multer = require('multer');
const { z } = require('zod');
const { asyncHandler } = require('../utils/asyncHandler');
const env = require('../config/env');
const uploadService = require('../services/uploadService');
const { badRequest, notFound, forbidden } = require('../middleware/errorHandler');

const memory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: uploadService.MAX_BYTES, files: 1 },
  fileFilter(req, file, cb) {
    if (!uploadService.ALLOWED_TYPES.has(file.mimetype)) {
      return cb(badRequest('Only image/jpeg, image/png, or image/webp are allowed', 'INVALID_FILE_TYPE'));
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
  purpose: z.enum(['photo', 'cnic_front', 'cnic_back']),
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
  if (!uploadService.ALLOWED_TYPES.has(req.file.mimetype)) {
    throw badRequest('Only image/jpeg, image/png, or image/webp are allowed', 'INVALID_FILE_TYPE');
  }

  const purposeResult = schemas.purpose.safeParse(req.body.purpose);
  if (!purposeResult.success) {
    throw badRequest('purpose must be photo, cnic_front, or cnic_back', 'VALIDATION_ERROR');
  }

  const row = await uploadService.create({
    employeeId: req.user.id,
    purpose: purposeResult.data,
    contentType: req.file.mimetype,
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
  // CNIC: owner or HR Admin only — never serve publicly.
  if (row.purpose !== 'photo') {
    if (!req.user) throw forbidden('Authentication required for this file', 'FORBIDDEN');
    if (!uploadService.canAccessUpload(row, req.user)) {
      throw forbidden('Not authorised to view this document', 'FORBIDDEN');
    }
  }

  res.setHeader('Content-Type', row.content_type);
  res.setHeader('Content-Length', String(row.byte_size));
  res.setHeader('Cache-Control', row.purpose === 'photo' ? 'private, max-age=86400' : 'private, no-store');
  res.status(200).send(row.data);
});

module.exports = { create, serve, uploadMiddleware, schemas, publicUrlFor };
