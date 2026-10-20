'use strict';

const { z } = require('zod');
const { asyncHandler } = require('../utils/asyncHandler');
const remoteWorkService = require('../services/remoteWorkService');
const { ROLES } = require('../middleware/auth');
const { resolveEmployeeRecordScope } = require('../utils/employeeRecordScope');
const { forbidden } = require('../middleware/errorHandler');

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const schemas = {
  submit: z.object({
    fromDate: dateStr,
    toDate: dateStr,
    reason: z.string().trim().min(1, 'Tell your manager why you need to work remotely').max(2000),
  }),
  update: z
    .object({
      fromDate: dateStr.optional(),
      toDate: dateStr.optional(),
      reason: z.string().trim().min(1).max(2000).optional(),
    })
    .refine((obj) => Object.keys(obj).length > 0, {
      message: 'Provide at least one field to update',
    }),
  listQuery: z.object({
    employeeId: z.string().optional(),
    status: z.enum(['Pending', 'Approved', 'Rejected']).optional(),
  }),
  decideQuery: z.object({
    token: z.string().min(1),
    action: z.enum(['approve', 'reject']),
  }),
};

const submit = asyncHandler(async (req, res) => {
  const request = await remoteWorkService.submit(req.user.id, req.body);
  res.status(201).json({ data: request });
});

const list = asyncHandler(async (req, res) => {
  const employeeId = await resolveEmployeeRecordScope(req.user, req.query.employeeId);
  const rows = await remoteWorkService.list({
    employeeId,
    status: req.query.status,
  });
  res.json({ data: rows });
});

/**
 * Approver queue. Manager → Pending of direct reports; HR Admin / leadership →
 * all Pending company-wide. Never includes the caller's own requests.
 */
const listPendingForApprover = asyncHandler(async (req, res) => {
  const rows = await remoteWorkService.listPendingForApprover(req.user);
  res.json({ data: rows });
});

const getOne = asyncHandler(async (req, res) => {
  const request = await remoteWorkService.getById(req.params.id);
  const isOwner = request.employee.includes(req.user.id);
  const isApprover = request.manager.includes(req.user.id);
  const isHrAdmin = req.user.role === ROLES.HR_ADMIN || req.user.isLeadership;
  if (!isOwner && !isApprover && !isHrAdmin) throw forbidden();
  res.json({ data: request });
});

const update = asyncHandler(async (req, res) => {
  const request = await remoteWorkService.updateRequest(req.params.id, req.user.id, req.body);
  res.json({ data: request });
});

const remove = asyncHandler(async (req, res) => {
  const result = await remoteWorkService.deleteRequest(req.params.id, req.user.id);
  res.json({ data: result });
});

const approve = asyncHandler(async (req, res) => {
  const request = await remoteWorkService.decideInApp(req.params.id, 'approve', req.user);
  res.json({ data: request });
});

const reject = asyncHandler(async (req, res) => {
  const request = await remoteWorkService.decideInApp(req.params.id, 'reject', req.user);
  res.json({ data: request });
});

const decide = asyncHandler(async (req, res) => {
  const { token, action } = req.query;
  const request = await remoteWorkService.decideByToken(req.params.id, token, action);
  res.json({ data: request });
});

module.exports = {
  submit,
  list,
  listPendingForApprover,
  getOne,
  update,
  remove,
  approve,
  reject,
  decide,
  schemas,
};
