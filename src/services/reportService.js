'use strict';

const Employee = require('../models/Employee');
const Team = require('../models/Team');
const Shift = require('../models/Shift');
const Holiday = require('../models/Holiday');
const AttendancePunch = require('../models/AttendancePunch');
const { claimReport } = require('../models/AttendanceNotificationLog');
const emailService = require('./emailService');
const { query } = require('../config/db');
const {
  todayPktDateStr,
  dateRangeInclusive,
  formatHoursMinutes,
  pktHm,
  dowForDateStr,
  round2,
} = require('../utils/dateUtils');
const { shiftLengthHours } = require('../utils/attendanceCalc');
const { ROLES } = require('../middleware/auth');

const DEFAULT_WORKING_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * Display status for a report row.
 * Leave (approved request or punch) wins; open check-in shows "Still checked in".
 */
function displayStatus(punch, onLeave) {
  if (onLeave || (punch && punch.fields.Status === 'On Leave')) return 'On Leave';
  if (!punch) return 'No record';
  const f = punch.fields;
  if (f.Status === 'Holiday') return 'Holiday';
  if (f.Status === 'Absent') return 'Absent';
  if (f.CheckInTime && !f.CheckOutTime) return 'Still checked in';
  return f.Status || 'Present';
}

/**
 * Build one attendance row for a punch (or absent placeholder).
 */
function rowFromPunch(employee, punch, dateStr, teamName = null, onLeave = false) {
  const f = punch ? punch.fields : null;
  const status = displayStatus(punch, onLeave);
  const workedMinutes =
    status === 'On Leave' || status === 'Still checked in'
      ? null
      : f && f.WorkedMinutes != null
        ? Number(f.WorkedMinutes)
        : null;
  let mode = null;
  if (status !== 'On Leave' && f && f.Mode) {
    if (f.Mode === 'Office') mode = 'Office';
    else if (f.Mode === 'Remote In') mode = 'Remote';
  }

  return {
    employeeId: employee.id,
    employeeName: employee.fields.Name || null,
    teamId: (employee.fields.Team && employee.fields.Team[0]) || null,
    teamName,
    date: dateStr,
    checkInTime: f && f.CheckInTime && status !== 'On Leave' ? pktHm(f.CheckInTime) : null,
    checkOutTime:
      f && f.CheckOutTime && status !== 'On Leave' && status !== 'Still checked in'
        ? pktHm(f.CheckOutTime)
        : null,
    status,
    mode,
    workedMinutes,
    workedDuration: workedMinutes == null ? null : formatHoursMinutes(workedMinutes),
    isLate: status === 'On Leave' ? false : f ? Boolean(f.IsLate) : false,
    lateByMinutes:
      status === 'On Leave' ? 0 : f && f.LateByMinutes != null ? Number(f.LateByMinutes) : 0,
    overtimeHours:
      status === 'On Leave' || status === 'Still checked in'
        ? null
        : f && f.OvertimeHours != null
          ? Number(f.OvertimeHours)
          : null,
  };
}

/**
 * Map employeeId → Set of YYYY-MM-DD dates covered by approved leave in [from, to].
 */
async function loadApprovedLeaveByEmployee(employeeIds, from, to) {
  const map = new Map();
  if (!employeeIds || !employeeIds.length) return map;

  const { rows } = await query(
    `SELECT employee_id, from_date, to_date
       FROM leave_requests
      WHERE status = 'Approved'
        AND employee_id = ANY($1::uuid[])
        AND from_date <= $3::date
        AND to_date >= $2::date`,
    [employeeIds, from, to]
  );

  for (const lr of rows) {
    const empId = lr.employee_id;
    if (!map.has(empId)) map.set(empId, new Set());
    const set = map.get(empId);
    const leaveFrom = String(lr.from_date).slice(0, 10);
    const leaveTo = String(lr.to_date).slice(0, 10);
    for (const d of dateRangeInclusive(leaveFrom, leaveTo)) {
      if (d >= from && d <= to) set.add(d);
    }
  }
  return map;
}

/**
 * Collect punch rows for a set of employees over [from, to] inclusive.
 * @returns {Promise<Array<object>>}
 */
