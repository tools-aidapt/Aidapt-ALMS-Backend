'use strict';

const { asyncHandler } = require('../utils/asyncHandler');
const dashboardService = require('../services/dashboardService');

const get = asyncHandler(async (req, res) => {
  const data = await dashboardService.getDashboard(req.user.id);
  res.json({ data });
});

module.exports = { get };
