'use strict';

const { query, withTransaction } = require('../config/db');
const { makeModel } = require('./_base');

const ORDER =
  'ORDER BY task_created_at DESC NULLS LAST, purchase_date DESC NULLS LAST, name ASC';

const FinanceEntry = makeModel({
  table: 'finance_entries',
  createdColumn: 'created_at',
  columns: {
    ClickupTaskId: { col: 'clickup_task_id' },
    Name: { col: 'name' },
    Status: { col: 'status' },
    TotalAmount: { col: 'total_amount' },
    PurchaseDate: { col: 'purchase_date' },
    PurchaseMonthKey: { col: 'purchase_month_key' },
    PurchaseMonthLabel: { col: 'purchase_month_label' },
    PurchaseType: { col: 'purchase_type' },
    Comment: { col: 'comment' },
    Attachments: { col: 'attachments', json: true },
    ClickupUrl: { col: 'clickup_url' },
    TaskCreatedAt: { col: 'task_created_at' },
    SyncedAt: { col: 'synced_at' },
  },
});

/**
 * Replace the mirror with the latest ClickUp pull.
 * Upserts every row, then deletes local tasks missing from this pull.
 * @param {Array<object>} rows plain column values (see upsertSql)
 * @returns {Promise<{upserted: number, removed: number}>}
 */
FinanceEntry.upsertAndPrune = async function upsertAndPrune(rows) {
  return withTransaction(async (client) => {
    const ids = [];
    for (const row of rows) {
      await client.query(UPSERT_SQL, upsertParams(row));
      ids.push(row.clickupTaskId);
    }

    const deleted =
      ids.length === 0
        ? await client.query('DELETE FROM finance_entries')
        : await client.query(
            'DELETE FROM finance_entries WHERE NOT (clickup_task_id = ANY($1::text[]))',
            [ids]
          );

    return { upserted: ids.length, removed: deleted.rowCount || 0 };
  });
};

FinanceEntry.listFiltered = async function listFiltered({ month, year } = {}) {
  if (month) {
    return this.selectWhere('purchase_month_key = $1', [month], ORDER);
  }
  if (year) {
    return this.selectWhere('purchase_month_key LIKE $1', [`${year}-%`], ORDER);
  }
  return this.selectWhere('', [], ORDER);
};

FinanceEntry.maxSyncedAt = async function maxSyncedAt() {
  const { rows } = await query('SELECT max(synced_at) AS synced_at FROM finance_entries');
  return rows[0] ? rows[0].synced_at : null;
};

const UPSERT_SQL = `
  INSERT INTO finance_entries (
    clickup_task_id, name, status, total_amount, purchase_date,
    purchase_month_key, purchase_month_label, purchase_type, comment,
    attachments, clickup_url, task_created_at, synced_at
  ) VALUES (
    $1, $2, $3, $4, $5,
    $6, $7, $8, $9,
    $10::jsonb, $11, $12, now()
  )
  ON CONFLICT (clickup_task_id) DO UPDATE SET
    name = EXCLUDED.name,
    status = EXCLUDED.status,
    total_amount = EXCLUDED.total_amount,
    purchase_date = EXCLUDED.purchase_date,
    purchase_month_key = EXCLUDED.purchase_month_key,
    purchase_month_label = EXCLUDED.purchase_month_label,
    purchase_type = EXCLUDED.purchase_type,
    comment = EXCLUDED.comment,
    attachments = EXCLUDED.attachments,
    clickup_url = EXCLUDED.clickup_url,
    task_created_at = EXCLUDED.task_created_at,
    synced_at = now()
`;

function upsertParams(row) {
  return [
    row.clickupTaskId,
    row.name,
    row.status,
    row.totalAmount,
    row.purchaseDate,
    row.purchaseMonthKey,
    row.purchaseMonthLabel,
    row.purchaseType,
    row.comment,
    JSON.stringify(row.attachments || []),
    row.clickupUrl,
    row.taskCreatedAt,
  ];
}

module.exports = FinanceEntry;
