'use strict';

const express = require('express');
const ctrl = require('../controllers/jobsController');
const { requireJobSecret } = require('../middleware/jobAuth');
const { validate } = require('../middleware/validate');

const router = express.Router();

// Machine-triggered (n8n / pg_cron / internal cron), authenticated by JOBS_SECRET.

// Trigger daily at 23:30 Asia/Karachi (also scheduled in-process).
router.post('/mark-absent', requireJobSecret, validate(ctrl.schemas.markAbsent), ctrl.markAbsent);

// Attendance reports for Managers + HR Admin (daily / weekly / monthly).
router.post(
  '/attendance-report',
  requireJobSecret,
  validate(ctrl.schemas.attendanceReport),
  ctrl.attendanceReport
);

// Shift-based check-in / check-out reminders (also scheduled every minute).
router.post(
  '/attendance-reminders',
  requireJobSecret,
  validate(ctrl.schemas.attendanceReminders),
  ctrl.attendanceReminders
);

router.post('/sync-finance', requireJobSecret, ctrl.syncFinance);

module.exports = router;
