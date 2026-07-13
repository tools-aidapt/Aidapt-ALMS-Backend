'use strict';

const rateLimit = require('express-rate-limit');
const { AppError } = require('./errorHandler');

/**
 * Per-IP rate limit: at most 60 requests per minute. Exceeding it returns a
 * 429 in the standard error envelope. The health check is exempt so uptime
 * monitors don't consume the budget.
 *
 * Store is in-memory (fine for a single instance). Behind a proxy/load balancer,
 * set TRUST_PROXY so req.ip reflects the real client (see app.js).
 */
const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true, // RateLimit-* headers
  legacyHeaders: false,
  skip: (req) => req.path === '/api/health',
  handler: (req, res, next) =>
    next(new AppError(429, 'RATE_LIMITED', 'Too many requests — please try again in a minute.')),
});

module.exports = { apiRateLimiter };
