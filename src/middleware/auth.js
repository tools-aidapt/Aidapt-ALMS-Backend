'use strict';

const Employee = require('../models/Employee');
const { verifySupabaseToken } = require('../utils/supabaseJwt');
const { unauthorized, forbidden } = require('./errorHandler');

/**
 * Verify the Supabase access token (asymmetric ES256/RS256, checked against the
 * project JWKS) and attach the caller to req.user. The app role lives in the
 * employees table (authoritative), so we load it here by the token's subject.
 *
 * req.user = { id, email, role, name }
 */
async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return next(unauthorized('Missing or malformed Authorization header'));
  }

  let payload;
  try {
    payload = await verifySupabaseToken(token);
  } catch (err) {
    return next(unauthorized('Invalid or expired token', 'TOKEN_INVALID'));
  }

  try {
    const employee = await Employee.get(payload.sub);
    if (!employee) return next(unauthorized('No employee profile', 'NO_PROFILE'));
    if (employee.fields.Status === 'Inactive') {
      return next(unauthorized('Account is inactive', 'ACCOUNT_INACTIVE'));
    }
    req.user = {
      id: employee.id,
      email: employee.fields.Email,
      role: employee.fields.Role,
      name: employee.fields.Name,
    };
    return next();
  } catch (err) {
    return next(err);
  }
}

/** Role guard factory. Must run after authenticate(). */
function requireRole(...allowed) {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (!allowed.includes(req.user.role)) {
      return next(forbidden(`Requires role: ${allowed.join(' or ')}`));
    }
    return next();
  };
}

const ROLES = { EMPLOYEE: 'Employee', MANAGER: 'Manager', HR_ADMIN: 'HR Admin' };

module.exports = { authenticate, requireRole, ROLES };
