'use strict';

/**
 * One-off migration: Airtable ALMS base -> Supabase (Postgres + Auth).
 *
 * Prerequs:
 *  - db/schema.sql already applied to the Supabase database.
 *  - .env has DATABASE_URL, SUPABASE_* , AIRTABLE_API_KEY, AIRTABLE_BASE_ID.
 *
 * Run:  node scripts/migrate-from-airtable.js
 *
 * Strategy:
 *  - Read every table from Airtable.
 *  - Build an Airtable-recordId -> new-UUID map per table as rows are created.
 *  - Employees: create a Supabase auth user (temp password, flagged for reset),
 *    then insert the employees row with id == auth user id. bcrypt hashes from
 *    Airtable CANNOT be reused, so each user must reset their password.
 *  - Insert dependents (balances, punches, leave, holidays, reg-log) remapping
 *    linked ids through the maps. Manager/AssignedShift are patched in a second
 *    pass once all employees/shifts exist.
 *
 * Idempotency: NOT idempotent — intended for a single run against an empty DB.
 */

require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const { pool, query } = require('../src/config/db');
const { admin } = require('../src/config/supabase');

const AIRTABLE_BASE = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}`;
const at = axios.create({
  baseURL: AIRTABLE_BASE,
  headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
});

async function listAll(table) {
  const out = [];
  let offset;
  do {
    const { data } = await at.get(`/${encodeURIComponent(table)}`, {
      params: offset ? { offset, pageSize: 100 } : { pageSize: 100 },
    });
    out.push(...data.records);
    offset = data.offset;
  } while (offset);
  return out;
}

const first = (v) => (Array.isArray(v) ? v[0] : v) || null;
const map = { employees: {}, shifts: {}, punches: {} };

async function migrateShifts() {
  const rows = await listAll('Shifts');
  for (const r of rows) {
    const f = r.fields;
    const { rows: ins } = await query(
      `INSERT INTO shifts (shift_name, start_time, end_time, grace_minutes, working_days)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [f.ShiftName || '', f.StartTime || '', f.EndTime || '', f.GraceMinutes || 0, f.WorkingDays || []]
    );
    map.shifts[r.id] = ins[0].id;
  }
  console.log(`shifts: ${rows.length}`);
}

async function migrateOfficeConfig() {
  const rows = await listAll('OfficeConfig');
  for (const r of rows) {
    const f = r.fields;
    await query(
      `INSERT INTO office_config (label, latitude, longitude, radius_meters) VALUES ($1,$2,$3,$4)`,
      [f.Label || null, f.Latitude ?? null, f.Longitude ?? null, f.RadiusMeters ?? null]
    );
  }
  console.log(`office_config: ${rows.length}`);
}

