'use strict';

const express = require('express');
const ctrl = require('../controllers/teamController');
const { authenticate, requireRole, ROLES } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

const router = express.Router();

router.use(authenticate);

router.get('/', ctrl.list);
router.get('/:id', ctrl.getOne);
router.post('/', requireRole(ROLES.HR_ADMIN), validate(ctrl.schemas.create), ctrl.create);
router.patch('/:id', requireRole(ROLES.HR_ADMIN), validate(ctrl.schemas.update), ctrl.update);
router.delete('/:id', requireRole(ROLES.HR_ADMIN), ctrl.remove);

module.exports = router;
