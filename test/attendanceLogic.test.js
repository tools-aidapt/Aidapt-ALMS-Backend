'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  computeLateness,
  resolveGraceMinutes,
  shiftWithResolvedGrace,
  shiftLengthHours,
  modeForDistance,
  computeWorked,
  lateStrikeHalfDayDates,
  buildStrikeItems,
  IMMEDIATE_STRIKE_REASON,
} = require('../src/utils/attendanceCalc');

const shift = (fields) => ({ id: 'shf1', fields });
const employee = (fields) => ({ id: 'emp1', fields });

test('computeLateness: on-time within grace is not late', () => {
  const s = shift({ StartTime: '10:00', GraceMinutes: 15 });
  // 10:10 PKT == 05:10Z
  const r = computeLateness(s, '2026-07-08T05:10:00Z');
  assert.strictEqual(r.isLate, false);
  assert.strictEqual(r.lateByMinutes, 0);
  assert.strictEqual(r.isImmediateStrike, false);
});

test('computeLateness: past grace but before +30 is late only', () => {
  const s = shift({ StartTime: '10:00', GraceMinutes: 15 });
  // 10:25 PKT == 05:25Z -> late by 10, not yet immediate strike
  const r = computeLateness(s, '2026-07-08T05:25:00Z');
  assert.strictEqual(r.isLate, true);
  assert.strictEqual(r.lateByMinutes, 10);
  assert.strictEqual(r.isImmediateStrike, false);
});

test('computeLateness: after start+30 is late and immediate strike', () => {
  const s = shift({ StartTime: '10:00', GraceMinutes: 15 });
  // 10:31 PKT == 05:31Z
  const r = computeLateness(s, '2026-07-08T05:31:00Z');
  assert.strictEqual(r.isLate, true);
  assert.strictEqual(r.lateByMinutes, 16);
  assert.strictEqual(r.isImmediateStrike, true);
});

test('computeLateness: no shift -> not late', () => {
  const r = computeLateness(null, '2026-07-08T09:00:00Z');
  assert.strictEqual(r.isLate, false);
  assert.strictEqual(r.isImmediateStrike, false);
});

test('resolveGraceMinutes: employee override wins over shift', () => {
  assert.strictEqual(
    resolveGraceMinutes(employee({ GraceMinutes: 5 }), shift({ GraceMinutes: 20 })),
    5
  );
});

test('resolveGraceMinutes: null employee grace falls back to shift', () => {
  assert.strictEqual(
    resolveGraceMinutes(employee({ GraceMinutes: null }), shift({ GraceMinutes: 20 })),
    20
  );
});

test('resolveGraceMinutes: missing employee and shift grace -> 0', () => {
  assert.strictEqual(resolveGraceMinutes(null, null), 0);
  assert.strictEqual(resolveGraceMinutes(employee({}), shift({})), 0);
});

test('resolveGraceMinutes: employee grace 0 is a valid override', () => {
  assert.strictEqual(
    resolveGraceMinutes(employee({ GraceMinutes: 0 }), shift({ GraceMinutes: 20 })),
    0
  );
});

test('shiftWithResolvedGrace: lateness uses employee override', () => {
  const s = shift({ StartTime: '10:00', GraceMinutes: 20 });
  const emp = employee({ GraceMinutes: 5 });
  // 10:10 PKT — late with 5m grace, on-time with 20m shift grace
  const withOverride = computeLateness(shiftWithResolvedGrace(s, emp), '2026-07-08T05:10:00Z');
  assert.strictEqual(withOverride.isLate, true);
  assert.strictEqual(withOverride.lateByMinutes, 5);

  const withShift = computeLateness(shiftWithResolvedGrace(s, employee({ GraceMinutes: null })), '2026-07-08T05:10:00Z');
  assert.strictEqual(withShift.isLate, false);
});