async function migrateEmployees() {
  const rows = await listAll('Employees');
  const resets = [];
  for (const r of rows) {
    const f = r.fields;
    if (!f.Email) continue; // skip blank rows
    const tempPassword = crypto.randomBytes(12).toString('base64url');
    const { data, error } = await admin.auth.admin.createUser({
      email: f.Email,
      password: tempPassword,
      email_confirm: true,
      user_metadata: { name: f.Name || '' },
    });
    if (error) {
      console.warn(`  auth create failed for ${f.Email}: ${error.message}`);
      continue;
    }
    const id = data.user.id;
    map.employees[r.id] = id;
    await query(
      `INSERT INTO employees
        (id, name, email, role, date_of_joining, monthly_salary, status,
         bank_name, bank_account_no, address, phone_no, emergency_phone_no)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id,
        f.Name || '',
        f.Email,
        f.Role || 'Employee',
        f.DateOfJoining || null,
        f.MonthlySalary ? Number(String(f.MonthlySalary).replace(/[^0-9.]/g, '')) || null : null,
        f.Status || 'Active',
        f.BankName || null,
        f.BankAccountNo || null,
        f.Address || null,
        f.PhoneNo || null,
        f.EmergencyPhoneNo || null,
      ]
    );
    resets.push(f.Email);
  }
  // Second pass: manager + assigned shift links (now that all ids exist).
  for (const r of rows) {
    const f = r.fields;
    const id = map.employees[r.id];
    if (!id) continue;
    const managerId = map.employees[first(f.Manager)] || null;
    const shiftId = map.shifts[first(f.AssignedShift)] || null;
    if (managerId || shiftId) {
      await query(`UPDATE employees SET manager_id = $1, assigned_shift_id = $2 WHERE id = $3`, [
        managerId,
        shiftId,
        id,
      ]);
    }
  }
  console.log(`employees: ${resets.length} (all must reset password): ${resets.join(', ')}`);
}

async function migrateLeaveBalances() {
  const rows = await listAll('LeaveBalance');
  let n = 0;
  for (const r of rows) {
    const f = r.fields;
    const employeeId = map.employees[first(f.Employee)];
    if (!employeeId) continue;
    await query(
      `INSERT INTO leave_balances (employee_id, annual, sick, casual)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (employee_id) DO UPDATE SET annual=$2, sick=$3, casual=$4`,
      [employeeId, f.Annual || 0, f.Sick || 0, f.Casual || 0]
    );
    n += 1;
  }
  console.log(`leave_balances: ${n}`);
}

async function migratePunches() {
  const rows = await listAll('AttendancePunches');
  let n = 0;
  for (const r of rows) {
    const f = r.fields;
    const employeeId = map.employees[first(f.Employee)];
    if (!employeeId || !f.Date) continue;
    const { rows: ins } = await query(
      `INSERT INTO attendance_punches
        (employee_id, date, check_in_time, check_out_time, check_in_lat, check_in_lng,
         check_in_accuracy, distance_meters, mode, is_late, late_by_minutes,
         worked_hours, worked_minutes, overtime_hours, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [
        employeeId, f.Date, f.CheckInTime || null, f.CheckOutTime || null,
        f.CheckInLat ?? null, f.CheckInLng ?? null, f.CheckInAccuracy ?? null,
        f.DistanceMeters ?? null, f.Mode || null, Boolean(f.IsLate),
        f.LateByMinutes ?? null, f.WorkedHours ?? null, f.WorkedMinutes ?? null,
        f.OvertimeHours ?? null, f.Status || null,
      ]
    );
    map.punches[r.id] = ins[0].id;
    n += 1;
  }
  console.log(`attendance_punches: ${n}`);
}

async function migrateLeaveRequests() {
  const rows = await listAll('LeaveRequests');
  let n = 0;
  for (const r of rows) {
    const f = r.fields;
    const employeeId = map.employees[first(f.Employee)];
    if (!employeeId) continue;
    await query(
      `INSERT INTO leave_requests
        (employee_id, leave_type, from_date, to_date, days, reason, status,
         manager_id, applied_at, decided_at, decision_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        employeeId, f.LeaveType, f.FromDate, f.ToDate, f.Days || 0, f.Reason || null,
        f.Status || 'Pending', map.employees[first(f.Manager)] || null,
        f.AppliedAt || null, f.DecidedAt || null, f.DecisionToken || null,
      ]
    );
    n += 1;
  }
  console.log(`leave_requests: ${n}`);
}

async function migrateHolidays() {
  const rows = await listAll('Holidays');
  let n = 0;
  for (const r of rows) {
    const f = r.fields;
    if (!f.Date) continue;
    await query(
      `INSERT INTO holidays (date, name, added_by) VALUES ($1,$2,$3)
       ON CONFLICT (date) DO NOTHING`,
      [f.Date, f.Name || null, map.employees[first(f.AddedBy)] || null]
    );
    n += 1;
  }
  console.log(`holidays: ${n}`);
}

async function migrateRegLog() {
  const rows = await listAll('RegularizationLog');
  let n = 0;
  for (const r of rows) {
    const f = r.fields;
    await query(
      `INSERT INTO regularization_log (punch_id, edited_by, field_changed, old_value, new_value)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        map.punches[first(f.Punch)] || null,
        map.employees[first(f.EditedBy)] || null,
        f.FieldChanged || null, f.OldValue || null, f.NewValue || null,
      ]
    );
    n += 1;
  }
  console.log(`regularization_log: ${n}`);
}

(async () => {
  try {
    console.log('Migrating Airtable -> Supabase...\n');
    await migrateShifts();
    await migrateOfficeConfig();
    await migrateEmployees();
    await migrateLeaveBalances();
    await migratePunches();
    await migrateLeaveRequests();
    await migrateHolidays();
    await migrateRegLog();
    console.log('\nDone. NOTE: all migrated users must reset their password (Supabase Auth).');
  } catch (e) {
    console.error('Migration failed:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
