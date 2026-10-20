'use strict';

const { toPkt, round2 } = require('../utils/dateUtils');

const MONTH_FULL = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

const MONTH_SHORT = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const MONTH_LABEL = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function pad(n) {
  return String(n).padStart(2, '0');
}

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function monthLabel(year, month) {
  return `${MONTH_LABEL[month - 1]} ${year}`;
}

function monthIndex(token) {
  const t = String(token || '')
    .toLowerCase()
    .replace(/\./g, '');
  if (t === 'sept') return 9;
  const full = MONTH_FULL.indexOf(t);
  if (full >= 0) return full + 1;
  const short = MONTH_SHORT.indexOf(t);
  if (short >= 0) return short + 1;
  return null;
}

function bucket(year, month) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null;
  return { key: `${year}-${pad(month)}`, label: monthLabel(year, month) };
}

function isUnixMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 1e11;
  return /^\d{12,}$/.test(String(value).trim());
}

function fromUnixMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return null;
  const p = toPkt(new Date(n));
  return bucket(p.year, p.month);
}

/**
 * Turn a Purchase Month value into a sortable key plus a display label.
 * Returns null when the value cannot be read as a month.
 * @returns {{key: string, label: string}|null}
 */
function parseMonthToken(value) {
  if (value == null || value === '') return null;

  if (isUnixMs(value)) return fromUnixMs(value);

  const s = String(value).trim();

  let m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(s);
  if (m) return bucket(Number(m[1]), Number(m[2]));

  m = /^(\d{1,2})[/-](\d{4})$/.exec(s);
  if (m) return bucket(Number(m[2]), Number(m[1]));

  m = /^([A-Za-z]+)\.?\s*,?\s+(\d{4})$/.exec(s);
  if (m) {
    const month = monthIndex(m[1]);
    if (month) return bucket(Number(m[2]), month);
  }

  return null;
}

function findField(task, names) {
  const fields = Array.isArray(task && task.custom_fields) ? task.custom_fields : [];
  for (const name of names) {
    const wanted = normalizeName(name);
    const hit = fields.find((f) => normalizeName(f.name) === wanted);
    if (hit) return hit;
  }
  return null;
}

function optionName(field, value) {
  const options = (field.type_config && field.type_config.options) || [];
  const match = options.find(
    (o) =>
      o.id === value ||
      String(o.orderindex) === String(value) ||
      o.name === value ||
      o.label === value
  );
  if (!match) return null;
  return match.name || match.label || null;
}

/**
 * Human-readable value of a custom field (dropdown label, text, number, date ms).
 * Attachment fields are not passed through here.
 */
function fieldScalar(field) {
  if (!field || field.value == null || field.value === '') return null;

  if (field.type === 'labels' && Array.isArray(field.value)) {
    const names = field.value
      .map((id) => optionName(field, id))
      .filter(Boolean);
    return names.length ? names.join(', ') : null;
  }

  if (field.type === 'drop_down' || field.type === 'dropdown') {
    const label = optionName(field, field.value);
    if (label) return label;
  }

  if (typeof field.value === 'object' && !Array.isArray(field.value) && 'value' in field.value) {
    return field.value.value;
  }

  return field.value;
}

function parseAmount(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object' && !Array.isArray(value) && 'value' in value) {
    return parseAmount(value.value);
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const n = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function parseDate(value) {
  if (value == null || value === '') return null;
  if (isUnixMs(value)) {
    const p = toPkt(new Date(Number(value)));
    return p.dateStr;
  }
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value).trim());
  return m ? m[1] : null;
}

function normalizeAttachment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id || raw.attachment_id;
  if (id == null || id === '') return null;
  const name = raw.title || raw.name || raw.filename || 'attachment';
  const url = raw.url || raw.url_w_query || raw.url_w_host || null;
  return {
    id: String(id),
    name: String(name),
    url: url ? String(url) : null,
    extension: raw.extension ? String(raw.extension) : null,
  };
}

function collectAttachments(task, attachmentField) {
  const map = new Map();
  const add = (raw) => {
    const att = normalizeAttachment(raw);
    if (!att) return;
    const prev = map.get(att.id);
    if (!prev || (!prev.url && att.url)) map.set(att.id, att);
  };

  const custom = attachmentField && attachmentField.value;
  if (Array.isArray(custom)) custom.forEach(add);
  else if (custom && typeof custom === 'object') add(custom);
  if (Array.isArray(task && task.attachments)) task.attachments.forEach(add);
  return [...map.values()];
}

/**
 * Year for a month-only label such as "Sep".
 * Petty cash is often paid on the 1st of the next month, so the purchase date
 * can fall in the following month. December paid in January belongs to the
 * previous year.
 */
