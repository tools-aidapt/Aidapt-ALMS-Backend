'use strict';

const { z } = require('zod');
const { asyncHandler } = require('../utils/asyncHandler');
const absentMarker = require('../jobs/absentMarker');
const attendanceReports = require('../jobs/attendanceReports');
const attendanceReminders = require('../jobs/attendanceReminders');
const financeService = require('../services/financeService');

const schemas = {
  markAbsent: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD').optional(),
  }),
  attendanceReport: z.object({
    period: z.enum(['daily', 'weekly', 'monthly']),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD').optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD').optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD').optional(),
    force: z.boolean().optional(),
    // Filter to one or more teams. Omit = all active employees (HR view in payload).
    teamIds: z.array(z.string().uuid()).min(1).optional(),
  }),
  attendanceReminders: z.any().optional().transform(() => ({})),
};

const markAbsent = asyncHandler(async (req, res) => {
  const result = await absentMarker.markAbsentees(req.body.date);
  res.json({ data: result });
});

const attendanceReport = asyncHandler(async (req, res) => {
  const { period, date, from, to, force, teamIds } = req.body;
  try {
    const result = await attendanceReports.runAttendanceReport(period, {
      date,
      from,
      to,
      force: Boolean(force),
      teamIds,
    });
    res.json({ data: result });
  } catch (err) {
    if (err && err.code === 'TEAM_NOT_FOUND') {
      return res.status(400).json({ error: { code: err.code, message: err.message } });
    }
    throw err;
  }
});

const attendanceRemindersRun = asyncHandler(async (req, res) => {
  const result = await attendanceReminders.runShiftReminders();
  res.json({ data: result });
});

const syncFinance = asyncHandler(async (req, res) => {
  res.json({ data: await financeService.sync() });
});

module.exports = {
  markAbsent,
  attendanceReport,
  attendanceReminders: attendanceRemindersRun,
  syncFinance,
  schemas,
};
