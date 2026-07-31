'use strict';

const Employee = require('../models/Employee');
const Team = require('../models/Team');
const AttendancePunch = require('../models/AttendancePunch');
const { claimReport } = require('../models/AttendanceNotificationLog');
const emailService = require('./emailService');
const {
  todayPktDateStr,
  dateRangeInclusive,
  formatHoursMinutes,
  pktHm,
  dowForDateStr,
} = require('../utils/dateUtils');
const { ROLES } = require('../middleware/auth');

function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * Build one attendance row for a punch (or absent placeholder).
 */
function rowFromPunch(employee, punch, dateStr, teamName = null) {
  const f = punch ? punch.fields : null;
  const workedMinutes = f && f.WorkedMinutes != null ? Number(f.WorkedMinutes) : null;
  return {
    employeeId: employee.id,
    employeeName: employee.fields.Name || null,
    teamId: (employee.fields.Team && employee.fields.Team[0]) || null,
    teamName,
    date: dateStr,
    checkInTime: f && f.CheckInTime ? pktHm(f.CheckInTime) : null,
    checkOutTime: f && f.CheckOutTime ? pktHm(f.CheckOutTime) : null,
    status: f ? f.Status || 'Present' : 'No record',
    workedMinutes,
    workedDuration: workedMinutes == null ? null : formatHoursMinutes(workedMinutes),
    isLate: f ? Boolean(f.IsLate) : false,
  };
}

/**
 * Collect punch rows for a set of employees over [from, to] inclusive.
 * @returns {Promise<Array<object>>}
 */
async function buildRows(employees, from, to, teamNameById = new Map()) {
  const dates = dateRangeInclusive(from, to);
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
    for (const d of dates) {
      rows.push(rowFromPunch(emp, byDate.get(d) || null, d, teamName));
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

/** Recipients for a report run. When teamIds given: HR Admins + leads of those teams. */
async function reportRecipients(teamIds) {
  if (teamIds && teamIds.length) {
    const teams = await Team.findByIds(teamIds);
    const leadIds = teams.map((t) => (t.fields.Lead && t.fields.Lead[0]) || null).filter(Boolean);
    const hr = await Employee.selectWhere(
      "status = 'Active' AND role = 'HR Admin' AND email IS NOT NULL AND email <> ''",
      [],
      'ORDER BY name ASC'
    );
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

  return Employee.selectWhere(
    "status = 'Active' AND role IN ('Manager', 'HR Admin') AND email IS NOT NULL AND email <> ''",
    [],
    'ORDER BY role ASC, name ASC'
  );
}

/**
 * Employees in scope for a recipient.
 * - Optional teamIds filter applied first
 * - HR Admin → all (filtered) active
 * - Team lead → their team members
 * - Manager → direct reports (fallback when not a lead / no team filter)
 */
async function scopedEmployees(recipient, teamIds) {
  if (teamIds && teamIds.length) {
    const employees = await Employee.findByTeamIds(teamIds);
    if (recipient.fields.Role === ROLES.HR_ADMIN) return employees;

    // Team lead: only members of teams they lead (intersected with filter).
    const led = await Team.selectWhere('lead_id = $1', [recipient.id], '');
    const ledIds = new Set(led.map((t) => t.id));
    if (ledIds.size) {
      return employees.filter((e) => {
        const tid = (e.fields.Team && e.fields.Team[0]) || null;
        return tid && ledIds.has(tid);
      });
    }
    return Employee.findDirectReports(recipient.id).then((reps) =>
      reps.filter((e) => {
        const tid = (e.fields.Team && e.fields.Team[0]) || null;
        return tid && teamIds.includes(tid);
      })
    );
  }

  if (recipient.fields.Role === ROLES.HR_ADMIN) {
    return Employee.selectWhere("status = 'Active'", [], 'ORDER BY name ASC');
  }

  // Prefer team membership when this manager leads a team.
  const led = await Team.selectWhere('lead_id = $1', [recipient.id], '');
  if (led.length) {
    const ids = led.map((t) => t.id);
    return Employee.findByTeamIds(ids);
  }
  return Employee.findDirectReports(recipient.id);
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

/**
 * Send attendance report emails to Managers / team leads / HR Admin.
 * Also returns check-in/out rows (optionally filtered + grouped by team).
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

  // Build the full (filtered) dataset once for the API response.
  const scopeEmployees = teamIds.length
    ? await Employee.findByTeamIds(teamIds)
    : await Employee.selectWhere("status = 'Active'", [], 'ORDER BY name ASC');
  const allRows = await buildRows(scopeEmployees, from, to, teamNameById);
  const teamsPayload = groupRowsByTeam(allRows, teams);

  for (const recipient of recipients) {
    if (!opts.force) {
      const claimed = await claimReport({
        recipientId: recipient.id,
        kind,
        forDate: to,
        periodKey: key,
      });
      if (!claimed) {
        results.push({ recipientId: recipient.id, skipped: 'already_sent' });
        continue;
      }
    }

    const employees = await scopedEmployees(recipient, teamIds.length ? teamIds : null);
    if (!employees.length) {
      results.push({ recipientId: recipient.id, skipped: 'no_employees' });
      continue;
    }

    const rows = await buildRows(employees, from, to, teamNameById);
    const email = recipient.fields.Email;
    if (!email) {
      results.push({ recipientId: recipient.id, skipped: 'no_email' });
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
    });

    results.push({
      recipientId: recipient.id,
      email,
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
    results,
  };
}

module.exports = {
  sendAttendanceReports,
  buildRows,
  weekBoundsPkt,
  monthBoundsPkt,
  periodLabel,
};
