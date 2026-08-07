'use strict';

const { makeModel } = require('./_base');
const { query } = require('../config/db');

const Team = makeModel({
  table: 'teams',
  createdColumn: 'created_at',
  columns: {
    Name: { col: 'name' },
    Lead: { col: 'lead_id', link: true },
  },
});

/**
 * Active members of a team: join table membership, plus the team lead if active
 * (lead may not be listed in employee_teams yet).
 */
Team.findMembers = async function findMembers(teamId) {
  const Employee = require('./Employee');
  const { rows } = await query(
    `SELECT DISTINCT e.*
       FROM employees e
      WHERE e.status = 'Active'
        AND (
          e.id IN (SELECT employee_id FROM employee_teams WHERE team_id = $1)
          OR e.id = (SELECT lead_id FROM teams WHERE id = $1)
        )
      ORDER BY e.name ASC`,
    [teamId]
  );
  const records = rows.map((r) => Employee.rowToRecord(r));
  await Employee.hydrateTeams(records);
  return records;
};

/** Lookup by exact name (case-insensitive). */
Team.findByName = async function findByName(name) {
  const rows = await this.selectWhere('LOWER(name) = LOWER($1)', [String(name).trim()], 'LIMIT 1');
  return rows[0] || null;
};

/** Resolve many teams by id. */
Team.findByIds = async function findByIds(ids) {
  if (!ids || !ids.length) return [];
  const { rows } = await query(
    `SELECT * FROM teams WHERE id = ANY($1::uuid[]) ORDER BY name ASC`,
    [ids]
  );
  return rows.map((r) => this.rowToRecord(r));
};

module.exports = Team;
