'use strict';

const { query } = require('../config/db');

/**
 * Try to record a notification send. Returns true if this is the first claim
 * (caller should send), false if already logged (skip).
 */
async function claimReminder({ employeeId, kind, forDate }) {
  try {
    await query(
      `INSERT INTO attendance_notification_log (kind, for_date, employee_id)
       VALUES ($1, $2, $3)`,
      [kind, forDate, employeeId]
    );
    return true;
  } catch (err) {
    if (err && err.code === '23505') return false; // unique_violation
    throw err;
  }
}

async function claimReport({ recipientId, kind, forDate, periodKey }) {
  try {
    await query(
      `INSERT INTO attendance_notification_log
         (kind, for_date, recipient_id, period_key)
       VALUES ($1, $2, $3, $4)`,
      [kind, forDate, recipientId, periodKey]
    );
    return true;
  } catch (err) {
    if (err && err.code === '23505') return false;
    throw err;
  }
}

module.exports = { claimReminder, claimReport };
