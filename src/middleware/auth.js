'use strict';

const Employee = require('../models/Employee');
const { verifySupabaseToken } = require('../utils/supabaseJwt');
const { unauthorized, forbidden } = require('./errorHandler');

/**
 * Verify the Supabase access token (asymmetric ES256/RS256 against the project
 * JWKS; issuer/audience/exp enforced in verifySupabaseToken) and attach the
 * caller to req.user = { id, email, role, name }.
 *
 * Role source:
 *  - Fast path: if the token carries an `app_role` claim (set by the Supabase
 *    Custom Access Token hook), trust it and skip the DB lookup.
 *  - Fallback: look the employee up by the token's `sub`. This also enforces
 *    provisioning (403 NOT_PROVISIONED if there's no employees row) and active
 *    status. Runs when the hook isn't enabled or the claim is absent.
 *
 * Errors: 401 UNAUTHENTICATED (missing/invalid/expired token),
 *         403 NOT_PROVISIONED (valid Supabase user with no employees row).
 */
async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return next(unauthorized('Missing or malformed Authorization header', 'UNAUTHENTICATED'));
  }

  let payload;
  try {
    payload = await verifySupabaseToken(token);
  } catch (err) {
    return next(unauthorized('Invalid or expired token', 'UNAUTHENTICATED'));
  }

  // Fast path: role travels in the token, no DB round-trip.
  if (payload.app_role) {
    req.user = {
      id: payload.sub,
      email: payload.email || null,
      role: payload.app_role,
      name: (payload.user_metadata && payload.user_metadata.name) || null,
    };
    return next();
  }

  try {
    const employee = await Employee.get(payload.sub);
    if (!employee) {
      return next(forbidden('Your account is not set up. Contact your administrator.', 'NOT_PROVISIONED'));
    }
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