async function buildRows(employees, from, to, teamNameById = new Map(), leaveByEmployee = null) {
  const dates = dateRangeInclusive(from, to);
  const leaveMap =
    leaveByEmployee ||
    (await loadApprovedLeaveByEmployee(
      employees.map((e) => e.id),
      from,
      to
    ));
  const rows = [];
  for (const emp of employees) {
    const punches = await AttendancePunch.query({
      employeeId: emp.id,
      from,
      to,
    });
    const byDate = new Map();
    for (const p of punches) {
      byDate.set(String(p.fields.Date).slice(0, 10), p);
    }
    const teamId = (emp.fields.Team && emp.fields.Team[0]) || null;
    const teamName = teamId ? teamNameById.get(teamId) || null : null;
    const leaveSet = leaveMap.get(emp.id) || new Set();
    for (const d of dates) {
      rows.push(rowFromPunch(emp, byDate.get(d) || null, d, teamName, leaveSet.has(d)));
    }
  }
  return rows.sort((a, b) => {
    const byTeam = String(a.teamName || '').localeCompare(String(b.teamName || ''));
    if (byTeam !== 0) return byTeam;
    const byName = String(a.employeeName || '').localeCompare(String(b.employeeName || ''));
    if (byName !== 0) return byName;
    return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  });
}

async function loadTeamNameMap(teamIds) {
  const map = new Map();
  if (!teamIds || !teamIds.length) return map;
  const teams = await Team.findByIds(teamIds);
  for (const t of teams) map.set(t.id, t.fields.Name);
  return map;
}

/** Recipients for a report run: HR Admins + Managers + active team leads. */
async function reportRecipients(teamIds) {
  const hr = await Employee.selectWhere(
    "status = 'Active' AND role = 'HR Admin' AND email IS NOT NULL AND email <> ''",
    [],
    'ORDER BY name ASC'
  );

  if (teamIds && teamIds.length) {
    const teams = await Team.findByIds(teamIds);
    const leadIds = teams.map((t) => (t.fields.Lead && t.fields.Lead[0]) || null).filter(Boolean);
    const leads = leadIds.length
      ? await Employee.selectWhere(
          "id = ANY($1::uuid[]) AND status = 'Active' AND email IS NOT NULL AND email <> ''",
          [leadIds],
          'ORDER BY name ASC'
        )
      : [];
    const byId = new Map();
    for (const r of [...hr, ...leads]) byId.set(r.id, r);
    return Array.from(byId.values());
  }

  const managers = await Employee.selectWhere(
    "status = 'Active' AND role = 'Manager' AND email IS NOT NULL AND email <> ''",
    [],
    'ORDER BY name ASC'
  );
  // Team leads may still be role=Employee — include them so Ops/Data leads get reports.
  const leads = await Employee.selectWhere(
    `id IN (SELECT lead_id FROM teams WHERE lead_id IS NOT NULL)
     AND status = 'Active' AND email IS NOT NULL AND email <> ''`,
    [],
    'ORDER BY name ASC'
  );

  const byId = new Map();
  for (const r of [...hr, ...managers, ...leads]) byId.set(r.id, r);
  return Array.from(byId.values());
}

/**
 * Employees in scope for a recipient.
 * - HR Admin (e.g. Hitesh) → entire organization (optional teamIds filter)
 * - Manager / team lead (e.g. Ateeb, Irtaza) → direct reportees ∪ members of
 *   teams they lead (so team assignment without manager_id still shows up)
 */
async function scopedEmployees(recipient, teamIds) {
  if (recipient.fields.Role === ROLES.HR_ADMIN) {
    if (teamIds && teamIds.length) return Employee.findByTeamIds(teamIds);
    return Employee.selectWhere("status = 'Active'", [], 'ORDER BY name ASC');
  }

  const reports = await Employee.findDirectReports(recipient.id);
  const led = await Team.selectWhere('lead_id = $1', [recipient.id], '');
  let teamMembers = [];
  if (led.length) {
    teamMembers = await Employee.findByTeamIds(led.map((t) => t.id));
  }

  const byId = new Map();
  for (const e of [...reports, ...teamMembers]) {
    // Don't include the recipient themselves in their own report list.
    if (e.id === recipient.id) continue;
    byId.set(e.id, e);
  }
  let employees = Array.from(byId.values());

  if (teamIds && teamIds.length) {
    const allow = new Set(teamIds);
    employees = employees.filter((e) => {
      const tid = (e.fields.Team && e.fields.Team[0]) || null;
      return tid && allow.has(tid);
    });
  }

  employees.sort((a, b) =>
    String(a.fields.Name || '').localeCompare(String(b.fields.Name || ''))
  );
  return employees;
}

