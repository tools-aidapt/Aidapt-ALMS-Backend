'use strict';

const Employee = require('../models/Employee');
const Team = require('../models/Team');
const Shift = require('../models/Shift');
const Holiday = require('../models/Holiday');
const AttendancePunch = require('../models/AttendancePunch');
const LeaveBalance = require('../models/LeaveBalance');
const EmployeeMonthlyStrike = require('../models/EmployeeMonthlyStrike');
const { claimReport } = require('../models/AttendanceNotificationLog');
const emailService = require('./emailService');
const monthlyReportPdfService = require('./monthlyReportPdfService');
const { query } = require('../config/db');
const {
  todayPktDateStr,
  dateRangeInclusive,
  formatHoursMinutes,
  pktHm,
  parseHhMm,
  dowForDateStr,
  round2,
} = require('../utils/dateUtils');
const { shiftLengthHours } = require('../utils/attendanceCalc');
const { ROLES } = require('../middleware/auth');

const DEFAULT_WORKING_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
/** Standard probation length used when employment_status is Probation (no stored end date). */
const PROBATION_MONTHS = 3;

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
 * Empty leave-meta shell for one employee (types + request list).
 */
function emptyLeaveMeta() {
  return {
    taken: { annual: 0, sick: 0, casual: 0 },
    items: [],
  };
}

/**
 * Map employeeId → Set of YYYY-MM-DD dates covered by approved leave in [from, to].
 * Also returns per-employee leave taken breakdown for the period.
 */
async function loadApprovedLeaveByEmployee(employeeIds, from, to) {
  const map = new Map();
  const metaByEmployee = new Map();
  if (!employeeIds || !employeeIds.length) {
    return { leaveByEmployee: map, leaveMetaByEmployee: metaByEmployee };
  }

  const { rows } = await query(
    `SELECT employee_id, leave_type, from_date, to_date, days
       FROM leave_requests
      WHERE status = 'Approved'
        AND employee_id = ANY($1::uuid[])
        AND from_date <= $3::date
        AND to_date >= $2::date
      ORDER BY from_date ASC`,
    [employeeIds, from, to]
  );

  for (const lr of rows) {
    const empId = lr.employee_id;
    if (!map.has(empId)) map.set(empId, new Set());
    if (!metaByEmployee.has(empId)) metaByEmployee.set(empId, emptyLeaveMeta());
    const set = map.get(empId);
    const meta = metaByEmployee.get(empId);
    const leaveFrom = String(lr.from_date).slice(0, 10);
    const leaveTo = String(lr.to_date).slice(0, 10);
    const type = lr.leave_type || null;
    const datesInPeriod = [];
    for (const d of dateRangeInclusive(leaveFrom, leaveTo)) {
      if (d >= from && d <= to) {
        set.add(d);
        datesInPeriod.push(d);
      }
    }
    const daysInPeriod = datesInPeriod.length;
    if (type === 'Annual') meta.taken.annual += daysInPeriod;
    else if (type === 'Sick') meta.taken.sick += daysInPeriod;
    else if (type === 'Casual') meta.taken.casual += daysInPeriod;

    meta.items.push({
      leaveType: type,
      fromDate: leaveFrom,
      toDate: leaveTo,
      endsOn: leaveTo,
      daysInPeriod,
      totalDays: lr.days != null ? Number(lr.days) : daysInPeriod,
    });
  }
  return { leaveByEmployee: map, leaveMetaByEmployee: metaByEmployee };
}

/** Batch leave balances: employeeId → { annual, sick, casual }. */
async function loadLeaveBalancesByEmployee(employeeIds) {
  const map = new Map();
  if (!employeeIds || !employeeIds.length) return map;
  const rows = await LeaveBalance.selectWhere(
    'employee_id = ANY($1::uuid[])',
    [employeeIds],
    ''
  );
  for (const bal of rows) {
    const eid = (bal.fields.Employee && bal.fields.Employee[0]) || null;
    if (!eid) continue;
    map.set(eid, {
      annual: Number(bal.fields.Annual || 0),
      sick: Number(bal.fields.Sick || 0),
      casual: Number(bal.fields.Casual || 0),
    });
  }
  return map;
}

