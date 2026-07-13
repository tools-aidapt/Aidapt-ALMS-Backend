'use strict';

const { makeModel } = require('./_base');

const RegularizationLog = makeModel({
  table: 'regularization_log',
  createdColumn: 'created_at',
  columns: {
    Punch: { col: 'punch_id', link: true },
    EditedBy: { col: 'edited_by', link: true },
    FieldChanged: { col: 'field_changed' },
    OldValue: { col: 'old_value' },
    NewValue: { col: 'new_value' },
  },
});

/**
 * Filtered audit list. `from`/`to` bound the created_at day; punchId/editedBy
 * filter by the linked records.
 */
RegularizationLog.query = function query({ punchId, editedBy, from, to } = {}) {
  const where = [];
  const params = [];
  if (punchId) where.push(`punch_id = $${params.push(punchId)}`);
  if (editedBy) where.push(`edited_by = $${params.push(editedBy)}`);
  if (from) where.push(`created_at >= $${params.push(from)}`);
  if (to) where.push(`created_at < ($${params.push(to)}::date + 1)`);
  return this.selectWhere(where.join(' AND '), params, 'ORDER BY created_at DESC');
};

module.exports = RegularizationLog;
