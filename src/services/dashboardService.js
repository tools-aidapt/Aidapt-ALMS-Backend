'use strict';

const Employee = require('../models/Employee');
const LeaveBalance = require('../models/LeaveBalance');
const AttendancePunch = require('../models/AttendancePunch');
const { todayPktDateStr, pktHm } = require('../utils/dateUtils');
const { notFound } = require('../middleware/errorHandler');
const { ROLES } = require('../middleware/auth');

/** Shape today's punch for the dashboard (or null if not checked in). */
function mapTodayPunch(punch) {
  if (!punch) return null;
  const f = punch.fields;
  return {
    checkInTime: pktHm(f.CheckInTime), // "HH:mm" PKT
    checkOutTime: pktHm(f.CheckOutTime), // "HH:mm" PKT or null
    mode: f.Mode || null,
    isLate: Boolean(f.IsLate),
    lateByMinutes: f.LateByMinutes ?? 0,
    workedHours: f.WorkedHours ?? null,
    overtimeHours: f.OvertimeHours ?? null,
    distanceMeters: f.DistanceMeters ?? null,
    checkInAccuracy: f.CheckInAccuracy ?? null,
  };
}

/** Human status for a reportee, derived from their punch today. */
function reporteeStatus(punch) {
  if (!punch) return 'Not checked in';
  const f = punch.fields;
  if (f.Status === 'On Leave') return 'On leave';
  if (f.Status === 'Holiday') return 'Holiday';
  if (f.Status === 'Absent') return 'Absent';
  if (f.CheckOutTime) return 'Checked out';
  if (f.Mode === 'Remote In') return 'Working remotely';
  return 'In office';
}

/**
 * Assemble the dashboard payload for the current user: identity, manager,
 * leave balances, today's punch, and (for people-managers) direct reports with
 * their current status.
 */
async function getDashboard(userId) {
  const employee = await Employee.get(userId);
  if (!employee) throw notFound('User not found');

  const today = todayPktDateStr();
  const role = employee.fields.Role;
  const managerId = (employee.fields.Manager || [])[0] || null;
  const isManagerRole = role === ROLES.MANAGER || role === ROLES.HR_ADMIN;

  const [manager, balance, todayPunch, reports] = await Promise.all([
    managerId ? Employee.get(managerId) : Promise.resolve(null),
    LeaveBalance.findForEmployee(userId),
    AttendancePunch.findForEmployeeOnDate(userId, today),
    isManagerRole ? Employee.findDirectReports(userId) : Promise.resolve([]),
  ]);

  // Batch-load reportee punches so status is one query, not one-per-report.
  const punchByEmployee = new Map();
  if (reports.length) {
    const punches = await AttendancePunch.forEmployeesOnDate(
      reports.map((r) => r.id),
      today
    );
    for (const p of punches) {
      const eid = (p.fields.Employee || [])[0];
      if (eid) punchByEmployee.set(eid, p);
    }
  }

  return {
    name: employee.fields.Name,
    role,
    photoUrl: employee.fields.PhotoUrl || null, // column not yet in schema -> null
    reportsTo: manager ? manager.fields.Name : null,
    balances: {
      annual: Number((balance && balance.fields.Annual) || 0),
      sick: Number((balance && balance.fields.Sick) || 0),
      casual: Number((balance && balance.fields.Casual) || 0),
    },
    todayPunch: mapTodayPunch(todayPunch),
    reportees: reports.map((r) => ({
      id: r.id,
      name: r.fields.Name,
      photoUrl: r.fields.PhotoUrl || null,
      status: reporteeStatus(punchByEmployee.get(r.id) || null),
    })),
  };
}

module.exports = { getDashboard };
