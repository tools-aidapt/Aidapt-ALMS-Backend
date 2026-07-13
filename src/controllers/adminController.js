'use strict';

const { z } = require('zod');
const { asyncHandler } = require('../utils/asyncHandler');
const AttendancePunch = require('../models/AttendancePunch');
const RegularizationLog = require('../models/RegularizationLog');
const attendanceService = require('../services/attendanceService');
const { badRequest, notFound } = require('../middleware/errorHandler');

/**
 * Editable punch fields for regularization, mapped from request keys to the
 * Airtable field name. Only these may be corrected.
 */
const EDITABLE = {
  checkInTime: 'CheckInTime',
  checkOutTime: 'CheckOutTime',
  status: 'Status',
  mode: 'Mode',
  isLate: 'IsLate',
  lateByMinutes: 'LateByMinutes',
  workedHours: 'WorkedHours',
  workedMinutes: 'WorkedMinutes',
  overtimeHours: 'OvertimeHours',
};

const schemas = {
  regularize: z
    .object({
      checkInTime: z.string().datetime().optional(),
      checkOutTime: z.string().datetime().optional(),
      status: z.enum(['Present', 'On Leave', 'Holiday', 'Absent']).optional(),
      mode: z.enum(['Office', 'Remote In']).optional(),
      isLate: z.boolean().optional(),
      lateByMinutes: z.number().int().nonnegative().optional(),
      workedHours: z.number().nonnegative().optional(),
      workedMinutes: z.number().int().nonnegative().optional(),
      overtimeHours: z.number().nonnegative().optional(),
    })
    .refine((o) => Object.keys(o).length > 0, { message: 'No fields to update' }),
  logQuery: z.object({
    punchId: z.string().optional(),
    editedBy: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
  }),
};

function normaliseForCompare(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

/**
 * PATCH a past punch. For every field whose value actually changes, write a
 * RegularizationLog row (Punch, EditedBy, FieldChanged, OldValue, NewValue).
 */
const regularizePunch = asyncHandler(async (req, res) => {
  const punch = await AttendancePunch.get(req.params.id);
  if (!punch) throw notFound('Punch not found');

  const changes = [];
  const fieldUpdates = {};

  for (const [key, airtableField] of Object.entries(EDITABLE)) {
    if (req.body[key] === undefined) continue;
    const oldValue = punch.fields[airtableField];
    const newValue = req.body[key];
    if (normaliseForCompare(oldValue) === normaliseForCompare(newValue)) continue;
    fieldUpdates[airtableField] = newValue;
    changes.push({
      field: airtableField,
      oldValue: normaliseForCompare(oldValue),
      newValue: normaliseForCompare(newValue),
    });
  }

  if (!changes.length) {
    throw badRequest('No values differ from the current record', 'NO_CHANGES');
  }

  const updated = await AttendancePunch.update(punch.id, fieldUpdates);

  // Write one audit entry per changed field. Sequential to respect rate limits.
  for (const change of changes) {
    await RegularizationLog.create({
      Punch: [punch.id],
      EditedBy: [req.user.id],
      FieldChanged: change.field,
      OldValue: change.oldValue,
      NewValue: change.newValue,
    });
  }

  res.json({
    data: { punch: attendanceService.serialize(updated), changes },
  });
});

const serializeLog = (rec) => ({
  id: rec.id,
  punch: rec.fields.Punch || [],
  editedBy: rec.fields.EditedBy || [],
  fieldChanged: rec.fields.FieldChanged || null,
  oldValue: rec.fields.OldValue ?? null,
  newValue: rec.fields.NewValue ?? null,
  timestamp: rec.fields.Timestamp || rec.createdTime,
});

const regularizationLog = asyncHandler(async (req, res) => {
  const { punchId, editedBy, from, to } = req.query;
  const rows = await RegularizationLog.query({ punchId, editedBy, from, to });
  res.json({ data: rows.map(serializeLog) });
});

module.exports = { regularizePunch, regularizationLog, schemas };
