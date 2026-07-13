'use strict';

const Holiday = require('../models/Holiday');
const { badRequest } = require('../middleware/errorHandler');

function serialize(rec) {
  return {
    id: rec.id,
    date: rec.fields.Date || null,
    name: rec.fields.Name || null,
    addedBy: rec.fields.AddedBy || [],
    createdAt: rec.fields.CreatedAt || rec.createdTime,
  };
}

async function list() {
  const rows = await Holiday.list({ sort: [{ field: 'Date', direction: 'asc' }] });
  return rows.map(serialize);
}

async function add({ date, name }, addedByEmployeeId) {
  if (!date) throw badRequest('date is required');
  const existing = await Holiday.dateSet(date, date);
  if (existing.has(date)) {
    throw badRequest(`A holiday already exists on ${date}`, 'HOLIDAY_EXISTS');
  }
  const fields = { Date: date, Name: name || '' };
  if (addedByEmployeeId) fields.AddedBy = [addedByEmployeeId];
  const rec = await Holiday.create(fields);
  return serialize(rec);
}

async function remove(id) {
  const rec = await Holiday.get(id);
  if (!rec) throw badRequest('Holiday not found', 'NOT_FOUND');
  await Holiday.remove(id);
  return { id, deleted: true };
}

/** Expose the underlying date-set for the leave day-counter. */
function holidayDateSet(fromDate, toDate) {
  return Holiday.dateSet(fromDate, toDate);
}

module.exports = { list, add, remove, holidayDateSet, serialize };
