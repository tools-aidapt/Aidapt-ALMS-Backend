'use strict';

const { z } = require('zod');
const { asyncHandler } = require('../utils/asyncHandler');
const Employee = require('../models/Employee');
const LeaveBalance = require('../models/LeaveBalance');
const authService = require('../services/authService');
const emailService = require('../services/emailService');
const env = require('../config/env');
const { ROLES } = require('../middleware/auth');
const { badRequest, notFound, forbidden, conflict } = require('../middleware/errorHandler');

const ROLE_VALUES = ['Employee', 'Manager', 'HR Admin'];

const schemas = {
  create: z.object({
    name: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(8),
    role: z.enum(ROLE_VALUES).default('Employee'),
    managerId: z.string().optional(),
    shiftId: z.string().optional(),
    dateOfJoining: z.string().optional(),
    monthlySalary: z.number().nonnegative().optional(),
    photoUrl: z.string().optional(),
    employmentStatus: z.enum(['Probation', 'Full-time']).optional(),
  }),
  update: z
    .object({
      name: z.string().min(1).optional(),
      role: z.enum(ROLE_VALUES).optional(),
      managerId: z.string().nullable().optional(),
      shiftId: z.string().nullable().optional(),
      status: z.enum(['Active', 'Inactive']).optional(),
      monthlySalary: z.number().nonnegative().optional(),
      photoUrl: z.string().nullable().optional(),
      employmentStatus: z.enum(['Probation', 'Full-time']).optional(),
    })
    .refine((o) => Object.keys(o).length > 0, { message: 'No fields to update' }),
};

/**
 * Shape an employee for output. Salary is only included for HR Admin or the
 * employee viewing their own record.
 */
function serialize(rec, caller) {
  const f = rec.fields;
  const canSeeSalary =
    caller && (caller.role === ROLES.HR_ADMIN || caller.id === rec.id);
  const out = {
    id: rec.id,
    name: f.Name,
    email: f.Email,
    role: f.Role,
    photoUrl: f.PhotoUrl || null,
    employmentStatus: f.EmploymentStatus || 'Full-time',
    manager: f.Manager || [],
    assignedShift: f.AssignedShift || [],
    dateOfJoining: f.DateOfJoining || null,
    status: f.Status || null,
    createdAt: f.CreatedAt || rec.createdTime,
  };
  if (canSeeSalary) out.monthlySalary = f.MonthlySalary ?? null;
  return out;
}

const list = asyncHandler(async (req, res) => {
  let records;
  if (req.user.role === ROLES.MANAGER) {
    // Managers see only their direct reports.
    records = await Employee.findDirectReports(req.user.id);
  } else {
    records = await Employee.list({ sort: [{ field: 'Name', direction: 'asc' }] });
  }
  res.json({ data: records.map((r) => serialize(r, req.user)) });
});

const getOne = asyncHandler(async (req, res) => {
  const rec = await Employee.get(req.params.id);
  if (!rec) throw notFound('Employee not found');

  const isSelf = req.user.id === rec.id;
  const isPrivileged =
    req.user.role === ROLES.HR_ADMIN || req.user.role === ROLES.MANAGER;
  if (!isSelf && !isPrivileged) throw forbidden();
  // A Manager may only view their own reports.
  if (req.user.role === ROLES.MANAGER && !isSelf) {
    const isReport = (rec.fields.Manager || []).includes(req.user.id);
    if (!isReport) throw forbidden('Not one of your reports');
  }

  res.json({ data: serialize(rec, req.user) });
});

const create = asyncHandler(async (req, res) => {
  const body = req.body;

  // Supabase Auth owns credentials; create the auth user first, then the profile.
  const userId = await authService.createAuthUser({
    email: body.email,
    password: body.password,
    name: body.name,
  });

  try {
    const fields = {
      Name: body.name,
      Email: body.email,
      Role: body.role,
      Status: 'Active',
    };
    if (body.managerId) fields.Manager = [body.managerId];
    if (body.shiftId) fields.AssignedShift = [body.shiftId];
    if (body.dateOfJoining) fields.DateOfJoining = body.dateOfJoining;
    if (body.monthlySalary !== undefined) fields.MonthlySalary = body.monthlySalary;
    if (body.photoUrl !== undefined) fields.PhotoUrl = body.photoUrl;
    if (body.employmentStatus !== undefined) fields.EmploymentStatus = body.employmentStatus;

    const rec = await Employee.createWithId(userId, fields);

    // Seed a zeroed leave-balance row so approvals have somewhere to deduct from.
    await LeaveBalance.create({ Employee: [userId], Annual: 0, Sick: 0, Casual: 0 });

    // Invite email (non-fatal).
    try {
      await emailService.sendMail({
        to: body.email,
        subject: 'Your ALMS account has been created',
        html: `<p>Hi ${body.name}, your account is ready. Sign in at ${env.appBaseUrl}.</p>`,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[employee] invite email failed:', err.message);
    }

    res.status(201).json({ data: serialize(rec, req.user) });
  } catch (err) {
    await authService.deleteAuthUser(userId);
    throw err;
  }
});

const update = asyncHandler(async (req, res) => {
  const rec = await Employee.get(req.params.id);
  if (!rec) throw notFound('Employee not found');

  const body = req.body;
  const fields = {};
  if (body.name !== undefined) fields.Name = body.name;
  if (body.role !== undefined) fields.Role = body.role;
  if (body.status !== undefined) fields.Status = body.status;
  if (body.monthlySalary !== undefined) fields.MonthlySalary = body.monthlySalary;
  if (body.managerId !== undefined) {
    fields.Manager = body.managerId ? [body.managerId] : [];
  }
  if (body.shiftId !== undefined) {
    fields.AssignedShift = body.shiftId ? [body.shiftId] : [];
  }
  if (body.photoUrl !== undefined) fields.PhotoUrl = body.photoUrl;
  if (body.employmentStatus !== undefined) fields.EmploymentStatus = body.employmentStatus;

  const updated = await Employee.update(rec.id, fields);
  res.json({ data: serialize(updated, req.user) });
});

// Soft-delete: never hard-delete an employee.
const remove = asyncHandler(async (req, res) => {
  const rec = await Employee.get(req.params.id);
  if (!rec) throw notFound('Employee not found');
  const updated = await Employee.update(rec.id, { Status: 'Inactive' });
  res.json({ data: serialize(updated, req.user) });
});

module.exports = { list, getOne, create, update, remove, schemas, serialize };
