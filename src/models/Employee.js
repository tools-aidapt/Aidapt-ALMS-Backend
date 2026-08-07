'use strict';

const { makeModel } = require('./_base');
const { query } = require('../config/db');

const Employee = makeModel({
  table: 'employees',
  createdColumn: 'created_at',
  columns: {
    Name: { col: 'name' },
    Email: { col: 'email' },
    Role: { col: 'role' },
    Manager: { col: 'manager_id', link: true },
    AssignedShift: { col: 'assigned_shift_id', link: true },
    // Denormalised primary team (first of multi-membership). Real membership
    // is employee_teams; hydrateTeams overwrites Team with the full list.
    Team: { col: 'team_id', link: true },
    DateOfJoining: { col: 'date_of_joining' },
    MonthlySalary: { col: 'monthly_salary' },
    Status: { col: 'status' },
    BankName: { col: 'bank_name' },
    BankAccountNo: { col: 'bank_account_no' },
    BankAccountHolderName: { col: 'bank_account_holder_name' },
    Iban: { col: 'iban' },
    Address: { col: 'address' },
    CurrentAddress: { col: 'current_address' },
    PermanentAddress: { col: 'permanent_address' },
    PhoneNo: { col: 'phone_no' },
    EmergencyPhoneNo: { col: 'emergency_phone_no' },
    EmergencyContacts: { col: 'emergency_contacts', json: true },
    Education: { col: 'education', json: true },
    Experience: { col: 'experience', json: true },
    DateOfBirth: { col: 'date_of_birth' },
    MedicalNotes: { col: 'medical_notes' },
    CnicFrontUrl: { col: 'cnic_front_url' },
    CnicBackUrl: { col: 'cnic_back_url' },
    PhotoUrl: { col: 'photo_url' },
    EmploymentStatus: { col: 'employment_status' },
    GraceMinutes: { col: 'grace_minutes' },
  },
});

/**
 * Map employee_id → team_id[] from the join table.
 * @param {string[]} employeeIds
 * @returns {Promise<Map<string, string[]>>}
 */
Employee.teamIdsByEmployee = async function teamIdsByEmployee(employeeIds) {
  const map = new Map();
  if (!employeeIds || !employeeIds.length) return map;
  const { rows } = await query(
    `SELECT employee_id, team_id
       FROM employee_teams
      WHERE employee_id = ANY($1::uuid[])
      ORDER BY created_at ASC, team_id ASC`,
    [employeeIds]
  );
  for (const r of rows) {
    const list = map.get(r.employee_id) || [];
    list.push(r.team_id);
    map.set(r.employee_id, list);
  }
  return map;
};

/**
 * Attach full multi-team lists onto records (fields.Team as uuid[]).
 * @param {Array|{id:string,fields:object}|null} records
 */
Employee.hydrateTeams = async function hydrateTeams(records) {
  if (records == null) return records;
  const list = Array.isArray(records) ? records : [records];
  if (!list.length) return records;
  const map = await this.teamIdsByEmployee(list.map((r) => r.id));
  for (const rec of list) {
    rec.fields.Team = map.get(rec.id) || [];
  }
  return records;
};

/**
 * Replace all team memberships for an employee.
 * Also mirrors the first team id onto employees.team_id for legacy readers.
 * @param {string} employeeId
 * @param {string[]} teamIds
 */
Employee.setTeamIds = async function setTeamIds(employeeId, teamIds) {
  const unique = [
    ...new Set((teamIds || []).map((id) => String(id).trim()).filter(Boolean)),
  ];
  await query(`DELETE FROM employee_teams WHERE employee_id = $1`, [employeeId]);
  if (unique.length) {
    const values = [];
    const placeholders = [];
    unique.forEach((tid, i) => {
      const a = i * 2 + 1;
      const b = i * 2 + 2;
      placeholders.push(`($${a}, $${b})`);
      values.push(employeeId, tid);
    });
    await query(
      `INSERT INTO employee_teams (employee_id, team_id) VALUES ${placeholders.join(', ')}
       ON CONFLICT DO NOTHING`,
      values
    );
  }
  // Keep denormalised primary for older code that still reads employees.team_id.
  await query(`UPDATE employees SET team_id = $1 WHERE id = $2`, [
    unique[0] || null,
    employeeId,
  ]);
  return unique;
};

