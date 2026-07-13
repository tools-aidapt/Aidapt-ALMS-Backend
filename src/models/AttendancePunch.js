'use strict';

const { makeModel } = require('./_base');

const AttendancePunch = makeModel({
  table: 'attendance_punches',
  columns: {
    Employee: { col: 'employee_id', link: true },
    Date: { col: 'date' },
    CheckInTime: { col: 'check_in_time' },
    CheckOutTime: { col: 'check_out_time' },
    CheckInLat: { col: 'check_in_lat' },
    CheckInLng: { col: 'check_in_lng' },
    CheckInAccuracy: { col: 'check_in_accuracy' },
    DistanceMeters: { col: 'distance_meters' },
    Mode: { col: 'mode' },
    IsLate: { col: 'is_late' },
    LateByMinutes: { col: 'late_by_minutes' },
    WorkedHours: { col: 'worked_hours' },
    WorkedMinutes: { col: 'worked_minutes' },
    OvertimeHours: { col: 'overtime_hours' },
    Status: { col: 'status' },
  },
});

/** The single punch row for one employee on one date (or null). */
AttendancePunch.findForEmployeeOnDate = async function findForEmployeeOnDate(employeeId, dateStr) {
  const rows = await this.selectWhere('employee_id = $1 AND date = $2', [employeeId, dateStr], 'LIMIT 1');
  return rows[0] || null;
};

/** Today's punches for a set of employees (batch, for dashboards). */
AttendancePunch.forEmployeesOnDate = function forEmployeesOnDate(employeeIds, dateStr) {
  if (!employeeIds || !employeeIds.length) return Promise.resolve([]);
  return this.selectWhere('date = $1 AND employee_id = ANY($2)', [dateStr, employeeIds]);
};

/** Filtered list for the attendance list endpoint. */
AttendancePunch.query = function query({ employeeId, from, to, status } = {}) {
  const where = [];
  const params = [];
  if (employeeId) where.push(`employee_id = $${params.push(employeeId)}`);
  if (from) where.push(`date >= $${params.push(from)}`);
  if (to) where.push(`date <= $${params.push(to)}`);
  if (status) where.push(`status = $${params.push(status)}`);
  return this.selectWhere(where.join(' AND '), params, 'ORDER BY date DESC');
};

module.exports = AttendancePunch;