function periodLabel(period, from, to) {
  if (period === 'daily') return `Daily attendance — ${from}`;
  if (period === 'weekly') return `Weekly attendance — ${from} → ${to}`;
  return `Monthly attendance — ${from} → ${to}`;
}

function periodKey(period, from, to, teamIds) {
  const base =
    period === 'daily' ? from : period === 'weekly' ? `W:${from}_${to}` : `M:${from.slice(0, 7)}`;
  if (teamIds && teamIds.length) {
    const sorted = [...teamIds].sort().join(',');
    return `${base}|T:${sorted}`;
  }
  return base;
}

function reportKind(period) {
  if (period === 'daily') return 'report_daily';
  if (period === 'weekly') return 'report_weekly';
  return 'report_monthly';
}

/**
 * Start of the PKT week (Monday) and end (Sunday) containing `dateStr`.
 */
function weekBoundsPkt(dateStr = todayPktDateStr()) {
  const dow = dowForDateStr(dateStr); // Mon..Sun
  const idx = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[dow];
  const daysSinceMonday = idx === 0 ? 6 : idx - 1;
  const [y, m, d] = dateStr.split('-').map(Number);
  const mondayMs = Date.UTC(y, m - 1, d - daysSinceMonday);
  const sundayMs = mondayMs + 6 * 24 * 60 * 60 * 1000;
  const fmt = (ms) => {
    const dt = new Date(ms);
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
  };
  return { from: fmt(mondayMs), to: fmt(sundayMs) };
}

function monthBoundsPkt(dateStr = todayPktDateStr()) {
  const ym = dateStr.slice(0, 7);
  const from = `${ym}-01`;
  const year = Number(ym.slice(0, 4));
  const month = Number(ym.slice(5, 7));
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const to = `${ym}-${String(last).padStart(2, '0')}`;
  return { from, to };
}

function groupRowsByTeam(rows, teams) {
  const byId = new Map();
  for (const t of teams) {
    byId.set(t.id, {
      teamId: t.id,
      teamName: t.fields.Name,
      leadId: (t.fields.Lead && t.fields.Lead[0]) || null,
      rows: [],
    });
  }
  const unassigned = { teamId: null, teamName: null, leadId: null, rows: [] };
  for (const row of rows) {
    if (row.teamId && byId.has(row.teamId)) byId.get(row.teamId).rows.push(row);
    else unassigned.rows.push(row);
  }
  const out = Array.from(byId.values());
  if (unassigned.rows.length) out.push(unassigned);
  return out;
}

async function loadShiftById(employees) {
  const ids = [
    ...new Set(employees.map((e) => (e.fields.AssignedShift || [])[0]).filter(Boolean)),
  ];
  const map = new Map();
  if (!ids.length) return map;
  const shifts = await Shift.selectWhere('id = ANY($1::uuid[])', [ids], '');
  for (const s of shifts) map.set(s.id, s);
  return map;
}

/**
 * Per-employee monthly insights from daily report rows + shift calendar.
 * Expected hours = scheduled working days (shift days − holidays − leave) × shift length.
 */
