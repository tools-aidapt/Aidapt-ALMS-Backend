'use strict';

const express = require('express');
const ctrl = require('../controllers/regularizationController');
const { authenticate, requireRole, ROLES } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

const router = express.Router();

router.use(authenticate);

router.post('/', validate(ctrl.schemas.submit), ctrl.submit);
router.get('/', validate(ctrl.schemas.listQuery, 'query'), ctrl.list);
router.get('/:id', ctrl.getOne);
router.patch('/:id', validate(ctrl.schemas.update), ctrl.update); // owner edits own pending request
router.delete('/:id', ctrl.remove); // owner cancels own pending request
router.patch('/:id/approve', requireRole(ROLES.MANAGER, ROLES.HR_ADMIN), ctrl.approve);
router.patch('/:id/reject', requireRole(ROLES.MANAGER, ROLES.HR_ADMIN), ctrl.reject);

module.exports = router;
