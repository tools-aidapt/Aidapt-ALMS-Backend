'use strict';

const { z } = require('zod');
const { asyncHandler } = require('../utils/asyncHandler');
const financeService = require('../services/financeService');

const schemas = {
  listQuery: z.object({
    month: z
      .string()
      .regex(/^\d{4}-\d{2}$/, 'expected YYYY-MM')
      .optional(),
    year: z
      .string()
      .regex(/^\d{4}$/, 'expected YYYY')
      .optional(),
  }),
  idParam: z.object({
    id: z.string().uuid(),
  }),
  attachmentParam: z.object({
    id: z.string().uuid(),
    attachmentId: z.string().min(1).max(200),
  }),
};

function read(req, source) {
  if (req.validated && req.validated[source]) return req.validated[source];
  return req[source];
}

const list = asyncHandler(async (req, res) => {
  const { month, year } = read(req, 'query');
  res.json({ data: await financeService.listGrouped({ month, year }) });
});

const getOne = asyncHandler(async (req, res) => {
  res.json({ data: await financeService.getOne(req.params.id) });
});

const sync = asyncHandler(async (req, res) => {
  res.json({ data: await financeService.sync() });
});

const attachment = asyncHandler(async (req, res) => {
  await financeService.streamAttachment(req.params.id, req.params.attachmentId, res);
});

module.exports = { list, getOne, sync, attachment, schemas };