function buildEmployeeMonthlyInsight(employee, empRows, { holidaySet, leaveSet, shift }) {
  const workingDays = new Set(
    shift && shift.fields.WorkingDays && shift.fields.WorkingDays.length
      ? shift.fields.WorkingDays
      : DEFAULT_WORKING_DAYS
  );
  const shiftHours = shiftLengthHours(shift);
  const shiftMinutes = shiftHours == null ? null : Math.round(shiftHours * 60);

  let expectedWorkingDays = 0;
  for (const row of empRows) {
    const d = row.date;
    if (holidaySet.has(d)) continue;
    if (leaveSet.has(d) || row.status === 'On Leave') continue;
    if (!workingDays.has(dowForDateStr(d))) continue;
    expectedWorkingDays += 1;
  }

  const expectedMinutes = shiftMinutes == null ? null : expectedWorkingDays * shiftMinutes;
  const expectedHours = expectedMinutes == null ? null : round2(expectedMinutes / 60);

  let workedMinutes = 0;
  let overtimeHours = 0;
  let lateMinutes = 0;
  let onsiteDays = 0;
  let remoteDays = 0;
  let presentDays = 0;
  let absentDays = 0;
  let leaveDays = 0;
  let holidayDays = 0;
  let lateDays = 0;
  let stillCheckedInDays = 0;
  let noRecordDays = 0;

  for (const row of empRows) {
    if (row.workedMinutes != null) workedMinutes += Number(row.workedMinutes) || 0;
    if (row.overtimeHours != null) overtimeHours += Number(row.overtimeHours) || 0;
    if (row.isLate) {
      lateDays += 1;
      lateMinutes += Number(row.lateByMinutes) || 0;
    }
    if (row.mode === 'Office') onsiteDays += 1;
    else if (row.mode === 'Remote') remoteDays += 1;

    switch (row.status) {
      case 'Present':
        presentDays += 1;
        break;
      case 'Absent':
        absentDays += 1;
        break;
      case 'On Leave':
        leaveDays += 1;
        break;
      case 'Holiday':
        holidayDays += 1;
        break;
      case 'Still checked in':
        stillCheckedInDays += 1;
        break;
      case 'No record':
        noRecordDays += 1;
        break;
      default:
        break;
    }
  }

  const workedHours = round2(workedMinutes / 60);
  const varianceMinutes = expectedMinutes == null ? null : workedMinutes - expectedMinutes;
  const varianceHours = varianceMinutes == null ? null : round2(varianceMinutes / 60);

  return {
    employeeId: employee.id,
    employeeName: employee.fields.Name || null,
    teamId: (employee.fields.Team && employee.fields.Team[0]) || null,
    teamName: (empRows[0] && empRows[0].teamName) || null,
    shiftLengthHours: shiftHours,
    expectedWorkingDays,
    expectedMinutes,
    expectedHours,
    expectedDuration: expectedMinutes == null ? null : formatHoursMinutes(expectedMinutes),
    workedMinutes,
    workedHours,
    workedDuration: formatHoursMinutes(workedMinutes),
    hoursVariance: varianceHours,
    hoursVarianceMinutes: varianceMinutes,
    hoursVarianceDuration:
      varianceMinutes == null
        ? null
        : `${varianceMinutes >= 0 ? '+' : '−'}${formatHoursMinutes(Math.abs(varianceMinutes))}`,
    onsiteDays,
    remoteDays,
    presentDays,
    absentDays,
    leaveDays,
    holidayDays,
    lateDays,
    lateMinutes,
    overtimeHours: round2(overtimeHours),
    stillCheckedInDays,
    noRecordDays,
  };
}

/**
 * Build monthly insights for a set of employees given already-built daily rows.
 */
function buildMonthlyInsights(employees, rows, { holidaySet, leaveByEmployee, shiftById }) {
  const rowsByEmp = new Map();
  for (const row of rows) {
    if (!rowsByEmp.has(row.employeeId)) rowsByEmp.set(row.employeeId, []);
    rowsByEmp.get(row.employeeId).push(row);
  }

  return employees
    .map((emp) => {
      const shiftId = (emp.fields.AssignedShift || [])[0] || null;
      const shift = shiftId ? shiftById.get(shiftId) || null : null;
      const leaveSet = leaveByEmployee.get(emp.id) || new Set();
      const empRows = rowsByEmp.get(emp.id) || [];
      return buildEmployeeMonthlyInsight(emp, empRows, { holidaySet, leaveSet, shift });
    })
    .sort((a, b) => {
      const byTeam = String(a.teamName || '').localeCompare(String(b.teamName || ''));
      if (byTeam !== 0) return byTeam;
      return String(a.employeeName || '').localeCompare(String(b.employeeName || ''));
    });
}

/**
 * Send attendance report emails to Managers / HR Admin.
 * Also returns check-in/out rows (optionally filtered + grouped by team).
 *
 * Monthly reports include per-employee insights (worked vs expected hours,
 * onsite/remote days, late/leave/absent counts).
 *
 * @param {'daily'|'weekly'|'monthly'} period
 * @param {{from?: string, to?: string, date?: string, force?: boolean, teamIds?: string[]}} opts
 */
