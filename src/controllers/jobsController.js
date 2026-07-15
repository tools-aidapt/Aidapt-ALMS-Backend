'use strict';

const { z } = require('zod');
const { asyncHandler } = require('../utils/asyncHandler');
const absentMarker = require('../jobs/absentMarker');

const schemas = {
  markAbsent: z.object({
    // Optional — defaults to today (PKT). Useful for backfilling a past date.
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD').optional(),
  }),
};

// Runs the idempotent absent-marker for the given date (default: today PKT).
const markAbsent = asyncHandler(async (req, res) => {
  const result = await absentMarker.markAbsentees(req.body.date);
  res.json({ data: result });
});

module.exports = { markAbsent, schemas };
