'use strict';

const express = require('express');
const ctrl = require('../controllers/officeConfigController');
const { authenticate, requireRole, ROLES } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

const router = express.Router();

router.use(authenticate);

router.get('/', ctrl.get);
router.patch('/', requireRole(ROLES.HR_ADMIN), validate(ctrl.schemas.update), ctrl.update);

module.exports = router;