async function sendAttendanceReports(period, opts = {}) {
  let from;
  let to;
  if (opts.from && opts.to) {
    from = opts.from;
    to = opts.to;
  } else if (period === 'daily') {
    from = opts.date || todayPktDateStr();
    to = from;
  } else if (period === 'weekly') {
    const bounds = weekBoundsPkt(opts.date || todayPktDateStr());
    from = bounds.from;
    to = bounds.to;
  } else {
    const bounds = monthBoundsPkt(opts.date || todayPktDateStr());
    from = bounds.from;
    to = bounds.to;
  }

  const teamIds = Array.isArray(opts.teamIds) ? [...new Set(opts.teamIds.filter(Boolean))] : [];
  const teams = teamIds.length
    ? await Team.findByIds(teamIds)
    : await Team.list({ sort: [{ field: 'Name', direction: 'asc' }] });

  if (teamIds.length && teams.length !== teamIds.length) {
    const found = new Set(teams.map((t) => t.id));
    const missing = teamIds.filter((id) => !found.has(id));
    const err = new Error(`Unknown team id(s): ${missing.join(', ')}`);
    err.status = 400;
    err.code = 'TEAM_NOT_FOUND';
    throw err;
  }

  const kind = reportKind(period);
  const key = periodKey(period, from, to, teamIds.length ? teamIds : null);
  const recipients = await reportRecipients(teamIds.length ? teamIds : null);
  const teamNameById = await loadTeamNameMap(teams.map((t) => t.id));
  const results = [];
  const recipientReports = [];

  // Org-wide (or team-filtered) dataset for the API response / HR view.
  const scopeEmployees = teamIds.length
    ? await Employee.findByTeamIds(teamIds)
    : await Employee.selectWhere("status = 'Active'", [], 'ORDER BY name ASC');
  const leaveByEmployee = await loadApprovedLeaveByEmployee(
    scopeEmployees.map((e) => e.id),
    from,
    to
  );
  const allRows = await buildRows(scopeEmployees, from, to, teamNameById, leaveByEmployee);
  const teamsPayload = groupRowsByTeam(allRows, teams);

  const includeInsights = period === 'monthly';
  let holidaySet = new Set();
  let shiftById = new Map();
  let allInsights = null;
  if (includeInsights) {
    holidaySet = await Holiday.dateSet(from, to);
    shiftById = await loadShiftById(scopeEmployees);
    allInsights = buildMonthlyInsights(scopeEmployees, allRows, {
      holidaySet,
      leaveByEmployee,
      shiftById,
    });
  }

  for (const recipient of recipients) {
    const employees = await scopedEmployees(recipient, teamIds.length ? teamIds : null);
    const rows = employees.length
      ? await buildRows(employees, from, to, teamNameById, leaveByEmployee)
      : [];
    const insights =
      includeInsights && employees.length
        ? buildMonthlyInsights(employees, rows, { holidaySet, leaveByEmployee, shiftById })
        : null;

    recipientReports.push({
      recipientId: recipient.id,
      name: recipient.fields.Name || null,
      email: recipient.fields.Email || null,
      role: recipient.fields.Role || null,
      employeeCount: employees.length,
      rowCount: rows.length,
      rows,
      insights,
      teams: groupRowsByTeam(rows, teams),
    });

    if (!employees.length) {
      results.push({
        recipientId: recipient.id,
        name: recipient.fields.Name || null,
        skipped: 'no_employees',
      });
      continue;
    }

    if (!opts.force) {
      const claimed = await claimReport({
        recipientId: recipient.id,
        kind,
        forDate: to,
        periodKey: key,
      });
      if (!claimed) {
        results.push({
          recipientId: recipient.id,
          name: recipient.fields.Name || null,
          skipped: 'already_sent',
        });
        continue;
      }
    }

    const email = recipient.fields.Email;
    if (!email) {
      results.push({
        recipientId: recipient.id,
        name: recipient.fields.Name || null,
        skipped: 'no_email',
      });
      continue;
    }

    await emailService.sendAttendanceReport({
      to: email,
      recipientName: recipient.fields.Name,
      role: recipient.fields.Role,
      period,
      from,
      to,
      subject: periodLabel(period, from, to),
      rows,
      insights,
    });

    results.push({
      recipientId: recipient.id,
      name: recipient.fields.Name || null,
      email,
      role: recipient.fields.Role || null,
      employeeCount: employees.length,
      rowCount: rows.length,
      sent: true,
    });
  }

  return {
    period,
    from,
    to,
    periodKey: key,
    teamIds: teamIds.length ? teamIds : null,
    teams: teamsPayload,
    rows: allRows,
    insights: allInsights,
    recipientReports,
    results,
  };
}

module.exports = {
  sendAttendanceReports,
  buildRows,
  displayStatus,
  buildEmployeeMonthlyInsight,
  buildMonthlyInsights,
  weekBoundsPkt,
  monthBoundsPkt,
  periodLabel,
};