/** Team memberships for one employee. */
Employee.listTeamIds = async function listTeamIds(employeeId) {
  const map = await this.teamIdsByEmployee([employeeId]);
  return map.get(employeeId) || [];
};

/**
 * Insert an employee row with an explicit id (the Supabase auth user's id),
 * keeping employees.id == auth.users.id in lockstep.
 */
Employee.createWithId = async function createWithId(id, fields) {
  // Team membership is written via setTeamIds; don't put join data on the row.
  const teamIds =
    fields.Team !== undefined
      ? Array.isArray(fields.Team)
        ? fields.Team
        : fields.Team
          ? [fields.Team]
          : []
      : undefined;
  const rowFields = { ...fields };
  // Keep first on team_id via fields.Team link if provided (denormalised).
  if (teamIds !== undefined) {
    rowFields.Team = teamIds[0] ? [teamIds[0]] : [];
  }

  const cols = this.fieldsToColumns(rowFields);
  cols.id = id;
  const keys = Object.keys(cols);
  const placeholders = keys.map((_, i) => `$${i + 1}`);
  const values = keys.map((k) => cols[k]);
  const { rows } = await query(
    `INSERT INTO employees (${keys.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
    values
  );
  const rec = this.rowToRecord(rows[0]);
  if (teamIds !== undefined) {
    await this.setTeamIds(id, teamIds);
    rec.fields.Team = teamIds;
  } else {
    await this.hydrateTeams(rec);
  }
  return rec;
};

const baseGet = Employee.get.bind(Employee);
Employee.get = async function get(id) {
  const rec = await baseGet(id);
  if (!rec) return null;
  await this.hydrateTeams(rec);
  return rec;
};

const baseSelectWhere = Employee.selectWhere.bind(Employee);
Employee.selectWhere = async function selectWhere(whereSql, params, suffix) {
  const rows = await baseSelectWhere(whereSql, params, suffix);
  await this.hydrateTeams(rows);
  return rows;
};

const baseList = Employee.list.bind(Employee);
Employee.list = async function list(opts) {
  const rows = await baseList(opts);
  await this.hydrateTeams(rows);
  return rows;
};

const baseUpdate = Employee.update.bind(Employee);
Employee.update = async function update(id, fields, client) {
  // Strip Team from row update; membership uses setTeamIds separately.
  // Callers that still pass Team get denormalised team_id only if we map link.
  const rec = await baseUpdate(id, fields, client);
  if (!rec) return null;
  await this.hydrateTeams(rec);
  return rec;
};

/** Look up an employee by (unique, case-insensitive) email. */
Employee.findByEmail = async function findByEmail(email) {
  const rows = await this.selectWhere('LOWER(email) = LOWER($1)', [String(email).trim()], 'LIMIT 1');
  return rows[0] || null;
};

/** Active direct reports of a manager, by manager id. */
Employee.findDirectReports = function findDirectReports(managerId) {
  return this.selectWhere("manager_id = $1 AND status = 'Active'", [managerId], 'ORDER BY name ASC');
};

/** Active employees belonging to any of the given team ids (join table). */
Employee.findByTeamIds = async function findByTeamIds(teamIds) {
  if (!teamIds || !teamIds.length) return [];
  const { rows } = await query(
    `SELECT DISTINCT e.*
       FROM employees e
       JOIN employee_teams et ON et.employee_id = e.id
      WHERE et.team_id = ANY($1::uuid[])
        AND e.status = 'Active'
      ORDER BY e.name ASC`,
    [teamIds]
  );
  const records = rows.map((r) => this.rowToRecord(r));
  await this.hydrateTeams(records);
  return records;
};

module.exports = Employee;
