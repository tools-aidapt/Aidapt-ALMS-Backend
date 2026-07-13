'use strict';

const axios = require('axios');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');

/**
 * Verify Supabase access tokens.
 *
 * New Supabase projects sign JWTs asymmetrically (ES256/RS256) with rotating
 * keys published at the project's JWKS endpoint — so there is no shared HS256
 * secret to verify against. We fetch the public keys (cached), pick the one
 * matching the token's `kid`, and verify locally.
 */

const JWKS_URL = `${env.supabase.url}/auth/v1/.well-known/jwks.json`;
const REFRESH_COOLDOWN_MS = 60 * 1000;

let keyCache = new Map(); // kid -> crypto.KeyObject
let lastFetch = 0;

async function refreshJwks() {
  const { data } = await axios.get(JWKS_URL, { timeout: 10000 });
  const next = new Map();
  for (const jwk of (data && data.keys) || []) {
    try {
      next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
    } catch {
      /* skip keys of an unsupported type */
    }
  }
  keyCache = next;
  lastFetch = Date.now();
}

async function getKey(kid) {
  if (!keyCache.has(kid) && Date.now() - lastFetch > REFRESH_COOLDOWN_MS) {
    await refreshJwks(); // key rotation / cold start
  }
  return keyCache.get(kid) || null;
}

/**
 * Verify a token and return its payload. Throws on any failure.
 */
async function verifySupabaseToken(token) {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || !decoded.header) throw new Error('malformed token');

  const { kid, alg } = decoded.header;
  const key = await getKey(kid);
  if (!key) throw new Error('unknown signing key');

  return jwt.verify(token, key, {
    algorithms: [alg || 'ES256'],
    issuer: `${env.supabase.url}/auth/v1`,
    audience: 'authenticated',
  });
}

module.exports = { verifySupabaseToken };
