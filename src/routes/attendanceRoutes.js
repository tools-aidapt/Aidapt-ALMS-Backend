'use strict';

const express = require('express');
const ctrl = require('../controllers/attendanceController');
const { authenticate, requireRole, ROLES } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

const router = express.Router();

router.use(authenticate);

router.post(
  '/checkin',
  requireRole(ROLES.EMPLOYEE, ROLES.MANAGER, ROLES.HR_ADMIN),
  validate(ctrl.schemas.checkin),
  ctrl.checkIn
);
router.post(
  '/checkout',
  requireRole(ROLES.EMPLOYEE, ROLES.MANAGER, ROLES.HR_ADMIN),
  ctrl.checkOut
);
router.get('/overview', validate(ctrl.schemas.overviewQuery, 'query'), ctrl.overview);
router.get('/', validate(ctrl.schemas.listQuery, 'query'), ctrl.list);
router.get('/:id', ctrl.getOne);

module.exports = router;
