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

// Liveness probe for App Runner / load balancers. Registered BEFORE the rate
// limiter and logger so these frequent pings are cheap, never logged, and can
// never be rate-limited (a 429 here would fail the health check and the deploy).
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

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
