'use strict';

const { z } = require('zod');
const { asyncHandler } = require('../utils/asyncHandler');
const OfficeConfig = require('../models/OfficeConfig');
const env = require('../config/env');

const schemas = {
  update: z
    .object({
      label: z.string().min(1).optional(),
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
      radiusMeters: z.number().positive().optional(),
    })
    .refine((o) => Object.keys(o).length > 0, { message: 'No fields to update' }),
};

function serialize(rec) {
  if (!rec) return null;
  const f = rec.fields;
  return {
    id: rec.id,
    label: f.Label || null,
    latitude: f.Latitude ?? null,
    longitude: f.Longitude ?? null,
    radiusMeters: f.RadiusMeters ?? env.geofence.defaultRadiusMeters,
  };
}

const get = asyncHandler(async (req, res) => {
  const rec = await OfficeConfig.getSingleton();
  res.json({ data: serialize(rec) });
});

// PATCH upserts the single OfficeConfig row.
const update = asyncHandler(async (req, res) => {
  const body = req.body;
  const fields = {};
  if (body.label !== undefined) fields.Label = body.label;
  if (body.latitude !== undefined) fields.Latitude = body.latitude;
  if (body.longitude !== undefined) fields.Longitude = body.longitude;
  if (body.radiusMeters !== undefined) fields.RadiusMeters = body.radiusMeters;

  const existing = await OfficeConfig.getSingleton();
  const rec = existing
    ? await OfficeConfig.update(existing.id, fields)
    : await OfficeConfig.create(fields);
  res.json({ data: serialize(rec) });
});

module.exports = { get, update, schemas };
