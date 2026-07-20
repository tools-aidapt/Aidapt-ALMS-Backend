'use strict';

const { z } = require('zod');
const { asyncHandler } = require('../utils/asyncHandler');
const regularizationService = require('../services/regularizationService');
const { ROLES } = require('../middleware/auth');
const { forbidden } = require('../middleware/errorHandler');

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const schemas = {
  submit: z
    .object({
      date: dateStr,
      requestedCheckInTime: z.string().datetime().optional(),
      requestedCheckOutTime: z.string().datetime().optional(),
      reason: z.string().optional(),
    })
    .refine((o) => o.requestedCheckInTime || o.requestedCheckOutTime, {
      message: 'Provide requestedCheckInTime and/or requestedCheckOutTime',
    }),
  update: z
    .object({
      date: dateStr.optional(),
      requestedCheckInTime: z.string().datetime().optional(),
      requestedCheckOutTime: z.string().datetime().optional(),
      reason: z.string().optional(),
    })
    .refine((o) => Object.keys(o).length > 0, { message: 'Provide at least one field to update' }),
  listQuery: z.object({
    employeeId: z.string().optional(),
    status: z.enum(['Pending', 'Approved', 'Rejected']).optional(),
  }),
};

// Employee submits a request to correct their own punch for a date.
const submit = asyncHandler(async (req, res) => {
  const request = await regularizationService.submit(req.user.id, req.body);
  res.status(201).json({ data: request });
});

// Scoped list: Employee -> own; Manager -> their approval queue; HR Admin -> all.
const list = asyncHandler(async (req, res) => {
  const filters = { ...req.query };
  if (req.user.role === ROLES.EMPLOYEE) filters.employeeId = req.user.id;
  else if (req.user.role === ROLES.MANAGER) filters.managerId = req.user.id;
  const rows = await regularizationService.list(filters);
  res.json({ data: rows });
});

const getOne = asyncHandler(async (req, res) => {
  const request = await regularizationService.getById(req.params.id);
  const isOwner = request.employee.includes(req.user.id);
  const isApprover = request.manager.includes(req.user.id);
  const isHrAdmin = req.user.role === ROLES.HR_ADMIN;
  if (!isOwner && !isApprover && !isHrAdmin) throw forbidden();
  res.json({ data: request });
});

// Owner edits their own request while it is still Pending.
const update = asyncHandler(async (req, res) => {
  const request = await regularizationService.updateRequest(req.params.id, req.user.id, req.body);
  res.json({ data: request });
});

const approve = asyncHandler(async (req, res) => {
  const result = await regularizationService.decideInApp(req.params.id, 'approve', req.user);
  res.json({ data: result });
});

const reject = asyncHandler(async (req, res) => {
  const result = await regularizationService.decideInApp(req.params.id, 'reject', req.user);
  res.json({ data: result });
});

const remove = asyncHandler(async (req, res) => {
  const result = await regularizationService.cancel(req.params.id, req.user.id);
  res.json({ data: result });
});

module.exports = { submit, list, getOne, update, approve, reject, remove, schemas };
