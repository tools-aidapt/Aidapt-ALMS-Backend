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
    DateOfJoining: { col: 'date_of_joining' },
    MonthlySalary: { col: 'monthly_salary' },
    Status: { col: 'status' },
    BankName: { col: 'bank_name' },
    BankAccountNo: { col: 'bank_account_no' },
    Address: { col: 'address' },
    PhoneNo: { col: 'phone_no' },
    EmergencyPhoneNo: { col: 'emergency_phone_no' },
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

module.exports = Employee;