/** Batch monthly strike snapshots: employeeId → { lateCount, strikeCount, items }. */
async function loadMonthlyStrikesByEmployee(employeeIds, yearMonth) {
  const map = new Map();
  if (!employeeIds || !employeeIds.length || !yearMonth) return map;
  const rows = await EmployeeMonthlyStrike.selectWhere(
    'year_month = $1 AND employee_id = ANY($2::uuid[])',
    [yearMonth, employeeIds],
    ''
  );
  for (const rec of rows) {
    const eid = (rec.fields.Employee && rec.fields.Employee[0]) || null;
    if (!eid) continue;
    const items = Array.isArray(rec.fields.StrikeItems) ? rec.fields.StrikeItems : [];
    map.set(eid, {
      lateCount: Number(rec.fields.LateCount ?? 0),
      strikeCount: Number(rec.fields.StrikeCount ?? 0),
      items: items.map((item) => ({
        date: item && item.date ? String(item.date).slice(0, 10) : null,
        reason: item && item.reason ? String(item.reason) : null,
        checkInTimePkt: item && item.checkInTimePkt ? item.checkInTimePkt : null,
      })),
    });
  }
  return map;
}

/** Add calendar months to a YYYY-MM-DD date (day clamped to month length). */
function addCalendarMonths(dateStr, months) {
  if (!dateStr) return null;
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)
  ).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${target.getUTCFullYear()}-${pad(target.getUTCMonth() + 1)}-${pad(day)}`;
}

/** Probation flag + estimated end (DOJ + PROBATION_MONTHS). */
function probationFromEmployee(employee) {
  const status = employee.fields.EmploymentStatus || 'Full-time';
  const onProbation = status === 'Probation';
  const dateOfJoining = employee.fields.DateOfJoining
    ? String(employee.fields.DateOfJoining).slice(0, 10)
    : null;
  const probationEndsOn =
    onProbation && dateOfJoining ? addCalendarMonths(dateOfJoining, PROBATION_MONTHS) : null;
  return {
    employmentStatus: status,
    onProbation,
    dateOfJoining,
    probationEndsOn,
  };
}

/** Average "HH:mm" from a list of time-of-day strings; null if none. */
function averageHm(times) {
  const mins = [];
  for (const t of times || []) {
    const m = parseHhMm(t);
    if (m != null) mins.push(m);
  }
  if (!mins.length) return null;
  const avg = Math.round(mins.reduce((a, b) => a + b, 0) / mins.length);
  const h = Math.floor(avg / 60) % 24;
  const m = avg % 60;
  return `${pad(h)}:${pad(m)}`;
}

/** Human leave-taken label e.g. "Annual 2, Sick 1". */
function formatLeaveTaken(taken) {
  const parts = [];
  if (taken.annual) parts.push(`Annual ${taken.annual}`);
  if (taken.sick) parts.push(`Sick ${taken.sick}`);
  if (taken.casual) parts.push(`Casual ${taken.casual}`);
  return parts.length ? parts.join(', ') : 'None';
}

/** Human balance label e.g. "Annual 10 · Sick 5 · Casual 2". */
function formatLeaveBalances(balances) {
  const b = balances || { annual: 0, sick: 0, casual: 0 };
  return `Annual ${b.annual} · Sick ${b.sick} · Casual ${b.casual}`;
}

/**
 * Collect punch rows for a set of employees over [from, to] inclusive.
 * @returns {Promise<Array<object>>}
 */
async function buildRows(employees, from, to, teamNameById = new Map(), leaveByEmployee = null) {
  const dates = dateRangeInclusive(from, to);
  let leaveMap = leaveByEmployee;
  if (!leaveMap) {
    const loaded = await loadApprovedLeaveByEmployee(
      employees.map((e) => e.id),
      from,
      to
    );
    leaveMap = loaded.leaveByEmployee;
  }
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
 * Per-employee monthly insights from daily report rows + company calendar.
 *
 * Expected working days are the **same for everyone** in the month:
 * company Mon–Fri days in range − public holidays (leave does NOT reduce expected).
 * Leave taken is reported separately with remaining balances.
 *
 * Worked days = onsite + remote days (both count as working days), plus
 * still-checked-in / present without a mode / Half Day.
 */
function buildEmployeeMonthlyInsight(employee, empRows, opts) {
  const {
    holidaySet,
    leaveSet,
    shift,
    leaveMeta = emptyLeaveMeta(),
    leaveBalances = null,
    strikeInfo = null,
  } = opts;
  // Shift length only (for hours). Expected *days* use org Mon–Fri, not per-person leave.
  const shiftHours = shiftLengthHours(shift);
  const shiftMinutes = shiftHours == null ? null : Math.round(shiftHours * 60);
  const companyWorkingDays = new Set(DEFAULT_WORKING_DAYS);

  let expectedWorkingDays = 0;
  for (const row of empRows) {
    const d = row.date;
    if (holidaySet.has(d)) continue;
    if (row.status === 'Holiday') continue;
    if (!companyWorkingDays.has(dowForDateStr(d))) continue;
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
  let halfDays = 0;
  let absentDays = 0;
  let leaveDays = 0;
  let holidayDays = 0;
  let lateDays = 0;
  let stillCheckedInDays = 0;
  let noRecordDays = 0;
  const checkInTimes = [];
  const checkOutTimes = [];
  /** Unique dates counted as "worked" (office + remote both qualify). */
  const workedDayDates = new Set();

  for (const row of empRows) {
    if (row.workedMinutes != null) workedMinutes += Number(row.workedMinutes) || 0;
    if (row.overtimeHours != null) overtimeHours += Number(row.overtimeHours) || 0;
    if (row.isLate) {
      lateDays += 1;
      lateMinutes += Number(row.lateByMinutes) || 0;
    }
    if (row.mode === 'Office') onsiteDays += 1;
    else if (row.mode === 'Remote') remoteDays += 1;

    if (row.checkInTime) checkInTimes.push(row.checkInTime);
    if (row.checkOutTime) checkOutTimes.push(row.checkOutTime);

    const status = row.status || '';
    switch (status) {
      case 'Present':
        presentDays += 1;
        workedDayDates.add(row.date);
        break;
      case 'Half Day':
        halfDays += 1;
        workedDayDates.add(row.date);
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
        workedDayDates.add(row.date);
        break;
      case 'No record':
        noRecordDays += 1;
        break;
      default:
        break;
    }

    // Office + Remote always count as a working day (even if status is unusual).
    if (row.mode === 'Office' || row.mode === 'Remote') {
      if (status !== 'On Leave' && status !== 'Holiday') {
        workedDayDates.add(row.date);
      }
    }
  }

  // Prefer leave meta day count when rows don't all mark "On Leave".
  if (leaveSet && leaveSet.size > leaveDays) {
    leaveDays = leaveSet.size;
  }

  const workedHours = round2(workedMinutes / 60);
  const varianceMinutes = expectedMinutes == null ? null : workedMinutes - expectedMinutes;
  const varianceHours = varianceMinutes == null ? null : round2(varianceMinutes / 60);
  // Worked = unique days present in office or remote (remote counts as work).
  const workedDays = workedDayDates.size;
  const avgCheckInTime = averageHm(checkInTimes);
  const avgCheckOutTime = averageHm(checkOutTimes);
  const probation = probationFromEmployee(employee);
  const balances = leaveBalances || { annual: 0, sick: 0, casual: 0 };
  const taken = leaveMeta.taken || { annual: 0, sick: 0, casual: 0 };
  const strikeCount = strikeInfo ? Number(strikeInfo.strikeCount || 0) : 0;
  const lateCount =
    strikeInfo && strikeInfo.lateCount != null ? Number(strikeInfo.lateCount) : lateDays;

  return {
    employeeId: employee.id,
    employeeName: employee.fields.Name || null,
    teamId: (employee.fields.Team && employee.fields.Team[0]) || null,
    teamName: (empRows[0] && empRows[0].teamName) || null,
    shiftLengthHours: shiftHours,
    // Days-focused (primary for monthly manager review)
    workedDays,
    expectedWorkingDays,
    presentDays,
    halfDays,
    absentDays,
    leaveDays,
    holidayDays,
    lateDays: lateCount,
    lateCount,
    strikeCount,
    strikeItems: strikeInfo && Array.isArray(strikeInfo.items) ? strikeInfo.items : [],
    avgCheckInTime,
    avgCheckOutTime,
    // Hours (kept for variance / deeper review)
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
    lateMinutes,
    overtimeHours: round2(overtimeHours),
    stillCheckedInDays,
    noRecordDays,
    // Probation
    employmentStatus: probation.employmentStatus,
    onProbation: probation.onProbation,
    dateOfJoining: probation.dateOfJoining,
    probationEndsOn: probation.probationEndsOn,
    // Leave taken this period + remaining balances
    leaveTaken: taken,
    leaveTakenLabel: formatLeaveTaken(taken),
    leaveItems: leaveMeta.items || [],
    leaveBalances: balances,
    leaveBalancesLabel: formatLeaveBalances(balances),
  };
}

/**
 * Build monthly insights for a set of employees given already-built daily rows.
 */
function buildMonthlyInsights(
  employees,
  rows,
  { holidaySet, leaveByEmployee, shiftById, leaveMetaByEmployee, balanceByEmployee, strikeByEmployee }
) {
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
      return buildEmployeeMonthlyInsight(emp, empRows, {
        holidaySet,
        leaveSet,
        shift,
        leaveMeta: (leaveMetaByEmployee && leaveMetaByEmployee.get(emp.id)) || emptyLeaveMeta(),
        leaveBalances: (balanceByEmployee && balanceByEmployee.get(emp.id)) || null,
        strikeInfo: (strikeByEmployee && strikeByEmployee.get(emp.id)) || null,
      });
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
 * Monthly reports include per-employee insights (worked vs expected days,
 * leave taken/balances, avg check-in/out, late/strike counts, probation).
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
  const scopeIds = scopeEmployees.map((e) => e.id);
  const { leaveByEmployee, leaveMetaByEmployee } = await loadApprovedLeaveByEmployee(
    scopeIds,
    from,
    to
  );
  const allRows = await buildRows(scopeEmployees, from, to, teamNameById, leaveByEmployee);
  const teamsPayload = groupRowsByTeam(allRows, teams);

  const includeInsights = period === 'monthly';
  let holidaySet = new Set();
  let shiftById = new Map();
  let balanceByEmployee = new Map();
  let strikeByEmployee = new Map();
  let allInsights = null;
  /** @type {Map<string, object>} employeeId → pdf attachment payload */
  let pdfByEmployeeId = new Map();
  if (includeInsights) {
    const yearMonth = from.slice(0, 7);
    holidaySet = await Holiday.dateSet(from, to);
    shiftById = await loadShiftById(scopeEmployees);
    balanceByEmployee = await loadLeaveBalancesByEmployee(scopeIds);
    strikeByEmployee = await loadMonthlyStrikesByEmployee(scopeIds, yearMonth);
    const baseInsights = buildMonthlyInsights(scopeEmployees, allRows, {
      holidaySet,
      leaveByEmployee,
      shiftById,
      leaveMetaByEmployee,
      balanceByEmployee,
      strikeByEmployee,
    });
    // One PDF per employee for monthly only (shared across recipients).
    allInsights = await monthlyReportPdfService.attachMonthlyPdfs(baseInsights, { from, to });
    pdfByEmployeeId = new Map(
      allInsights.map((i) => [i.employeeId, i.pdf]).filter(([id]) => id)
    );
  }

  for (const recipient of recipients) {
    const employees = await scopedEmployees(recipient, teamIds.length ? teamIds : null);
    const rows = employees.length
      ? await buildRows(employees, from, to, teamNameById, leaveByEmployee)
      : [];
    let insights = null;
    if (includeInsights && employees.length) {
      // Prefer org-wide PDF-enriched insights; fall back to recompute if not in scope.
      const byId = new Map((allInsights || []).map((i) => [i.employeeId, i]));
      insights = employees
        .map((e) => byId.get(e.id))
        .filter(Boolean)
        .sort((a, b) => {
          const byTeam = String(a.teamName || '').localeCompare(String(b.teamName || ''));
          if (byTeam !== 0) return byTeam;
          return String(a.employeeName || '').localeCompare(String(b.employeeName || ''));
        });
      // Anyone not in org-wide list (shouldn't happen) gets a fresh insight + PDF.
      if (insights.length !== employees.length) {
        const missing = employees.filter((e) => !byId.has(e.id));
        if (missing.length) {
          const extra = await monthlyReportPdfService.attachMonthlyPdfs(
            buildMonthlyInsights(missing, rows, {
              holidaySet,
              leaveByEmployee,
              shiftById,
              leaveMetaByEmployee,
              balanceByEmployee,
              strikeByEmployee,
            }),
            { from, to }
          );
          insights = [...insights, ...extra].sort((a, b) => {
            const byTeam = String(a.teamName || '').localeCompare(String(b.teamName || ''));
            if (byTeam !== 0) return byTeam;
            return String(a.employeeName || '').localeCompare(String(b.employeeName || ''));
          });
        }
      }
    }

    const monthlyPdfs = includeInsights
      ? (insights || []).map((i) => i.pdf).filter(Boolean)
      : [];

    recipientReports.push({
      recipientId: recipient.id,
      name: recipient.fields.Name || null,
      email: recipient.fields.Email || null,
      role: recipient.fields.Role || null,
      employeeCount: employees.length,
      rowCount: rows.length,
      rows,
      insights,
      pdfs: monthlyPdfs,
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
      // Monthly: one PDF attachment per employee (not used for daily/weekly).
      attachments: monthlyPdfs,
    });

    results.push({
      recipientId: recipient.id,
      name: recipient.fields.Name || null,
      email,
      role: recipient.fields.Role || null,
      employeeCount: employees.length,
      rowCount: rows.length,
      pdfCount: monthlyPdfs.length,
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
    pdfCount: pdfByEmployeeId.size,
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
  PROBATION_MONTHS,
  averageHm,
  addCalendarMonths,
};