function yearForAccountingMonth(month, purchaseDate) {
  if (!purchaseDate) return null;
  const [year, dateMonth] = String(purchaseDate).slice(0, 10).split('-').map(Number);
  if (!year || !dateMonth) return null;
  if (month > dateMonth) return year - 1;
  return year;
}

function resolveMonth(monthField, purchaseDate) {
  const scalar = fieldScalar(monthField);
  const parsed = parseMonthToken(scalar);
  if (parsed) return parsed;

  // ClickUp stores Purchase Month as Jan..Dec with no year.
  const monthOnly = monthIndex(scalar);
  if (monthOnly && !/\d/.test(String(scalar || ''))) {
    const year = yearForAccountingMonth(monthOnly, purchaseDate);
    if (year) return bucket(year, monthOnly);
  }

  if (purchaseDate) {
    const [year, month] = purchaseDate.split('-').map(Number);
    const fromDate = bucket(year, month);
    if (fromDate) return fromDate;
  }

  if (scalar != null && String(scalar).trim() !== '') {
    return { key: String(scalar).trim(), label: String(scalar).trim() };
  }

  return { key: 'unassigned', label: 'Unassigned' };
}

function taskStatus(task) {
  if (!task || task.status == null) return null;
  if (typeof task.status === 'string') return task.status;
  if (typeof task.status.status === 'string') return task.status.status;
  return null;
}

function taskCreatedAt(task) {
  const raw = task && (task.date_created || task.date_updated);
  if (raw == null || raw === '') return null;
  const ms = Number(raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function taskUrl(task, workspaceId) {
  if (!task || !task.id) return null;
  if (workspaceId) return `https://app.clickup.com/${workspaceId}/t/${task.id}`;
  return `https://app.clickup.com/t/${task.id}`;
}

/**
 * Map one ClickUp task into a finance_entries row.
 * Never throws; tasks without an id return null.
 */
function mapClickUpTask(task, workspaceId) {
  if (!task || task.id == null || task.id === '') return null;

  const amountField = findField(task, ['Total Amount']);
  const dateField = findField(task, ['Purchase Date', 'Purchase Data']);
  const monthField = findField(task, ['Purchase Month']);
  const typeField = findField(task, ['Purchase Type']);
  const commentField = findField(task, ['Comment']);
  const attachmentField = findField(task, ['Attachments', 'Attachment(s)']);

  const purchaseDate = parseDate(fieldScalar(dateField));
  const month = resolveMonth(monthField, purchaseDate);
  const commentRaw = fieldScalar(commentField);
  const comment =
    commentRaw == null || String(commentRaw).trim() === '' ? null : String(commentRaw);
  const name = String(task.name || '').trim() || 'Untitled';

  return {
    clickupTaskId: String(task.id),
    name,
    status: taskStatus(task),
    totalAmount: parseAmount(fieldScalar(amountField)),
    purchaseDate,
    purchaseMonthKey: month.key,
    purchaseMonthLabel: month.label,
    purchaseType: (() => {
      const v = fieldScalar(typeField);
      return v == null || String(v).trim() === '' ? null : String(v);
    })(),
    comment,
    attachments: collectAttachments(task, attachmentField),
    clickupUrl: taskUrl(task, workspaceId),
    taskCreatedAt: taskCreatedAt(task),
  };
}

/**
 * Newest dated months first. Unassigned is last. Other labels sit between them.
 */
/**
 * Purchases are stored as negative amounts. Petty-cash reimbursements are
 * positive. Remaining is what is still owed: spend minus what has been paid back.
 * A positive remaining is over budget / not yet reimbursed.
 */
function summarizeAmounts(amounts) {
  let spent = 0;
  let reimbursed = 0;
  for (const n of amounts) {
    if (typeof n !== 'number' || !Number.isFinite(n)) continue;
    if (n < 0) spent += Math.abs(n);
    else if (n > 0) reimbursed += n;
  }
  spent = round2(spent);
  reimbursed = round2(reimbursed);
  return {
    spent,
    reimbursed,
    remaining: round2(spent - reimbursed),
    totalAmount: round2(reimbursed - spent),
  };
}

function compareMonthKeys(a, b) {
  if (a === b) return 0;
  if (a === 'unassigned') return 1;
  if (b === 'unassigned') return -1;
  const aDate = /^\d{4}-\d{2}$/.test(a);
  const bDate = /^\d{4}-\d{2}$/.test(b);
  if (aDate && bDate) return a < b ? 1 : -1;
  if (aDate) return -1;
  if (bDate) return 1;
  return a < b ? 1 : -1;
}

module.exports = {
  mapClickUpTask,
  parseMonthToken,
  compareMonthKeys,
  summarizeAmounts,
  findField,
  fieldScalar,
};
