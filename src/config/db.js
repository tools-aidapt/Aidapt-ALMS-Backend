'use strict';

const { Pool, types } = require('pg');
const env = require('./env');

/**
 * Postgres connection pool (Supabase). Replaces the old Airtable REST client.
 *
 * Type parsers:
 *  - DATE (1082)   -> keep as "YYYY-MM-DD" string (avoid JS Date timezone drift;
 *                     the rest of the code treats Date fields as day strings).
 *  - NUMERIC (1700)-> parse to JS number (pg returns numeric as string by default).
 */
types.setTypeParser(1082, (v) => v);
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));

const pool = new Pool({
  connectionString: env.db.connectionString,
  // Supabase requires SSL; it presents a cert chain node doesn't bundle, so
  // don't reject unauthorized (standard for Supabase direct connections).
  ssl: { rejectUnauthorized: false },
  max: 10,
});

pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('[db] idle client error:', err.message);
});

/** Run a parameterised query. Returns the pg result. */
function query(text, params) {
  return pool.query(text, params);
}

/**
 * Run `fn` inside a transaction. `fn` receives a client with a .query method;
 * on throw the transaction rolls back, otherwise it commits.
 * Use for multi-step invariants (e.g. deduct balance + mark leave approved).
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore rollback failure */
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
