'use strict';

const { createClient } = require('@supabase/supabase-js');
const env = require('./env');

/**
 * Supabase clients for authentication only (data access goes through pg).
 *
 * - admin: uses the service-role key; bypasses RLS. Used to create/delete auth
 *   users and administrative sign-out.
 * - anon: uses the anon key; used for password sign-in (signInWithPassword).
 *
 * Sessions are not persisted server-side (this is a stateless API).
 */

const noPersist = { auth: { autoRefreshToken: false, persistSession: false } };

const admin = createClient(env.supabase.url, env.supabase.serviceRoleKey, noPersist);
const anon = createClient(env.supabase.url, env.supabase.anonKey, noPersist);

module.exports = { admin, anon };
