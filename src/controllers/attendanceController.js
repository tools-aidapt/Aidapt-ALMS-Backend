'use strict';

const { z } = require('zod');
const { asyncHandler } = require('../utils/asyncHandler');
const attendanceService = require('../services/attendanceService');
const { ROLES } = require('../middleware/auth');
const { forbidden } = require('../middleware/errorHandler');

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
};

const checkIn = asyncHandler(async (req, res) => {
  const punch = await attendanceService.checkIn(req.user.id, req.body);
  res.status(201).json({ data: punch });
});

const checkOut = asyncHandler(async (req, res) => {
  const punch = await attendanceService.checkOut(req.user.id);
  res.json({ data: punch });
});

const list = asyncHandler(async (req, res) => {
  const filters = { ...req.query };
  // Employees may only read their own attendance; managers/HR admins may
  // filter by any employee.
  if (req.user.role === ROLES.EMPLOYEE) {
    filters.employeeId = req.user.id;
  }
  const rows = await attendanceService.list(filters);
  res.json({ data: rows });
});

const getOne = asyncHandler(async (req, res) => {
  const punch = await attendanceService.getById(req.params.id);
  if (req.user.role === ROLES.EMPLOYEE && !punch.employee.includes(req.user.id)) {
    throw forbidden('Not your attendance record');
  }
  res.json({ data: punch });
});

// Overview for the current user by default. Managers/HR Admins may pass
// ?employeeId= to view someone else's; a plain Employee is locked to self.
const overview = asyncHandler(async (req, res) => {
  let employeeId = req.user.id;
  if (req.query.employeeId && req.query.employeeId !== req.user.id) {
    if (req.user.role === ROLES.EMPLOYEE) throw forbidden('Not your attendance record');
    employeeId = req.query.employeeId;
  }
  const data = await attendanceService.overview({
    employeeId,
    from: req.query.from,
    to: req.query.to,
  });
  res.json({ data });
});

module.exports = { checkIn, checkOut, list, getOne, overview, schemas };
