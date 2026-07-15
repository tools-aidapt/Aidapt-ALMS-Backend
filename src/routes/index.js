'use strict';

const express = require('express');

const authRoutes = require('./authRoutes');
const employeeRoutes = require('./employeeRoutes');
const shiftRoutes = require('./shiftRoutes');
const officeConfigRoutes = require('./officeConfigRoutes');
const attendanceRoutes = require('./attendanceRoutes');
const leaveRoutes = require('./leaveRoutes');
const holidayRoutes = require('./holidayRoutes');
const adminRoutes = require('./adminRoutes');
const dashboardRoutes = require('./dashboardRoutes');
const jobsRoutes = require('./jobsRoutes');

const router = express.Router();

router.get('/health', (req, res) => res.json({ data: { status: 'ok' } }));

router.use('/auth', authRoutes);
router.use('/employees', employeeRoutes);
router.use('/shifts', shiftRoutes);
router.use('/office-config', officeConfigRoutes);
router.use('/attendance', attendanceRoutes);
router.use('/leave', leaveRoutes);
router.use('/holidays', holidayRoutes);
router.use('/admin', adminRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/jobs', jobsRoutes);

module.exports = router;
