'use strict';

const { z } = require('zod');
const { asyncHandler } = require('../utils/asyncHandler');
const Shift = require('../models/Shift');
const { notFound } = require('../middleware/errorHandler');

const hhmm = z.string().regex(/^\d{1,2}:\d{2}$/, 'expected HH:MM');
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const schemas = {
  create: z.object({
    shiftName: z.string().min(1),
    startTime: hhmm,
    endTime: hhmm,
    graceMinutes: z.number().int().nonnegative().default(0),
    workingDays: z.array(z.enum(DAYS)).min(1),
  }),
  update: z
    .object({
      shiftName: z.string().min(1).optional(),
      startTime: hhmm.optional(),
      endTime: hhmm.optional(),
      graceMinutes: z.number().int().nonnegative().optional(),
      workingDays: z.array(z.enum(DAYS)).min(1).optional(),
    })
    .refine((o) => Object.keys(o).length > 0, { message: 'No fields to update' }),
};

function serialize(rec) {
  const f = rec.fields;
  return {
    id: rec.id,
    shiftName: f.ShiftName,
    startTime: f.StartTime,
    endTime: f.EndTime,
    graceMinutes: f.GraceMinutes ?? 0,
    workingDays: f.WorkingDays || [],
  };
}

function toFields(body) {
  const fields = {};
  if (body.shiftName !== undefined) fields.ShiftName = body.shiftName;
  if (body.startTime !== undefined) fields.StartTime = body.startTime;
  if (body.endTime !== undefined) fields.EndTime = body.endTime;
  if (body.graceMinutes !== undefined) fields.GraceMinutes = body.graceMinutes;
  if (body.workingDays !== undefined) fields.WorkingDays = body.workingDays;
  return fields;
}

const list = asyncHandler(async (req, res) => {
  const rows = await Shift.list({ sort: [{ field: 'ShiftName', direction: 'asc' }] });
  res.json({ data: rows.map(serialize) });
});

const create = asyncHandler(async (req, res) => {
  const rec = await Shift.create(toFields(req.body));
  res.status(201).json({ data: serialize(rec) });
});

const update = asyncHandler(async (req, res) => {
  const rec = await Shift.get(req.params.id);
  if (!rec) throw notFound('Shift not found');
  const updated = await Shift.update(rec.id, toFields(req.body));
  res.json({ data: serialize(updated) });
});

const remove = asyncHandler(async (req, res) => {
  const rec = await Shift.get(req.params.id);
  if (!rec) throw notFound('Shift not found');
  await Shift.remove(rec.id);
  res.json({ data: { id: rec.id, deleted: true } });
});

module.exports = { list, create, update, remove, schemas, serialize };
