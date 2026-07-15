'use strict';

const env = require('../config/env');
const { safeEquals } = require('../utils/tokenGenerator');
const { unauthorized, AppError } = require('./errorHandler');

/**
 * Guard for machine-triggered job endpoints. Authenticates with the shared
 * JOBS_SECRET sent in the `X-Job-Secret` header (NOT a user JWT). Comparison is
 * constant-time. If JOBS_SECRET is unset the endpoint is disabled (503) so it
 * can never be left open by misconfiguration.
 */
function requireJobSecret(req, res, next) {
  if (!env.jobsSecret) {
    return next(new AppError(503, 'JOBS_NOT_CONFIGURED', 'Job trigger is not configured'));
  }
  const provided = req.get('x-job-secret') || '';
  if (!safeEquals(provided, env.jobsSecret)) {
    return next(unauthorized('Invalid job secret', 'JOB_SECRET_INVALID'));
  }
  return next();
}

module.exports = { requireJobSecret };
