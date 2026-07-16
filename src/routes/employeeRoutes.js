'use strict';

const express = require('express');
const ctrl = require('../controllers/employeeController');
const { authenticate, requireRole, ROLES } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

const router = express.Router();

router.use(authenticate);

router.get('/', requireRole(ROLES.HR_ADMIN, ROLES.MANAGER), ctrl.list);
router.get('/:id', ctrl.getOne); // self / HR Admin / Manager — enforced in controller
router.post('/', requireRole(ROLES.HR_ADMIN), validate(ctrl.schemas.create), ctrl.create);
router.patch('/:id', requireRole(ROLES.HR_ADMIN), validate(ctrl.schemas.update), ctrl.update);
router.patch(
  '/:id/status',
  requireRole(ROLES.HR_ADMIN),
  validate(ctrl.schemas.setStatus),
  ctrl.setStatus
);
router.delete('/:id', requireRole(ROLES.HR_ADMIN), ctrl.remove);

module.exports = router;