test('shiftWithResolvedGrace: immediate strike still at start+30 regardless of grace', () => {
  const s = shift({ StartTime: '10:00', GraceMinutes: 0 });
  const emp = employee({ GraceMinutes: 45 }); // wider than +30
  // 10:31 PKT — still immediate strike
  const r = computeLateness(shiftWithResolvedGrace(s, emp), '2026-07-08T05:31:00Z');
  assert.strictEqual(r.isImmediateStrike, true);
  assert.strictEqual(r.isLate, false); // within 45m grace, but still strike
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

const dayInfo = (date, isLate, isImmediateStrike = false, checkInTime = null) => ({
  date,
  isLate,
  isImmediateStrike,
  checkInTime,
  checkInTimePkt: checkInTime ? `PKT:${checkInTime}` : null,
});

test('lateStrikeHalfDayDates: fewer than 3 lates -> none', () => {
  const set = lateStrikeHalfDayDates([
    dayInfo('2026-07-01', true),
    dayInfo('2026-07-02', true),
    dayInfo('2026-07-03', false),
  ]);
  assert.strictEqual(set.size, 0);
});

test('buildStrikeItems: the 3rd and 6th late day become strike items', () => {
  const items = buildStrikeItems([
    dayInfo('2026-07-01', true), // 1
    dayInfo('2026-07-02', false),
    dayInfo('2026-07-05', true), // 2
    dayInfo('2026-07-09', true), // 3 -> strike
    dayInfo('2026-07-12', true), // 4
    dayInfo('2026-07-15', true), // 5
    dayInfo('2026-07-20', true), // 6 -> strike
  ]);
  assert.deepStrictEqual(
    items.map((i) => i.date),
    ['2026-07-09', '2026-07-20']
  );
});

test('buildStrikeItems: late counter resets each calendar month', () => {
  const items = buildStrikeItems([
    dayInfo('2026-07-28', true), // Jul 1
    dayInfo('2026-07-29', true), // Jul 2
    dayInfo('2026-08-01', true), // Aug 1 (reset)
    dayInfo('2026-08-04', true), // Aug 2
    dayInfo('2026-08-06', true), // Aug 3 -> strike
  ]);
  assert.deepStrictEqual(
    items.map((i) => i.date),
    ['2026-08-06']
  );
});

test('buildStrikeItems: unordered input still flags the 3rd late chronologically', () => {
  const items = buildStrikeItems([
    dayInfo('2026-07-09', true),
    dayInfo('2026-07-01', true),
    dayInfo('2026-07-05', true),
  ]);
  assert.deepStrictEqual(
    items.map((i) => i.date),
    ['2026-07-09']
  );
});

test('lateStrikeHalfDayDates: single immediate strike is not Half Day yet', () => {
  const set = lateStrikeHalfDayDates([
    dayInfo('2026-07-01', true, true),
    dayInfo('2026-07-02', true, false),
  ]);
  assert.strictEqual(set.size, 0);
});

test('lateStrikeHalfDayDates: Half Day only on every 3rd strike day', () => {
  const set = lateStrikeHalfDayDates([
    dayInfo('2026-07-01', true, true), // strike 1
    dayInfo('2026-07-05', true, true), // strike 2
    dayInfo('2026-07-09', true, true), // strike 3 -> Half Day
    dayInfo('2026-07-12', true, true), // strike 4
  ]);
  assert.deepStrictEqual([...set], ['2026-07-09']);
});

test('buildStrikeItems: monthly reason for 3rd late only', () => {
  const items = buildStrikeItems([
    dayInfo('2026-07-01', true),
    dayInfo('2026-07-05', true),
    dayInfo('2026-07-09', true),
  ]);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].date, '2026-07-09');
  assert.match(items[0].reason, /3rd late day/);
});

test('lateStrikeHalfDayDates: one monthly strike alone is not Half Day', () => {
  // 3 late days => 1 strike item; Half Day needs 3 strikes
  const set = lateStrikeHalfDayDates([
    dayInfo('2026-07-01', true),
    dayInfo('2026-07-05', true),
    dayInfo('2026-07-09', true),
  ]);
  assert.strictEqual(set.size, 0);
});

test('buildStrikeItems: immediate strike has dedicated reason and check-in time', () => {
  const items = buildStrikeItems([
    dayInfo('2026-07-01', true, true, '2026-07-01T05:31:00Z'),
  ]);
  assert.deepStrictEqual(items, [
    {
      date: '2026-07-01',
      reason: IMMEDIATE_STRIKE_REASON,
      checkInTime: '2026-07-01T05:31:00Z',
      checkInTimePkt: 'PKT:2026-07-01T05:31:00Z',
    },
  ]);
});

test('buildStrikeItems: overlap keeps one item with immediate reason', () => {
  const items = buildStrikeItems([
    dayInfo('2026-07-01', true, false),
    dayInfo('2026-07-02', true, false),
    dayInfo('2026-07-03', true, true), // 3rd late AND immediate
  ]);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].date, '2026-07-03');
  assert.strictEqual(items[0].reason, IMMEDIATE_STRIKE_REASON);
});
