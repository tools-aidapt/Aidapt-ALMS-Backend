'use strict';

const { z } = require('zod');
const { asyncHandler } = require('../utils/asyncHandler');
const db = require('../config/db');
const Team = require('../models/Team');
const Employee = require('../models/Employee');
const Shift = require('../models/Shift');
const LeaveBalance = require('../models/LeaveBalance');
const AttendancePunch = require('../models/AttendancePunch');
const { ROLES } = require('../middleware/auth');
const { todayPktDateStr, pktTimeLabel } = require('../utils/dateUtils');
const { notFound, conflict, badRequest } = require('../middleware/errorHandler');

const schemas = {
  create: z.object({
    name: z.string().min(1),
    leadId: z.string().uuid().nullable().optional(),
  }),
  update: z
    .object({
      name: z.string().min(1).optional(),
      leadId: z.string().uuid().nullable().optional(),
    })
    .refine((o) => Object.keys(o).length > 0, { message: 'No fields to update' }),
};

function mapTodayPunch(punch) {
  if (!punch) {
    return {
      checkInTimePkt: null,
      checkOutTimePkt: null,
      mode: null,
      isLate: false,
      lateByMinutes: 0,
      workedMinutes: null,
      workedHours: null,
    };
  }
  const f = punch.fields;
  return {
    checkInTimePkt: pktTimeLabel(f.CheckInTime),
    checkOutTimePkt: pktTimeLabel(f.CheckOutTime),
    mode: f.Mode || null,
    isLate: Boolean(f.IsLate),
    lateByMinutes: f.LateByMinutes == null ? 0 : Number(f.LateByMinutes),
    workedMinutes: f.WorkedMinutes == null ? null : Number(f.WorkedMinutes),
    workedHours: f.WorkedHours == null ? null : Number(f.WorkedHours),
  };
}

/**
 * Whether the caller may see live punch / leave-balance detail for a team.
 * HR Admin → all teams; team lead of that team; members of that team.
 * Everyone else gets the org-chart shape only (names + membership).
 */
function canSeeTeamLiveDetail(caller, teamRec, callerTeamId) {
  if (!caller) return false;
  if (caller.role === ROLES.HR_ADMIN) return true;
  const leadId = (teamRec.fields.Lead && teamRec.fields.Lead[0]) || null;
  if (leadId && leadId === caller.id) return true;
  return Boolean(callerTeamId && callerTeamId === teamRec.id);
}

/**
 * Enrich team members with shift, leave balances, today's punch, and on-leave flag.
 * When `includeLiveDetail` is false, only org-chart fields are populated; balances,
 * onLeave, leaveType, and todayPunch are null so live attendance stays gated.
 *
 * @param {Array} members Employee records
 * @param {{ includeLiveDetail?: boolean }} [opts]
 * @returns {Promise<Array<object>>}
 */
async function enrichMembers(members, { includeLiveDetail = true } = {}) {
  if (!members.length) return [];

  const ids = members.map((m) => m.id);
  const shiftIds = [
    ...new Set(members.map((m) => (m.fields.AssignedShift || [])[0]).filter(Boolean)),
  ];

  const shifts = shiftIds.length
    ? await Promise.all(shiftIds.map((id) => Shift.get(id))).then((rows) => rows.filter(Boolean))
    : [];
  const shiftById = new Map(shifts.map((s) => [s.id, s]));

  const baseMember = (m) => {
    const f = m.fields;
    const shiftId = (f.AssignedShift || [])[0] || null;
    const shift = shiftId ? shiftById.get(shiftId) : null;
    return {
      id: m.id,
      name: f.Name,
      photoUrl: f.PhotoUrl || null,
      role: f.Role,
      employmentStatus: f.EmploymentStatus || 'Full-time',
      dateOfJoining: f.DateOfJoining || null,
      shift: shift ? { name: shift.fields.ShiftName } : null,
    };
  };

  if (!includeLiveDetail) {
    return members.map((m) => ({
      ...baseMember(m),
      balances: null,
      onLeave: null,
      leaveType: null,
      todayPunch: null,
    }));
  }

  const today = todayPktDateStr();
  const [balances, punches, onLeaveResult] = await Promise.all([
    LeaveBalance.selectWhere('employee_id = ANY($1::uuid[])', [ids]),
    AttendancePunch.forEmployeesOnDate(ids, today),
    db.query(
      `SELECT employee_id, leave_type
       FROM leave_requests
       WHERE employee_id = ANY($1::uuid[])
         AND status = 'Approved'
         AND from_date <= $2::date
         AND to_date >= $2::date`,
      [ids, today]
    ),
  ]);

  const balanceByEmp = new Map();
  for (const b of balances) {
    const eid = (b.fields.Employee || [])[0];
    if (eid) balanceByEmp.set(eid, b);
  }
  const punchByEmp = new Map();
  for (const p of punches) {
    const eid = (p.fields.Employee || [])[0];
    if (eid) punchByEmp.set(eid, p);
  }
  const leaveByEmp = new Map();
  for (const row of onLeaveResult.rows) {
    leaveByEmp.set(row.employee_id, row.leave_type || null);
  }

  return members.map((m) => {
    const bal = balanceByEmp.get(m.id);
    const punch = punchByEmp.get(m.id) || null;
    const leaveType = leaveByEmp.get(m.id) || null;
    const onLeave = Boolean(leaveType || (punch && punch.fields.Status === 'On Leave'));
    return {
      ...baseMember(m),
      balances: {
        annual: Number((bal && bal.fields.Annual) || 0),
        sick: Number((bal && bal.fields.Sick) || 0),
        casual: Number((bal && bal.fields.Casual) || 0),
      },
      onLeave,
      leaveType: onLeave ? leaveType : null,
      todayPunch: mapTodayPunch(punch),
    };
  });
}

