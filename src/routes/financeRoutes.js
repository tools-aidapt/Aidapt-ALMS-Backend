'use strict';

const express = require('express');
const ctrl = require('../controllers/financeController');
const { authenticate, requireRole, ROLES } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

const router = express.Router();

router.use(authenticate, requireRole(ROLES.HR_ADMIN));

router.get('/', validate(ctrl.schemas.listQuery, 'query'), ctrl.list);
router.post('/sync', ctrl.sync);
router.get(
  '/:id/attachments/:attachmentId',
  validate(ctrl.schemas.attachmentParam, 'params'),
  ctrl.attachment
);
router.get('/:id', validate(ctrl.schemas.idParam, 'params'), ctrl.getOne);

module.exports = router;
