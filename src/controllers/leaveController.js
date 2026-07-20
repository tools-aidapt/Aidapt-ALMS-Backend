'use strict';

const { z } = require('zod');
const { asyncHandler } = require('../utils/asyncHandler');
const leaveService = require('../services/leaveService');
const Employee = require('../models/Employee');
const { ROLES } = require('../middleware/auth');
const { forbidden, notFound } = require('../middleware/errorHandler');

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const schemas = {
  submit: z.object({
    leaveType: z.enum(['Annual', 'Sick', 'Casual']),
    fromDate: dateStr,
    toDate: dateStr,
    reason: z.string().optional(),
  }),
  update: z
    .object({
      leaveType: z.enum(['Annual', 'Sick', 'Casual']).optional(),
      fromDate: dateStr.optional(),
      toDate: dateStr.optional(),
      reason: z.string().optional(),
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
  setBalance: z
    .object({
      annual: z.number().nonnegative().optional(),
      sick: z.number().nonnegative().optional(),
      casual: z.number().nonnegative().optional(),
    })
    .refine((o) => Object.keys(o).length > 0, {
      message: 'Provide at least one of annual, sick, casual',
    }),
};

const submit = asyncHandler(async (req, res) => {
  const request = await leaveService.submit(req.user.id, req.body);
  res.status(201).json({ data: request });
});

const list = asyncHandler(async (req, res) => {
  const filters = { ...req.query };
  if (req.user.role === ROLES.EMPLOYEE) filters.employeeId = req.user.id;
  const rows = await leaveService.list(filters);
  res.json({ data: rows });
});

const getOne = asyncHandler(async (req, res) => {
  const request = await leaveService.getById(req.params.id);
  const isOwner = request.employee.includes(req.user.id);
  const isApprover = request.manager.includes(req.user.id);
  const isHrAdmin = req.user.role === ROLES.HR_ADMIN;
  if (!isOwner && !isApprover && !isHrAdmin) throw forbidden();
  res.json({ data: request });
});

const update = asyncHandler(async (req, res) => {
  const request = await leaveService.updateRequest(req.params.id, req.user.id, req.body);
  res.json({ data: request });
});

const remove = asyncHandler(async (req, res) => {
  const result = await leaveService.deleteRequest(req.params.id, req.user.id);
  res.json({ data: result });
});

const approve = asyncHandler(async (req, res) => {
  const request = await leaveService.decideInApp(req.params.id, 'approve', req.user);
  res.json({ data: request });
});

const reject = asyncHandler(async (req, res) => {
  const request = await leaveService.decideInApp(req.params.id, 'reject', req.user);
  res.json({ data: request });
});

// Public, token-gated endpoint hit from the approval email.
const decide = asyncHandler(async (req, res) => {
  const { token, action } = req.query;
  const request = await leaveService.decideByToken(req.params.id, token, action);
  res.json({ data: request });
});

const balances = asyncHandler(async (req, res) => {
  const targetId = req.params.employeeId;
  const isSelf = req.user.id === targetId;
  const isHrAdmin = req.user.role === ROLES.HR_ADMIN;
  const isManager = req.user.role === ROLES.MANAGER;

  if (!isSelf && !isHrAdmin && !isManager) throw forbidden();
  if (isManager && !isSelf) {
    const target = await Employee.get(targetId);
    if (!target) throw notFound('Employee not found');
    if (!(target.fields.Manager || []).includes(req.user.id)) {
      throw forbidden('Not one of your reports');
    }
  }

  const data = await leaveService.balancesFor(targetId);
  res.json({ data });
});

// HR Admin sets an employee's leave balance (absolute values).
const setBalance = asyncHandler(async (req, res) => {
  const data = await leaveService.setBalance(req.params.employeeId, req.body);
  res.json({ data });
});

module.exports = { submit, list, getOne, update, remove, approve, reject, decide, balances, setBalance, schemas };
