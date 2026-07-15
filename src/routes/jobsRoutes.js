'use strict';

const express = require('express');
const ctrl = require('../controllers/jobsController');
const { requireJobSecret } = require('../middleware/jobAuth');
const { validate } = require('../middleware/validate');

const router = express.Router();

// Machine-triggered (n8n / pg_cron), authenticated by the shared job secret —
// not user JWT. Trigger daily at 23:30 Asia/Karachi.
router.post('/mark-absent', requireJobSecret, validate(ctrl.schemas.markAbsent), ctrl.markAbsent);

module.exports = router;
