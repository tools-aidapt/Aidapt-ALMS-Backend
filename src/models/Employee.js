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
 * Insert an employee row with an explicit id (the Supabase auth user's id),
 * keeping employees.id == auth.users.id in lockstep.
 */
Employee.createWithId = async function createWithId(id, fields) {
  const cols = this.fieldsToColumns(fields);
  cols.id = id;
  const keys = Object.keys(cols);
  const placeholders = keys.map((_, i) => `$${i + 1}`);
  const values = keys.map((k) => cols[k]);
  const { rows } = await query(
    `INSERT INTO employees (${keys.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
    values
  );
  return this.rowToRecord(rows[0]);
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

/** Active employees belonging to any of the given team ids. */
Employee.findByTeamIds = function findByTeamIds(teamIds) {
  if (!teamIds || !teamIds.length) return Promise.resolve([]);
  return this.selectWhere(
    "team_id = ANY($1::uuid[]) AND status = 'Active'",
    [teamIds],
    'ORDER BY name ASC'
  );
};

module.exports = Employee;
