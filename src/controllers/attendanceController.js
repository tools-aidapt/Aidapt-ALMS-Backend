'use strict';

const { z } = require('zod');
const { asyncHandler } = require('../utils/asyncHandler');
const attendanceService = require('../services/attendanceService');
const reportService = require('../services/reportService');
const { resolveEmployeeRecordScope } = require('../utils/employeeRecordScope');
const { hasCompanyWideDataAccess } = require('../utils/leadershipAccess');
const { forbidden } = require('../middleware/errorHandler');
const { todayPktDateStr } = require('../utils/dateUtils');

const schemas = {
  checkin: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracy: z.number().nonnegative().optional(),
  }),
  listQuery: z.object({
    employeeId: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    status: z.enum(['Present', 'On Leave', 'Holiday', 'Absent']).optional(),
  }),
  overviewQuery: z.object({
    employeeId: z.string().optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD').optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD').optional(),
  }),
  monthEndReportQuery: z.object({
    month: z.string().regex(/^\d{4}-\d{2}$/, 'expected YYYY-MM').optional(),
    scope: z.enum(['self', 'all']).optional(),
  }),
};

const checkIn = asyncHandler(async (req, res) => {
  const punch = await attendanceService.checkIn(req.user.id, req.body);
  res.status(201).json({ data: punch });
});

const checkOut = asyncHandler(async (req, res) => {
  const punch = await attendanceService.checkOut(req.user.id);
  res.json({ data: punch });
});

/**
 * List punches for exactly one employee.
 * Scoping is enforced here via resolveEmployeeRecordScope (token-derived):
 * omitted employeeId ⇒ caller's own rows for every role.
 */
const list = asyncHandler(async (req, res) => {
  const employeeId = await resolveEmployeeRecordScope(req.user, req.query.employeeId);
  const rows = await attendanceService.list({
    employeeId,
    from: req.query.from,
    to: req.query.to,
    status: req.query.status,
  });
  res.json({ data: rows });
});

/**
 * Single punch by id. Same relationship check as the list matrix: owner, their
 * manager (direct report), or HR Admin. Closes the bypass where Managers could
 * read any punch UUID without a report check.
 */
const getOne = asyncHandler(async (req, res) => {
  const punch = await attendanceService.getById(req.params.id);
  const ownerId = punch.employeeId || (punch.employee && punch.employee[0]) || null;
  await resolveEmployeeRecordScope(req.user, ownerId);
  res.json({ data: punch });
});

/**
 * Month/range overview for exactly one employee — same scope matrix as list.
 * Omitted employeeId ⇒ self for every role.
 */
const overview = asyncHandler(async (req, res) => {
  const employeeId = await resolveEmployeeRecordScope(req.user, req.query.employeeId);
  const data = await attendanceService.overview({
    employeeId,
    from: req.query.from,
    to: req.query.to,
  });
  res.json({ data });
});

/**
 * On-demand month-end JSON summary.
 * Default scope=self (own report). scope=all is HR Admin / Leadership only.
 */
const monthEndReport = asyncHandler(async (req, res) => {
  const scope = req.query.scope === 'all' ? 'all' : 'self';
  if (scope === 'all' && !hasCompanyWideDataAccess(req.user)) {
    throw forbidden('Company-wide month-end report requires HR Admin or Leadership');
  }

  const month = req.query.month;
  const { from, to } = reportService.monthBoundsPkt(month ? `${month}-01` : todayPktDateStr());
  const employeeIds = scope === 'all' ? null : [req.user.id];
  const result = await reportService.getMonthEndReports({ employeeIds, from, to });
  res.json({
    data: {
      period: result.period,
      scope,
      reports: result.reports,
    },
  });
});

module.exports = { checkIn, checkOut, list, getOne, overview, monthEndReport, schemas };
