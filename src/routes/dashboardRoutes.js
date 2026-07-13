'use strict';

const express = require('express');
const ctrl = require('../controllers/dashboardController');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate);

// Dashboard for the current user (identity, balances, today's punch, reportees).
router.get('/', ctrl.get);

module.exports = router;
