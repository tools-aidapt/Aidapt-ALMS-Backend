'use strict';

const { z } = require('zod');
const { asyncHandler } = require('../utils/asyncHandler');
const holidayService = require('../services/holidayService');

const schemas = {
  create: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'),
    name: z.string().optional(),
  }),
};

const list = asyncHandler(async (req, res) => {
  res.json({ data: await holidayService.list() });
});

const create = asyncHandler(async (req, res) => {
  const rec = await holidayService.add(req.body, req.user.id);
  res.status(201).json({ data: rec });
});

const remove = asyncHandler(async (req, res) => {
  res.json({ data: await holidayService.remove(req.params.id) });
});

module.exports = { list, create, remove, schemas };
