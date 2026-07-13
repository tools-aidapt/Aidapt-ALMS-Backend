'use strict';

const express = require('express');
const ctrl = require('../controllers/adminController');
const { authenticate, requireRole, ROLES } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

const router = express.Router();

router.use(authenticate, requireRole(ROLES.HR_ADMIN));

router.patch('/punches/:id', validate(ctrl.schemas.regularize), ctrl.regularizePunch);
router.get(
  '/regularization-log',
  validate(ctrl.schemas.logQuery, 'query'),
  ctrl.regularizationLog
);

module.exports = router;
