'use strict';

const dotenv = require('dotenv');
dotenv.config();

/**
 * Centralised env loading + validation.
 * Throws on startup if required variables are missing, so the process
 * never boots into a half-configured state.
 */

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const env = {
  port: toInt(optional('PORT', '4000'), 4000),
  nodeEnv: optional('NODE_ENV', 'development'),

  db: {
    connectionString: required('DATABASE_URL'),
  },

  supabase: {
    url: required('SUPABASE_URL'),
    anonKey: required('SUPABASE_ANON_KEY'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    // Access tokens are verified via the project JWKS (asymmetric keys), derived
    // from SUPABASE_URL — so no shared secret is required. Kept optional for
    // legacy HS256 projects.
    jwtSecret: optional('SUPABASE_JWT_SECRET', ''),
  },

  geofence: {
    defaultRadiusMeters: toInt(optional('OFFICE_GEOFENCE_DEFAULT_RADIUS_M', '50'), 50),
  },

  email: {
    from: optional('EMAIL_FROM', 'alms@aidapt.co'),
    n8nWebhookUrl: optional('N8N_EMAIL_WEBHOOK_URL', ''),
    n8nWebhookToken: optional('N8N_WEBHOOK_TOKEN', ''),
    // Dedicated webhook for the password-reset OTP; falls back to the general one.
    passwordResetWebhookUrl:
      optional('N8N_PASSWORD_RESET_WEBHOOK_URL', '') ||
      optional('N8N_EMAIL_WEBHOOK_URL', ''),
  },

  appBaseUrl: optional('APP_BASE_URL', 'http://localhost:4000'),

  // Express "trust proxy" setting — needed for correct client IPs (rate limiting)
  // behind a proxy/load balancer. e.g. "1" (first hop) or "true". Empty = off.
  trustProxy: optional('TRUST_PROXY', ''),
};

env.isProduction = env.nodeEnv === 'production';

module.exports = env;
