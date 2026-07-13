'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const env = require('./config/env');
const routes = require('./routes');
const { apiRateLimiter } = require('./middleware/rateLimiter');
const { requestLogger } = require('./middleware/requestLogger');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const app = express();

// Correct client IP behind a proxy/load balancer (for rate limiting). Off by
// default; set TRUST_PROXY (e.g. "1" or "true") when deployed behind one.
if (env.trustProxy) {
  const tp = /^\d+$/.test(env.trustProxy) ? Number(env.trustProxy) : env.trustProxy;
  app.set('trust proxy', tp);
}

app.use(helmet());
app.use(cors());

// Rate limit before body parsing so flooded requests are rejected cheaply.
app.use(apiRateLimiter);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Log every request (with payload) and every response.
app.use(requestLogger);

// All API routes live under /api.
app.use('/api', routes);

// 404 for anything unmatched, then the central error mapper.
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
