'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  mapClickUpTask,
  parseMonthToken,
  compareMonthKeys,
  summarizeAmounts,
} = require('../src/services/financeFieldMap');

function task(overrides = {}) {
  return {
    id: 'task1',
    name: 'Laptop',
    status: { status: 'complete' },
    date_created: String(Date.parse('2026-10-02T08:00:00Z')),
    custom_fields: [],
    attachments: [],
    ...overrides,
  };
}

test('parseMonthToken reads YYYY-MM, month names, and ClickUp date ms', () => {
  assert.deepStrictEqual(parseMonthToken('2026-10'), { key: '2026-10', label: 'October 2026' });
  assert.deepStrictEqual(parseMonthToken('October 2026'), { key: '2026-10', label: 'October 2026' });
  assert.deepStrictEqual(parseMonthToken('Oct 2026'), { key: '2026-10', label: 'October 2026' });
  assert.deepStrictEqual(parseMonthToken('10/2026'), { key: '2026-10', label: 'October 2026' });

  const ms = Date.parse('2026-07-08T20:00:00Z');
  assert.deepStrictEqual(parseMonthToken(String(ms)), { key: '2026-07', label: 'July 2026' });
  assert.strictEqual(parseMonthToken('not a month'), null);
  assert.strictEqual(parseMonthToken(0), null);
});

test('compareMonthKeys: newest dated month first, unassigned last', () => {
  const keys = ['unassigned', '2026-01', 'Misc', '2026-10'];
  keys.sort(compareMonthKeys);
  assert.deepStrictEqual(keys, ['2026-10', '2026-01', 'Misc', 'unassigned']);
});

test('mapClickUpTask maps custom fields, dropdowns, and dedupes attachments', () => {
  const mapped = mapClickUpTask(
    task({
      custom_fields: [
        { name: 'Total Amount', type: 'currency', value: '50,000' },
        { name: 'Purchase Date', type: 'date', value: String(Date.parse('2026-10-02T08:00:00Z')) },
        { name: 'Purchase Month', type: 'short_text', value: 'October 2026' },
        {
          name: 'Purchase Type',
          type: 'drop_down',
          value: 0,
          type_config: { options: [{ id: 'opt1', name: 'Equipment', orderindex: 0 }] },
        },
        { name: 'Comment', type: 'text', value: 'For design' },
        {
          name: 'Attachments',
          type: 'attachment',
          value: [{ id: 'att1', title: 'invoice.pdf', url: 'https://files.example/a.pdf', extension: 'pdf' }],
        },
      ],
      attachments: [
        { id: 'att1', title: 'invoice.pdf', url: 'https://files.example/dup.pdf' },
        { id: 'att2', title: 'receipt.png', url: 'https://files.example/b.png', extension: 'png' },
      ],
    }),
    '9012897228'
  );

  assert.strictEqual(mapped.clickupTaskId, 'task1');
  assert.strictEqual(mapped.name, 'Laptop');
  assert.strictEqual(mapped.status, 'complete');
  assert.strictEqual(mapped.totalAmount, 50000);
  assert.strictEqual(mapped.purchaseDate, '2026-10-02');
  assert.strictEqual(mapped.purchaseMonthKey, '2026-10');
  assert.strictEqual(mapped.purchaseMonthLabel, 'October 2026');
  assert.strictEqual(mapped.purchaseType, 'Equipment');
  assert.strictEqual(mapped.comment, 'For design');
  assert.strictEqual(mapped.clickupUrl, 'https://app.clickup.com/9012897228/t/task1');
  assert.deepStrictEqual(
    mapped.attachments.map((a) => a.id),
    ['att1', 'att2']
  );
  assert.strictEqual(mapped.attachments[0].url, 'https://files.example/a.pdf');
  assert.strictEqual(mapped.attachments[1].name, 'receipt.png');
});

test('mapClickUpTask accepts Purchase Data and falls back to that date for the month', () => {
  const ms = String(Date.parse('2026-07-08T20:00:00Z'));
  const mapped = mapClickUpTask(
    task({
      custom_fields: [
        { name: 'Purchase Data', type: 'date', value: ms },
        { name: 'Total Amount', type: 'number', value: { value: 12.5 } },
      ],
    }),
    ''
  );

  assert.strictEqual(mapped.purchaseDate, '2026-07-09');
  assert.strictEqual(mapped.purchaseMonthKey, '2026-07');
  assert.strictEqual(mapped.purchaseMonthLabel, 'July 2026');
  assert.strictEqual(mapped.totalAmount, 12.5);
  assert.strictEqual(mapped.clickupUrl, 'https://app.clickup.com/t/task1');
  assert.strictEqual(mapped.comment, null);
});

test('Purchase Month dropdown wins over the payment date', () => {
  // September petty cash is paid on 1 Oct. It still belongs to September.
  const september = mapClickUpTask(
    task({
      name: 'September Petty Cash',
      custom_fields: [
        { name: 'Purchase Date', type: 'date', value: String(Date.parse('2026-10-01T00:00:00Z')) },
        {
          name: 'Purchase Month',
          type: 'drop_down',
          value: 8,
          type_config: {
            options: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map(
              (name, orderindex) => ({ id: name, name, orderindex })
            ),
          },
        },
        { name: 'Total Amount', type: 'currency', value: 20000 },
      ],
    })
  );
  assert.strictEqual(september.purchaseMonthKey, '2026-09');
  assert.strictEqual(september.purchaseMonthLabel, 'September 2026');

  // December reimbursed in January belongs to the previous year.
  const december = mapClickUpTask(
    task({
      custom_fields: [
        { name: 'Purchase Date', type: 'date', value: String(Date.parse('2027-01-02T00:00:00Z')) },
        {
          name: 'Purchase Month',
          type: 'drop_down',
          value: 11,
          type_config: { options: [{ id: 'dec', name: 'Dec', orderindex: 11 }] },
        },
      ],
    })
  );
  assert.strictEqual(december.purchaseMonthKey, '2026-12');
});

test('summarizeAmounts: remaining is spend minus petty cash paid back', () => {
  // September purchases 43,120 against 20,000 petty cash.
  const summary = summarizeAmounts([-43120, 20000]);
  assert.strictEqual(summary.spent, 43120);
  assert.strictEqual(summary.reimbursed, 20000);
  assert.strictEqual(summary.remaining, 23120);
  assert.strictEqual(summary.totalAmount, -23120);
});

test('mapClickUpTask uses Purchase Month dropdown label and leaves the bucket unassigned when empty', () => {
  const labeled = mapClickUpTask(
    task({
      custom_fields: [
        {
          name: 'Purchase Month',
          type: 'drop_down',
          value: 'opt-oct',
          type_config: { options: [{ id: 'opt-oct', name: 'Oct 2026', orderindex: 2 }] },
        },
      ],
    })
  );
  assert.strictEqual(labeled.purchaseMonthKey, '2026-10');

  const empty = mapClickUpTask(task({ name: '   ' }));
  assert.strictEqual(empty.name, 'Untitled');
  assert.strictEqual(empty.purchaseMonthKey, 'unassigned');
  assert.strictEqual(empty.purchaseMonthLabel, 'Unassigned');
  assert.strictEqual(empty.totalAmount, null);
  assert.strictEqual(mapClickUpTask({ name: 'No id' }), null);
});
