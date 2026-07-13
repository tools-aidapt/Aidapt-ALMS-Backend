'use strict';

const { makeModel } = require('./_base');

const OfficeConfig = makeModel({
  table: 'office_config',
  columns: {
    Label: { col: 'label' },
    Latitude: { col: 'latitude' },
    Longitude: { col: 'longitude' },
    RadiusMeters: { col: 'radius_meters' },
  },
});

/** OfficeConfig is a single-row table. Return that row (or null). */
OfficeConfig.getSingleton = async function getSingleton() {
  const rows = await this.selectWhere('', [], 'ORDER BY id LIMIT 1');
  return rows[0] || null;
};

module.exports = OfficeConfig;
