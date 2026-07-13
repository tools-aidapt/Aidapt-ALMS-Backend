'use strict';

const express = require('express');
const ctrl = require('../controllers/holidayController');
const { authenticate, requireRole, ROLES } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

const router = express.Router();

router.use(authenticate);

router.get('/', ctrl.list);
router.post('/', requireRole(ROLES.HR_ADMIN), validate(ctrl.schemas.create), ctrl.create);
router.delete('/:id', requireRole(ROLES.HR_ADMIN), ctrl.remove);

module.exports = router;
