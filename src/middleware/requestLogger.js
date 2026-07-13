'use strict';

const crypto = require('crypto');

/**
 * Structured request/response logger.
 *
 * Logs one line when a request arrives (method, url, ip, query, body) and one
 * line when the response finishes (status, duration, body). A short request id
 * ties the two together. Sensitive fields are redacted so credentials never
 * land in logs, and very large bodies are truncated.
 */

const SENSITIVE_KEYS = new Set(
  [
    'password',
    'currentpassword',
    'newpassword',
    'otp',
    'resettoken',
    'decisiontoken',
    'token',
    'passwordhash',
    'authorization',
  ].map((k) => k.toLowerCase())
);

const MAX_BODY_CHARS = 4000;

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redact(v);
    }
    return out;
  }
  return value;
}

function forLog(body) {
  if (body === undefined || body === null) return undefined;
  const redacted = redact(body);
  const str = JSON.stringify(redacted);
  if (str && str.length > MAX_BODY_CHARS) {
    return `[truncated ${str.length} chars] ${str.slice(0, MAX_BODY_CHARS)}`;
  }
  return redacted;
}

function hasBody(obj) {
  return obj && typeof obj === 'object' && Object.keys(obj).length > 0;
}

function requestLogger(req, res, next) {
  const start = Date.now();
  const id = crypto.randomUUID().slice(0, 8);

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      type: 'request',
      id,
      method: req.method,
      url: req.originalUrl,
      ip: req.ip,
      query: hasBody(req.query) ? redact(req.query) : undefined,
      body: hasBody(req.body) ? forLog(req.body) : undefined,
    })
  );

  // Capture the response body by wrapping res.json (all our responses use it).
  const originalJson = res.json.bind(res);
  res.json = (payload) => {
    res.locals.__responseBody = payload;
    return originalJson(payload);
  };

  res.on('finish', () => {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        type: 'response',
        id,
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        durationMs: Date.now() - start,
        body: forLog(res.locals.__responseBody),
      })
    );
  });

  next();
}

module.exports = { requestLogger, redact };
