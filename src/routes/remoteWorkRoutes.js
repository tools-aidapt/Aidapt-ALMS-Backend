'use strict';

const express = require('express');
const ctrl = require('../controllers/remoteWorkController');
const { authenticate, requireRoleOrLeadership, ROLES } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

const router = express.Router();

// Public, token-gated email-link decision — MUST precede the auth guard below.
router.get(
  '/requests/:id/decide',
  validate(ctrl.schemas.decideQuery, 'query'),
  ctrl.decide
);

router.use(authenticate);

router.post('/requests', validate(ctrl.schemas.submit), ctrl.submit);
router.get('/requests', validate(ctrl.schemas.listQuery, 'query'), ctrl.list);
router.get('/pending-for-approver', ctrl.listPendingForApprover);
router.get('/requests/:id', ctrl.getOne);
router.patch('/requests/:id', validate(ctrl.schemas.update), ctrl.update);
router.delete('/requests/:id', ctrl.remove);
router.patch(
  '/requests/:id/approve',
  requireRoleOrLeadership(ROLES.MANAGER, ROLES.HR_ADMIN),
  ctrl.approve
);
router.patch(
  '/requests/:id/reject',
  requireRoleOrLeadership(ROLES.MANAGER, ROLES.HR_ADMIN),
  ctrl.reject
);

module.exports = router;
