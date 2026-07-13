'use strict';

const crypto = require('crypto');

/**
 * Single-use decision tokens for email approval links.
 *
 * The token is a random opaque string stored on the LeaveRequest
 * (DecisionToken field). It is validated on the /decide endpoint and then
 * cleared, making it single-use. No secret material is embedded — it is purely
 * a lookup key, so it cannot be forged without a base write.
 */
function generateDecisionToken() {
  return crypto.randomBytes(32).toString('hex');
}

/** Constant-time comparison to avoid timing leaks on token check. */
function safeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { generateDecisionToken, safeEquals };
