'use strict';

/**
 * Wrap an async route handler so thrown/rejected errors reach Express's
 * error middleware without a try/catch in every controller.
 */
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { asyncHandler };
