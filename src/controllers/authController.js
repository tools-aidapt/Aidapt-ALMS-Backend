'use strict';

const { z } = require('zod');
const { asyncHandler } = require('../utils/asyncHandler');
const authService = require('../services/authService');
const emailService = require('../services/emailService');
const Employee = require('../models/Employee');
const LeaveBalance = require('../models/LeaveBalance');
const env = require('../config/env');
const { forbidden } = require('../middleware/errorHandler');

const schemas = {
  login: z.object({
    email: z.string().email(),
    password: z.string().min(1),
  }),
  register: z.object({
    name: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(8),
    dateOfJoining: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
      .optional(),
    phoneNo: z.string().optional(),
    emergencyPhoneNo: z.string().optional(),
    address: z.string().optional(),
    bankName: z.string().optional(),
    bankAccountNo: z.string().optional(),
    monthlySalary: z.union([z.string(), z.number()]).optional(),
  }),
  forgotPassword: z.object({
    email: z.string().email(),
  }),
  verifyOtp: z.object({
    email: z.string().email(),
    otp: z.string().regex(/^\d{6}$/, 'expected a 6-digit code'),
  }),
  resetPassword: z.object({
    email: z.string().email(),
    resetToken: z.string().min(1),
    password: z.string().min(8),
  }),
};

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const result = await authService.login(email, password);
  res.json({ data: result });
});

/**
 * Public self-registration. Creates a Supabase auth user, then a matching
 * Employee row (id == auth user id) as a plain Active Employee, seeds a zeroed
 * leave balance, and returns a session token. Role/manager/shift are assigned
 * later by HR Admin. If the profile insert fails, the auth user is rolled back.
 */
const register = asyncHandler(async (req, res) => {
  const b = req.body;

  const { userId } = await authService.createAuthUser({
    email: b.email,
    password: b.password,
    name: b.name,
  });

  try {
    const fields = {
      Name: b.name,
      Email: b.email,
      Role: 'Employee',
      Status: 'Active',
      // New self-registered employees start on Probation; HR Admin promotes to
      // Full-time later.
      EmploymentStatus: 'Probation',
    };
    if (b.dateOfJoining) fields.DateOfJoining = b.dateOfJoining;
    if (b.phoneNo) fields.PhoneNo = b.phoneNo;
    if (b.emergencyPhoneNo) fields.EmergencyPhoneNo = b.emergencyPhoneNo;
    if (b.address) fields.Address = b.address;
    if (b.bankName) fields.BankName = b.bankName;
    if (b.bankAccountNo) fields.BankAccountNo = b.bankAccountNo;
    if (b.monthlySalary !== undefined) fields.MonthlySalary = Number(b.monthlySalary);

    const emp = await Employee.createWithId(userId, fields);
    await LeaveBalance.create({ Employee: [userId], Annual: 0, Sick: 0, Casual: 0 });

    try {
      await emailService.sendMail({
        to: b.email,
        subject: 'Welcome to ALMS',
        html: `<p>Hi ${b.name}, your account is ready. Sign in at ${env.appBaseUrl}.</p>`,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[auth] welcome email failed:', err.message);
    }

    const { token } = await authService.login(b.email, b.password);
    res.status(201).json({ data: { token, user: authService.publicProfile(emp) } });
  } catch (err) {
    // Roll back the orphaned auth user so the email can be reused.
    await authService.deleteAuthUser(userId);
    throw err;
  }
});

const logout = asyncHandler(async (req, res) => {
  const token = (req.headers.authorization || '').split(' ')[1];
  if (token) await authService.logout(token);
  res.json({ data: { loggedOut: true } });
});

const me = asyncHandler(async (req, res) => {
  const employee = await Employee.get(req.user.id);
  if (!employee) {
    throw forbidden('Your account is not set up. Contact your administrator.', 'NOT_PROVISIONED');
  }
  res.json({ data: authService.publicProfile(employee) });
});

// Public. Always 200 with a generic message so it can't be used to probe which
// emails have accounts.
const forgotPassword = asyncHandler(async (req, res) => {
  await authService.requestPasswordReset(req.body.email);
  res.json({
    data: { message: 'If that email has an account, a reset link has been sent.' },
  });
});

// Public. Step 2: verify the OTP and receive a single-use reset token.
const verifyOtp = asyncHandler(async (req, res) => {
  const result = await authService.verifyOtp(req.body.email, req.body.otp);
  res.json({ data: result });
});

// Public. Step 3: complete the reset using the reset token from verify-otp.
const resetPassword = asyncHandler(async (req, res) => {
  await authService.resetPassword(req.body.email, req.body.resetToken, req.body.password);
  res.json({ data: { reset: true } });
});

module.exports = {
  login,
  register,
  logout,
  me,
  forgotPassword,
  verifyOtp,
  resetPassword,
  schemas,
};
