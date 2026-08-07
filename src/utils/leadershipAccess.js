'use strict';

const { query } = require('../config/db');

/** Canonical team name for company-wide read access (CEO and leadership). */
const LEADERSHIP_TEAM_NAME = 'Leadership';

/**
 * Whether the employee is a member or lead of the Leadership team.
 * Team lead counts even if their employees.team_id points elsewhere.
 *
 * @param {string} employeeId
 * @param {{ queryFn?: typeof query }} [deps] test seam
 * @returns {Promise<boolean>}
 */
async function isLeadershipMember(employeeId, deps = {}) {
  if (!employeeId) return false;
  const run = deps.queryFn || query;
  const { rows } = await run(
    `SELECT 1
       FROM teams t
      WHERE lower(t.name) = lower($1)
        AND (
          t.lead_id = $2
          OR EXISTS (
            SELECT 1 FROM employee_teams et
             WHERE et.team_id = t.id AND et.employee_id = $2
          )
          -- Legacy: denormalised employees.team_id still counts until backfill is complete.
          OR EXISTS (
            SELECT 1 FROM employees e
             WHERE e.id = $2 AND e.team_id = t.id
          )
        )
      LIMIT 1`,
    [LEADERSHIP_TEAM_NAME, employeeId]
  );
  return rows.length > 0;
}

/**
 * Company-wide access to directory, private profiles, attendance of others, CNIC.
 * HR Admin always; Leadership team members/leads also.
 * Note: does not import auth (avoids circular dependency with authenticate middleware).
 *
 * @param {{ role?: string, isLeadership?: boolean }|null|undefined} caller
 * @returns {boolean}
 */
function hasCompanyWideDataAccess(caller) {
  if (!caller) return false;
  if (caller.role === 'HR Admin') return true;
  return Boolean(caller.isLeadership);
}

module.exports = {
  LEADERSHIP_TEAM_NAME,
  isLeadershipMember,
  hasCompanyWideDataAccess,
};
