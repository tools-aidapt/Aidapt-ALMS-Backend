'use strict';

const { z } = require('zod');
const { asyncHandler } = require('../utils/asyncHandler');
const AttendancePunch = require('../models/AttendancePunch');
const RegularizationLog = require('../models/RegularizationLog');
const Employee = require('../models/Employee');
const Shift = require('../models/Shift');
const attendanceService = require('../services/attendanceService');
const strikeService = require('../services/strikeService');
const { shiftLengthHours, computeWorked, computeLateness } = require('../utils/attendanceCalc');
const { badRequest, notFound } = require('../middleware/errorHandler');

/**
 * Editable punch fields for regularization, mapped from request key to the
 * field name. Worked hours/minutes/overtime are NOT editable — they are always
 * derived from the (possibly corrected) check-in/out times, so they can never
 * be set to a stale or bad value.
 */
const EDITABLE = {
  checkInTime: 'CheckInTime',
  checkOutTime: 'CheckOutTime',
  status: 'Status',
  mode: 'Mode',
  isLate: 'IsLate',
  lateByMinutes: 'LateByMinutes',
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

  // Resolve the final timestamps after this edit, and reject the invalid state
  // of a check-out without a check-in (the source of the epoch-difference bug).
  const finalCheckIn = 'checkInTime' in req.body ? req.body.checkInTime : punch.fields.CheckInTime;
  const finalCheckOut = 'checkOutTime' in req.body ? req.body.checkOutTime : punch.fields.CheckOutTime;
  if (finalCheckOut && !finalCheckIn) {
    throw badRequest('Cannot set a check-out time without a check-in', 'VALIDATION_ERROR');
  }

  const changes = [];
  const fieldUpdates = {};

  for (const [key, field] of Object.entries(EDITABLE)) {
    if (req.body[key] === undefined) continue;
    const oldValue = punch.fields[field];
    const newValue = req.body[key];
    if (normaliseForCompare(oldValue) === normaliseForCompare(newValue)) continue;
    fieldUpdates[field] = newValue;
    changes.push({
      field,
      oldValue: normaliseForCompare(oldValue),
      newValue: normaliseForCompare(newValue),
    });
  }

  // Always re-derive worked/overtime from the final timestamps (guarded — nulls
  // if either is missing) using the employee's shift length. When check-in time
  // changes, also re-derive lateness from the shift unless explicitly patched.
  const employeeId = (punch.fields.Employee || [])[0];
  let shift = null;
  let shiftLen = null;
  if (employeeId) {
    const employee = await Employee.get(employeeId);
    const shiftId = employee && (employee.fields.AssignedShift || [])[0];
    shift = shiftId ? await Shift.get(shiftId) : null;
    shiftLen = shiftLengthHours(shift);
  }

  if (finalCheckIn && shift && 'checkInTime' in req.body) {
    const lateness = computeLateness(shift, finalCheckIn);
    if (req.body.isLate === undefined) {
      if (normaliseForCompare(punch.fields.IsLate) !== normaliseForCompare(lateness.isLate)) {
        fieldUpdates.IsLate = lateness.isLate;
        changes.push({
          field: 'IsLate',
          oldValue: normaliseForCompare(punch.fields.IsLate),
          newValue: normaliseForCompare(lateness.isLate),
        });
      }
    }
    if (req.body.lateByMinutes === undefined) {
      if (
        normaliseForCompare(punch.fields.LateByMinutes) !==
        normaliseForCompare(lateness.lateByMinutes)
      ) {
        fieldUpdates.LateByMinutes = lateness.lateByMinutes;
        changes.push({
          field: 'LateByMinutes',
          oldValue: normaliseForCompare(punch.fields.LateByMinutes),
          newValue: normaliseForCompare(lateness.lateByMinutes),
        });
      }
    }
  }

  const worked = computeWorked(finalCheckIn, finalCheckOut, shiftLen);
  for (const [field, value] of [
    ['WorkedMinutes', worked.workedMinutes],
    ['WorkedHours', worked.workedHours],
    ['OvertimeHours', worked.overtimeHours],
  ]) {
    if (normaliseForCompare(punch.fields[field]) === normaliseForCompare(value)) continue;
    fieldUpdates[field] = value;
    changes.push({
      field,
      oldValue: normaliseForCompare(punch.fields[field]),
      newValue: normaliseForCompare(value),
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

  if (employeeId && punch.fields.Date) {
    await strikeService.recomputeForEmployeeMonth(employeeId, punch.fields.Date);
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
