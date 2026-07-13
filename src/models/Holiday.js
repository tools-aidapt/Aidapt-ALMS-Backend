'use strict';

const { makeModel } = require('./_base');

const Holiday = makeModel({
  table: 'holidays',
  createdColumn: 'created_at',
  columns: {
    Date: { col: 'date' },
    Name: { col: 'name' },
    AddedBy: { col: 'added_by', link: true },
  },
});

/**
 * Set of holiday date strings ("YYYY-MM-DD") within an optional inclusive range.
 * Used by leave day-counting to exclude holidays.
 * @returns {Promise<Set<string>>}
 */
Holiday.dateSet = async function dateSet(fromDate, toDate) {
  let rows;
  if (fromDate && toDate) {
    rows = await this.selectWhere('date >= $1 AND date <= $2', [fromDate, toDate]);
  } else {
    rows = await this.selectWhere();
  }
  const set = new Set();
  for (const r of rows) {
    if (r.fields.Date) set.add(String(r.fields.Date).slice(0, 10));
  }
  return set;
};

module.exports = Holiday;
