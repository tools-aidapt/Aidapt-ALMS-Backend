'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  computeLateness,
  shiftLengthHours,
  modeForDistance,
  computeWorked,
} = require('../src/utils/attendanceCalc');

const shift = (fields) => ({ id: 'shf1', fields });

test('computeLateness: on-time within grace is not late', () => {
  const s = shift({ StartTime: '09:00', GraceMinutes: 15 });
  // 09:10 PKT == 04:10Z
  const r = computeLateness(s, '2026-07-08T04:10:00Z');
  assert.strictEqual(r.isLate, false);
  assert.strictEqual(r.lateByMinutes, 0);
});

test('computeLateness: past grace is late by the overage', () => {
  const s = shift({ StartTime: '09:00', GraceMinutes: 15 });
  // 09:25 PKT == 04:25Z -> 10 min past the 09:15 allowance
  const r = computeLateness(s, '2026-07-08T04:25:00Z');
  assert.strictEqual(r.isLate, true);
  assert.strictEqual(r.lateByMinutes, 10);
});

test('computeLateness: no shift -> not late', () => {
  const r = computeLateness(null, '2026-07-08T09:00:00Z');
  assert.strictEqual(r.isLate, false);
});

test('shiftLengthHours: standard 9-18 shift', () => {
  assert.strictEqual(shiftLengthHours(shift({ StartTime: '09:00', EndTime: '18:00' })), 9);
});

test('shiftLengthHours: overnight shift wraps midnight', () => {
  assert.strictEqual(shiftLengthHours(shift({ StartTime: '22:00', EndTime: '06:00' })), 8);
});

test('shiftLengthHours: unparseable -> null', () => {
  assert.strictEqual(shiftLengthHours(shift({ StartTime: 'x', EndTime: 'y' })), null);
});

test('modeForDistance: Office within radius, Remote beyond', () => {
  assert.strictEqual(modeForDistance(30, 50), 'Office');
  assert.strictEqual(modeForDistance(50, 50), 'Office'); // boundary inclusive
  assert.strictEqual(modeForDistance(51, 50), 'Remote In');
});

test('computeWorked: normal day is correct', () => {
  const r = computeWorked('2026-07-08T05:00:00Z', '2026-07-08T14:30:00Z', 9); // 9.5h vs 9h shift
  assert.strictEqual(r.workedMinutes, 570);
  assert.strictEqual(r.workedHours, 9.5);
  assert.strictEqual(r.overtimeHours, 0.5);
});

test('computeWorked: missing check-in -> nulls (no epoch bug)', () => {
  const r = computeWorked(null, '2026-07-08T14:30:00Z', 9);
  assert.deepStrictEqual(r, { workedMinutes: null, workedHours: null, overtimeHours: null });
});

test('computeWorked: missing check-out -> nulls', () => {
  const r = computeWorked('2026-07-08T05:00:00Z', null, 9);
  assert.deepStrictEqual(r, { workedMinutes: null, workedHours: null, overtimeHours: null });
});

test('computeWorked: never yields an epoch-scale value', () => {
  // The old bug: checkout minus null(=epoch) ~ 495,000h. Guard returns null.
  const r = computeWorked(undefined, '2026-07-08T13:33:00Z', 9);
  assert.strictEqual(r.workedHours, null);
});
