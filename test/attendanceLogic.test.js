'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  computeLateness,
  shiftLengthHours,
  modeForDistance,
  computeWorked,
  lateStrikeHalfDayDates,
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

const dayInfo = (date, isLate) => ({ date, isLate });

test('lateStrikeHalfDayDates: fewer than 3 lates -> none', () => {
  const set = lateStrikeHalfDayDates([
    dayInfo('2026-07-01', true),
    dayInfo('2026-07-02', true),
    dayInfo('2026-07-03', false),
  ]);
  assert.strictEqual(set.size, 0);
});

test('lateStrikeHalfDayDates: the 3rd and 6th late day are flagged', () => {
  const set = lateStrikeHalfDayDates([
    dayInfo('2026-07-01', true), // 1
    dayInfo('2026-07-02', false),
    dayInfo('2026-07-05', true), // 2
    dayInfo('2026-07-09', true), // 3 -> half day
    dayInfo('2026-07-12', true), // 4
    dayInfo('2026-07-15', true), // 5
    dayInfo('2026-07-20', true), // 6 -> half day
  ]);
  assert.deepStrictEqual([...set].sort(), ['2026-07-09', '2026-07-20']);
});

test('lateStrikeHalfDayDates: counter resets each calendar month', () => {
  const set = lateStrikeHalfDayDates([
    dayInfo('2026-07-28', true), // Jul 1
    dayInfo('2026-07-29', true), // Jul 2
    dayInfo('2026-08-01', true), // Aug 1 (reset)
    dayInfo('2026-08-04', true), // Aug 2
    dayInfo('2026-08-06', true), // Aug 3 -> half day
  ]);
  assert.deepStrictEqual([...set], ['2026-08-06']);
});

test('lateStrikeHalfDayDates: unordered input still flags the 3rd late chronologically', () => {
  const set = lateStrikeHalfDayDates([
    dayInfo('2026-07-09', true),
    dayInfo('2026-07-01', true),
    dayInfo('2026-07-05', true),
  ]);
  assert.deepStrictEqual([...set], ['2026-07-09']);
});
