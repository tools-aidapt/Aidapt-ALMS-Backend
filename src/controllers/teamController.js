'use strict';

const { z } = require('zod');
const { asyncHandler } = require('../utils/asyncHandler');
const { query } = require('../config/db');
const Team = require('../models/Team');
const Employee = require('../models/Employee');
const Shift = require('../models/Shift');
const LeaveBalance = require('../models/LeaveBalance');
const AttendancePunch = require('../models/AttendancePunch');
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
 * Enrich team members with shift, leave balances, today's punch, and on-leave flag.
 * @param {Array} members Employee records
 * @returns {Promise<Array<object>>}
 */
async function enrichMembers(members) {
  if (!members.length) return [];

  const ids = members.map((m) => m.id);
  const today = todayPktDateStr();
  const shiftIds = [
    ...new Set(members.map((m) => (m.fields.AssignedShift || [])[0]).filter(Boolean)),
  ];

  const [shifts, balances, punches, onLeaveResult] = await Promise.all([
    shiftIds.length
      ? Promise.all(shiftIds.map((id) => Shift.get(id))).then((rows) => rows.filter(Boolean))
      : Promise.resolve([]),
    LeaveBalance.selectWhere('employee_id = ANY($1::uuid[])', [ids]),
    AttendancePunch.forEmployeesOnDate(ids, today),
    query(
      `SELECT employee_id, leave_type
       FROM leave_requests
       WHERE employee_id = ANY($1::uuid[])
         AND status = 'Approved'
         AND from_date <= $2::date
         AND to_date >= $2::date`,
      [ids, today]
    ),
  ]);

  const shiftById = new Map(shifts.map((s) => [s.id, s]));
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
    const f = m.fields;
    const shiftId = (f.AssignedShift || [])[0] || null;
    const shift = shiftId ? shiftById.get(shiftId) : null;
    const bal = balanceByEmp.get(m.id);
    const punch = punchByEmp.get(m.id) || null;
    const leaveType = leaveByEmp.get(m.id) || null;
    const onLeave = Boolean(leaveType) || (punch && punch.fields.Status === 'On Leave');
    return {
      id: m.id,
      name: f.Name,
      photoUrl: f.PhotoUrl || null,
      role: f.Role,
      employmentStatus: f.EmploymentStatus || 'Full-time',
      dateOfJoining: f.DateOfJoining || null,
      shift: shift ? { name: shift.fields.ShiftName } : null,
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

async function teamWithMembers(rec) {
  const members = await Team.findMembers(rec.id);
  const enriched = await enrichMembers(members);
  return serializeTeam(rec, enriched);
}

const list = asyncHandler(async (req, res) => {
  const rows = await Team.list({ sort: [{ field: 'Name', direction: 'asc' }] });
  const data = await Promise.all(rows.map((r) => teamWithMembers(r)));
  res.json({ data });
});

const getOne = asyncHandler(async (req, res) => {
  const rec = await Team.get(req.params.id);
  if (!rec) throw notFound('Team not found');
  res.json({ data: await teamWithMembers(rec) });
});

const create = asyncHandler(async (req, res) => {
  const body = req.body;
  if (body.leadId) {
    const lead = await Employee.get(body.leadId);
    if (!lead) throw badRequest('Lead employee not found', 'LEAD_NOT_FOUND');
  }
  try {
    const rec = await Team.create(toFields(body));
    res.status(201).json({ data: await teamWithMembers(rec) });
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
    res.json({ data: await teamWithMembers(updated) });
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

module.exports = { list, getOne, create, update, remove, schemas, serialize: serializeTeam };
