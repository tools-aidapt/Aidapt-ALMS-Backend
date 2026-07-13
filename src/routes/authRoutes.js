'use strict';

const express = require('express');
const ctrl = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

const router = express.Router();

router.post('/register', validate(ctrl.schemas.register), ctrl.register);
router.post('/login', validate(ctrl.schemas.login), ctrl.login);
router.post('/forgot-password', validate(ctrl.schemas.forgotPassword), ctrl.forgotPassword);
router.post('/verify-otp', validate(ctrl.schemas.verifyOtp), ctrl.verifyOtp);
router.post('/reset-password', validate(ctrl.schemas.resetPassword), ctrl.resetPassword);
router.post('/logout', authenticate, ctrl.logout);
router.get('/me', authenticate, ctrl.me);

module.exports = router;
