'use strict';

const env = require('../config/env');

/**
 * A typed application error. Services/controllers throw these; the central
 * handler maps them to the { error: { code, message } } response shape.
 */
class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Convenience constructors for the common HTTP failure modes.
const badRequest = (message, code = 'BAD_REQUEST') => new AppError(400, code, message);
const unauthorized = (message = 'Authentication required', code = 'UNAUTHENTICATED') =>
  new AppError(401, code, message);
const forbidden = (message = 'Not permitted', code = 'FORBIDDEN') =>
  new AppError(403, code, message);
const notFound = (message = 'Not found', code = 'NOT_FOUND') =>
  new AppError(404, code, message);
const conflict = (message, code = 'CONFLICT') => new AppError(409, code, message);

/** 404 fallback for unmatched routes. */
function notFoundHandler(req, res, next) {
  next(notFound(`No route for ${req.method} ${req.originalUrl}`, 'ROUTE_NOT_FOUND'));
}

/* eslint-disable no-unused-vars */
function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  const code = err.code || 'INTERNAL_ERROR';
  const message =
    status === 500 && env.isProduction ? 'Something went wrong' : err.message;

  if (status >= 500) {
    // Log full stack for server-side faults only.
    // eslint-disable-next-line no-console
    console.error(`[${code}]`, err.stack || err.message);
  }

  res.status(status).json({ error: { code, message } });
}

module.exports = {
  AppError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  notFoundHandler,
  errorHandler,
};
