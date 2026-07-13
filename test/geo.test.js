'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { haversineDistanceMeters } = require('../src/utils/geo');

test('haversine: zero distance for identical points', () => {
  assert.strictEqual(haversineDistanceMeters(24.86, 67.0, 24.86, 67.0), 0);
});

test('haversine: ~111km per degree of latitude', () => {
  const d = haversineDistanceMeters(24.0, 67.0, 25.0, 67.0);
  // 1° latitude ≈ 111.2 km
  assert.ok(Math.abs(d - 111195) < 500, `got ${d}`);
});

test('haversine: short office-scale distance is sane', () => {
  // ~0.0005° longitude at ~24.86° lat ≈ 50m
  const d = haversineDistanceMeters(24.86, 67.0, 24.86, 67.0005);
  assert.ok(d > 40 && d < 60, `got ${d}`);
});
