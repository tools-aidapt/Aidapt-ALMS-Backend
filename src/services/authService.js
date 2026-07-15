'use strict';

const crypto = require('crypto');
const { admin, anon } = require('../config/supabase');
const { query, withTransaction } = require('../config/db');
const Employee = require('../models/Employee');
const emailService = require('./emailService');
const { unauthorized, conflict, badRequest } = require('../middleware/errorHandler');

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OTP_MAX_ATTEMPTS = 5;
const RESET_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes to set the new password

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const genOtp = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

/**
 * Authentication backed by Supabase Auth.
 *
 * Passwords and sessions are managed by Supabase (auth.users). The employees
 * table holds the app profile (role, manager, shift, ...) keyed by the auth
 * user id. Login returns Supabase's access token (a JWT signed with the project
 * JWT secret), which the auth middleware verifies on each request.
 */

/**
 * Create a Supabase auth user (email confirmed so they can sign in immediately).
 * @returns {Promise<string>} the new auth user id
 */
async function createAuthUser({ email, password, name }) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name },
  });
  if (error) {
    // Duplicate email / weak password etc.
    if (/already/i.test(error.message)) {
      throw conflict('An account with that email already exists', 'EMAIL_EXISTS');
    }
    throw conflict(error.message, 'AUTH_CREATE_FAILED');
  }
  return data.user.id;
}

/** Validate credentials via Supabase and return { token, user }. */
async function login(email, password) {
  const { data, error } = await anon.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    throw unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
  }
  const employee = await Employee.get(data.user.id);
  if (!employee) {
    throw unauthorized('No employee profile for this account', 'NO_PROFILE');
  }
  if (employee.fields.Status === 'Inactive') {
    throw unauthorized('Account is inactive', 'ACCOUNT_INACTIVE');
  }
  return { token: data.session.access_token, user: publicProfile(employee) };
}

/** Best-effort server-side revoke of a token (client should also drop it). */
async function logout(token) {
  try {
    await admin.auth.admin.signOut(token);
  } catch {
    /* stateless fallback — client discards the token */
  }
}

/** Delete a Supabase auth user (used to roll back a half-created employee). */
async function deleteAuthUser(userId) {
  try {
    await admin.auth.admin.deleteUser(userId);
  } catch {
    /* ignore */
  }
}

/**
 * Step 1 — "Forgot password": generate a 6-digit OTP, store only its hash, and
 * email it via the dedicated n8n webhook. Intentionally silent about whether the
 * email exists (no account enumeration) — callers always return a generic 200.
 */
async function requestPasswordReset(email) {
  const employee = await Employee.findByEmail(email);
  if (!employee || employee.fields.Status === 'Inactive') return;

  const otp = genOtp();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();

  // One active OTP per user: drop any previous unused ones.
  await query(
    'DELETE FROM password_reset_tokens WHERE employee_id = $1 AND used_at IS NULL',
    [employee.id]
  );
  await query(
    `INSERT INTO password_reset_tokens (employee_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [employee.id, sha256(otp), expiresAt]
  );

  try {
    await emailService.sendPasswordResetOtp({
      email: employee.fields.Email,
      name: employee.fields.Name,
      otp,
      expiresMinutes: Math.round(OTP_TTL_MS / 60000),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[auth] reset OTP email failed:', err.message);
  }
}

/**
 * Step 2 — "Verify OTP": confirm the emailed code without changing anything.
 * On success it issues a single-use, short-lived *reset token* that authorises
 * the actual password change in step 3. OTP is attempt-limited; verified in a
 * transaction with a row lock so concurrent attempts can't bypass the counter.
 * @returns {Promise<{ resetToken: string, expiresInMinutes: number }>}
 */
async function verifyOtp(email, otp) {
  if (!otp) throw badRequest('Missing code', 'MISSING_OTP');
  const employee = await Employee.findByEmail(email);
  const invalid = () => badRequest('Invalid or expired code', 'RESET_OTP_INVALID');
  if (!employee) throw invalid();

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, token_hash, expires_at, used_at, attempts
       FROM password_reset_tokens
       WHERE employee_id = $1
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [employee.id]
    );
    const row = rows[0];
    if (!row || row.used_at || new Date(row.expires_at) < new Date()) throw invalid();

    if (row.attempts >= OTP_MAX_ATTEMPTS) {
      await client.query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [row.id]);
      throw badRequest('Too many attempts — request a new code', 'RESET_OTP_LOCKED');
    }

    if (sha256(String(otp)) !== row.token_hash) {
      await client.query('UPDATE password_reset_tokens SET attempts = attempts + 1 WHERE id = $1', [row.id]);
      throw invalid();
    }

    // OTP correct — issue a reset token that step 3 must present.
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetExpiry = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
    await client.query(
      `UPDATE password_reset_tokens
       SET verified_at = now(), reset_token_hash = $1, reset_token_expires_at = $2
       WHERE id = $3`,
      [sha256(resetToken), resetExpiry, row.id]
    );
    return { resetToken, expiresInMinutes: Math.round(RESET_TOKEN_TTL_MS / 60000) };
  });
}

/**
 * Step 3 — "Reset password": using the reset token from verifyOtp, set the new
 * password via the Supabase admin API and consume the token (single-use).
 */
async function resetPassword(email, resetToken, newPassword) {
  if (!resetToken) throw badRequest('Missing reset token', 'MISSING_RESET_TOKEN');
  const employee = await Employee.findByEmail(email);
  const invalid = () =>
    badRequest('Invalid or expired reset token', 'RESET_TOKEN_INVALID');
  if (!employee) throw invalid();

  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, reset_token_hash, reset_token_expires_at, used_at, verified_at
       FROM password_reset_tokens
       WHERE employee_id = $1
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [employee.id]
    );
    const row = rows[0];
    if (
      !row ||
      row.used_at ||
      !row.verified_at ||
      !row.reset_token_hash ||
      new Date(row.reset_token_expires_at) < new Date() ||
      sha256(String(resetToken)) !== row.reset_token_hash
    ) {
      throw invalid();
    }

    const { error } = await admin.auth.admin.updateUserById(employee.id, {
      password: newPassword,
    });
    if (error) throw badRequest(error.message, 'RESET_FAILED');

    await client.query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [row.id]);
  });
}

function publicProfile(employee) {
  const f = employee.fields;
  return {
    id: employee.id,
    name: f.Name,
    email: f.Email,
    role: f.Role,
    photoUrl: f.PhotoUrl || null,
    employmentStatus: f.EmploymentStatus || 'Full-time',
    manager: f.Manager || [],
    assignedShift: f.AssignedShift || [],
    dateOfJoining: f.DateOfJoining || null,
    status: f.Status,
  };
}

module.exports = {
  createAuthUser,
  login,
  logout,
  deleteAuthUser,
  requestPasswordReset,
  verifyOtp,
  resetPassword,
  publicProfile,
};
