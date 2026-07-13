'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  toPkt,
  parseHhMm,
  dowForDateStr,
  dateRangeInclusive,
  pktMinutesOfDay,
  hoursBetween,
  minutesBetween,
  formatHoursMinutes,
  pktTimeLabel,
} = require('../src/utils/dateUtils');

test('toPkt: UTC instant is shifted +5h', () => {
  // 2026-07-08T04:30:00Z -> 09:30 PKT, same date
  const p = toPkt('2026-07-08T04:30:00Z');
  assert.strictEqual(p.dateStr, '2026-07-08');
  assert.strictEqual(p.hours, 9);
  assert.strictEqual(p.minutes, 30);
});

test('toPkt: late-UTC crosses into next PKT day', () => {
  // 2026-07-08T20:00:00Z -> 01:00 PKT on 2026-07-09
  const p = toPkt('2026-07-08T20:00:00Z');
  assert.strictEqual(p.dateStr, '2026-07-09');
  assert.strictEqual(p.hours, 1);
});

test('parseHhMm: valid and invalid', () => {
  assert.strictEqual(parseHhMm('09:00'), 540);
  assert.strictEqual(parseHhMm('18:30'), 1110);
  assert.strictEqual(parseHhMm('24:00'), null);
  assert.strictEqual(parseHhMm('bad'), null);
});

test('pktMinutesOfDay: minutes since PKT midnight', () => {
  // 03:30Z -> 08:30 PKT -> 510 minutes
  assert.strictEqual(pktMinutesOfDay('2026-07-08T03:30:00Z'), 510);
});

test('dowForDateStr: known weekday', () => {
  assert.strictEqual(dowForDateStr('2026-07-08'), 'Wed');
  assert.strictEqual(dowForDateStr('2026-07-11'), 'Sat');
});

test('dateRangeInclusive: inclusive span and reversed range', () => {
  assert.deepStrictEqual(dateRangeInclusive('2026-07-08', '2026-07-10'), [
    '2026-07-08',
    '2026-07-09',
    '2026-07-10',
  ]);
  assert.deepStrictEqual(dateRangeInclusive('2026-07-10', '2026-07-08'), []);
});

test('hoursBetween: 2dp difference', () => {
  assert.strictEqual(
    hoursBetween('2026-07-08T04:00:00Z', '2026-07-08T12:30:00Z'),
    8.5
  );
});

test('minutesBetween: exact minutes', () => {
  assert.strictEqual(
    minutesBetween('2026-07-08T04:00:00Z', '2026-07-08T12:37:00Z'),
    517
  );
});

test('formatHoursMinutes: splits total minutes into Hh Mm', () => {
  assert.strictEqual(formatHoursMinutes(517), '8h 37m');
  assert.strictEqual(formatHoursMinutes(60), '1h 0m');
  assert.strictEqual(formatHoursMinutes(0), '0h 0m');
});

test('pktTimeLabel: UTC instant -> PKT YYYY-MM-DD HH:MM', () => {
  // 04:25Z -> 09:25 PKT
  assert.strictEqual(pktTimeLabel('2026-07-08T04:25:00Z'), '2026-07-08 09:25');
  assert.strictEqual(pktTimeLabel(null), null);
});