function serializeTeam(rec, membersPayload = null) {
  const f = rec.fields;
  const out = {
    id: rec.id,
    name: f.Name,
    leadId: (f.Lead && f.Lead[0]) || null,
    createdAt: f.CreatedAt || rec.createdTime,
  };
  if (membersPayload) {
    out.members = membersPayload;
    out.memberCount = membersPayload.length;
  }
  return out;
}

function toFields(body) {
  const fields = {};
  if (body.name !== undefined) fields.Name = body.name;
  if (body.leadId !== undefined) fields.Lead = body.leadId ? [body.leadId] : [];
  return fields;
}

async function resolveCallerTeamId(caller) {
  if (!caller || !caller.id) return null;
  const me = await Employee.get(caller.id);
  if (!me) return null;
  return (me.fields.Team || [])[0] || null;
}

async function teamWithMembers(rec, caller, callerTeamId) {
  const includeLiveDetail = canSeeTeamLiveDetail(caller, rec, callerTeamId);
  const members = await Team.findMembers(rec.id);
  const enriched = await enrichMembers(members, { includeLiveDetail });
  return serializeTeam(rec, enriched);
}

const list = asyncHandler(async (req, res) => {
  const callerTeamId = await resolveCallerTeamId(req.user);
  const rows = await Team.list({ sort: [{ field: 'Name', direction: 'asc' }] });
  const data = await Promise.all(rows.map((r) => teamWithMembers(r, req.user, callerTeamId)));
  res.json({ data });
});

const getOne = asyncHandler(async (req, res) => {
  const rec = await Team.get(req.params.id);
  if (!rec) throw notFound('Team not found');
  const callerTeamId = await resolveCallerTeamId(req.user);
  res.json({ data: await teamWithMembers(rec, req.user, callerTeamId) });
});

const create = asyncHandler(async (req, res) => {
  const body = req.body;
  if (body.leadId) {
    const lead = await Employee.get(body.leadId);
    if (!lead) throw badRequest('Lead employee not found', 'LEAD_NOT_FOUND');
  }
  try {
    const rec = await Team.create(toFields(body));
    const callerTeamId = await resolveCallerTeamId(req.user);
    res.status(201).json({ data: await teamWithMembers(rec, req.user, callerTeamId) });
  } catch (err) {
    if (err && err.code === '23505') throw conflict('Team name already exists', 'TEAM_NAME_EXISTS');
    throw err;
  }
});

const update = asyncHandler(async (req, res) => {
  const rec = await Team.get(req.params.id);
  if (!rec) throw notFound('Team not found');
  if (req.body.leadId) {
    const lead = await Employee.get(req.body.leadId);
    if (!lead) throw badRequest('Lead employee not found', 'LEAD_NOT_FOUND');
  }
  try {
    const updated = await Team.update(rec.id, toFields(req.body));
    const callerTeamId = await resolveCallerTeamId(req.user);
    res.json({ data: await teamWithMembers(updated, req.user, callerTeamId) });
  } catch (err) {
    if (err && err.code === '23505') throw conflict('Team name already exists', 'TEAM_NAME_EXISTS');
    throw err;
  }
});

const remove = asyncHandler(async (req, res) => {
  const rec = await Team.get(req.params.id);
  if (!rec) throw notFound('Team not found');
  await Team.remove(rec.id);
  res.json({ data: { id: rec.id, deleted: true } });
});

module.exports = {
  list,
  getOne,
  create,
  update,
  remove,
  schemas,
  serialize: serializeTeam,
  canSeeTeamLiveDetail,
  enrichMembers,
};
