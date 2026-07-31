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

/** Active members of a team (including the lead if they share team_id). */
Team.findMembers = function findMembers(teamId) {
  const Employee = require('./Employee');
  return Employee.selectWhere(
    "team_id = $1 AND status = 'Active'",
    [teamId],
    'ORDER BY name ASC'
  );
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
