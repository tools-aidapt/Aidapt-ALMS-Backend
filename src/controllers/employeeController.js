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
      // Personal details — HR Admin may correct these on an employee's behalf.
      phoneNo: z.string().nullable().optional(),
      emergencyPhoneNo: z.string().nullable().optional(),
      address: z.string().nullable().optional(),
      bankName: z.string().nullable().optional(),
      bankAccountNo: z.string().nullable().optional(),
    })
    .refine((o) => Object.keys(o).length > 0, { message: 'No fields to update' }),
  setStatus: z.object({
    status: z.enum(['Active', 'Inactive']),
  }),
  // Self-service edit: an employee may change only their own personal details.
  // Deliberately excludes role, status, employmentStatus, monthlySalary,
  // dateOfJoining, managerId, shiftId and email — those stay HR/auth controlled.
  updateSelf: z
    .object({
      name: z.string().min(1).optional(),
      photoUrl: z.string().nullable().optional(),
      phoneNo: z.string().nullable().optional(),
      emergencyPhoneNo: z.string().nullable().optional(),
      address: z.string().nullable().optional(),
      bankName: z.string().nullable().optional(),
      bankAccountNo: z.string().nullable().optional(),
    })
    .refine((o) => Object.keys(o).length > 0, { message: 'No fields to update' }),
};

/**
 * Shape an employee for output. Salary is only included for HR Admin or the
 * employee viewing their own record.
 */
function serialize(rec, caller) {
  const f = rec.fields;
  // Salary and personal contact/bank details are private: only the employee
  // themselves or an HR Admin may see them.
  const canSeePrivate =
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
  if (canSeePrivate) {
    out.monthlySalary = f.MonthlySalary ?? null;
    out.phoneNo = f.PhoneNo || null;
    out.emergencyPhoneNo = f.EmergencyPhoneNo || null;
    out.address = f.Address || null;
    out.bankName = f.BankName || null;
    out.bankAccountNo = f.BankAccountNo || null;
  }
  return out;
}

// HR Admin sees the full directory; a Manager sees only their direct reports.
const list = asyncHandler(async (req, res) => {
  let records;
  if (req.user.role === ROLES.MANAGER) {
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
      // Default new hires to Probation unless HR explicitly sets otherwise.
      EmploymentStatus: body.employmentStatus || 'Probation',
    };
    if (body.managerId) fields.Manager = [body.managerId];
    if (body.shiftId) fields.AssignedShift = [body.shiftId];
    if (body.dateOfJoining) fields.DateOfJoining = body.dateOfJoining;
    if (body.monthlySalary !== undefined) fields.MonthlySalary = body.monthlySalary;
    if (body.photoUrl !== undefined) fields.PhotoUrl = body.photoUrl;

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
  if (body.phoneNo !== undefined) fields.PhoneNo = body.phoneNo;
  if (body.emergencyPhoneNo !== undefined) fields.EmergencyPhoneNo = body.emergencyPhoneNo;
  if (body.address !== undefined) fields.Address = body.address;
  if (body.bankName !== undefined) fields.BankName = body.bankName;
  if (body.bankAccountNo !== undefined) fields.BankAccountNo = body.bankAccountNo;

  const updated = await Employee.update(rec.id, fields);
  res.json({ data: serialize(updated, req.user) });
});

// Self-service profile edit. Any authenticated employee may update their OWN
// personal details only (never role/status/salary/employment/shift/manager).
const updateSelf = asyncHandler(async (req, res) => {
  const rec = await Employee.get(req.user.id);
  if (!rec) throw notFound('Employee not found');

  const body = req.body;
  const fields = {};
  if (body.name !== undefined) fields.Name = body.name;
  if (body.photoUrl !== undefined) fields.PhotoUrl = body.photoUrl;
  if (body.phoneNo !== undefined) fields.PhoneNo = body.phoneNo;
  if (body.emergencyPhoneNo !== undefined) fields.EmergencyPhoneNo = body.emergencyPhoneNo;
  if (body.address !== undefined) fields.Address = body.address;
  if (body.bankName !== undefined) fields.BankName = body.bankName;
  if (body.bankAccountNo !== undefined) fields.BankAccountNo = body.bankAccountNo;

  const updated = await Employee.update(rec.id, fields);
  res.json({ data: serialize(updated, req.user) });
});

// Activate / deactivate an employee. Deactivating is the soft-delete: an
// Inactive employee is blocked at login. HR Admin cannot deactivate their own
// account (lockout guard).
const setStatus = asyncHandler(async (req, res) => {
  const rec = await Employee.get(req.params.id);
  if (!rec) throw notFound('Employee not found');

  const { status } = req.body;
  if (status === 'Inactive' && rec.id === req.user.id) {
    throw badRequest('You cannot deactivate your own account', 'CANNOT_SELF_DEACTIVATE');
  }

  const updated = await Employee.update(rec.id, { Status: status });
  res.json({ data: serialize(updated, req.user) });
});

// Soft-delete: never hard-delete an employee (sets Status to Inactive).
const remove = asyncHandler(async (req, res) => {
  const rec = await Employee.get(req.params.id);
  if (!rec) throw notFound('Employee not found');
  if (rec.id === req.user.id) {
    throw badRequest('You cannot deactivate your own account', 'CANNOT_SELF_DEACTIVATE');
  }
  const updated = await Employee.update(rec.id, { Status: 'Inactive' });
  res.json({ data: serialize(updated, req.user) });
});

module.exports = { list, getOne, create, update, updateSelf, setStatus, remove, schemas, serialize };
