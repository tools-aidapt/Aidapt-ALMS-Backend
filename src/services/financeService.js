'use strict';

const axios = require('axios');
const env = require('../config/env');
const { AppError, notFound } = require('../middleware/errorHandler');
const FinanceEntry = require('../models/FinanceEntry');
const { compareMonthKeys, summarizeAmounts } = require('./financeFieldMap');
const { syncFromClickUp } = require('./financeSyncService');
const { resolveContentType, contentDisposition, isHtmlResponse } = require('../utils/fileType');
const { getTask } = require('./clickupClient');

function toIso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toPublicEntry(rec) {
  const f = rec.fields;
  const attachments = Array.isArray(f.Attachments) ? f.Attachments : [];
  return {
    id: rec.id,
    name: f.Name,
    totalAmount: f.TotalAmount == null ? null : f.TotalAmount,
    purchaseDate: f.PurchaseDate ? String(f.PurchaseDate).slice(0, 10) : null,
    purchaseType: f.PurchaseType || null,
    comment: f.Comment || '',
    attachments: attachments.map((a) => ({ id: a.id, name: a.name })),
    status: f.Status || null,
    clickupUrl: f.ClickupUrl || null,
  };
}

function groupRecords(records) {
  const map = new Map();
  for (const rec of records) {
    const key = rec.fields.PurchaseMonthKey || 'unassigned';
    if (!map.has(key)) {
      map.set(key, {
        key,
        label:
          rec.fields.PurchaseMonthLabel ||
          (key === 'unassigned' ? 'Unassigned' : key),
        entries: [],
      });
    }
    map.get(key).entries.push(toPublicEntry(rec));
  }

  const months = [...map.values()]
    .map((group) => {
      const summary = summarizeAmounts(group.entries.map((entry) => entry.totalAmount));
      return { ...group, ...summary };
    })
    .sort((a, b) => compareMonthKeys(a.key, b.key));

  const grand = summarizeAmounts(months.flatMap((month) => month.entries.map((entry) => entry.totalAmount)));
  return {
    months,
    grandTotal: grand.totalAmount,
    spent: grand.spent,
    reimbursed: grand.reimbursed,
    remaining: grand.remaining,
  };
}

async function listGrouped({ month, year } = {}) {
  const [records, last] = await Promise.all([
    FinanceEntry.listFiltered({ month, year }),
    FinanceEntry.maxSyncedAt(),
  ]);
  const grouped = groupRecords(records);
  return {
    lastSyncedAt: toIso(last),
    grandTotal: grouped.grandTotal,
    spent: grouped.spent,
    reimbursed: grouped.reimbursed,
    remaining: grouped.remaining,
    months: grouped.months,
  };
}

async function getOne(id) {
  const rec = await FinanceEntry.get(id);
  if (!rec) throw notFound('Finance entry not found', 'FINANCE_NOT_FOUND');
  return {
    ...toPublicEntry(rec),
    purchaseMonth: rec.fields.PurchaseMonthLabel || null,
  };
}

async function sync() {
  const counts = await syncFromClickUp();
  const view = await listGrouped({});
  return { upserted: counts.upserted, removed: counts.removed, ...view };
}

function readFirstChunk(stream) {
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      cleanup();
      stream.pause();
      resolve(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.alloc(0));
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
    };
    stream.once('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
  });
}

async function fetchUrl(url, withKey) {
  const headers = {};
  if (withKey && env.clickup.apiKey) headers.Authorization = env.clickup.apiKey;
  return axios.get(url, {
    responseType: 'stream',
    timeout: 60000,
    maxRedirects: 5,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    headers,
    validateStatus: () => true,
  });
}

function destroyStream(response) {
  const stream = response && response.data;
  if (stream && typeof stream.destroy === 'function') stream.destroy();
}

const hasAuthzToken = (url) => {
  try {
    return new URL(url).searchParams.has('authz_token');
  } catch {
    return false;
  }
};

/**
 * A freshly signed URL for one attachment, or null.
 *
 * ClickUp only serves a private attachment from a URL carrying a short-lived
 * authz_token. The copy stored at sync time comes from the Attachments custom
 * field, which has no token (and a stored token would expire anyway), so the
 * task is read again here to get a URL that works right now.
 */
async function signedAttachmentUrl(taskId, attachmentId) {
  if (!taskId || !env.clickup.apiKey) return null;
  try {
    const task = await getTask(taskId);
    const pool = [
      ...(Array.isArray(task && task.attachments) ? task.attachments : []),
      ...((task && task.custom_fields) || []).flatMap((f) => (Array.isArray(f && f.value) ? f.value : [])),
    ];
    const match = pool.find((a) => a && String(a.id) === String(attachmentId));
    if (!match) return null;
    return [match.url, match.url_w_query, match.url_w_host].find(hasAuthzToken) || null;
  } catch {
    return null;
  }
}

/**
 * Pipe a ClickUp attachment to the HTTP response.
 * Uses a freshly signed URL when ClickUp gives one, else the stored URL, then
 * retries the stored URL with the API key on 401/403. A signed URL is fetched
 * without the key: ClickUp sends a keyed request for one to its sign-in page.
 */
async function streamAttachment(entryId, attachmentId, res) {
  const rec = await FinanceEntry.get(entryId);
  if (!rec) throw notFound('Finance entry not found', 'FINANCE_NOT_FOUND');

  const attachments = Array.isArray(rec.fields.Attachments) ? rec.fields.Attachments : [];
  const att = attachments.find((a) => a && String(a.id) === String(attachmentId));
  if (!att) throw notFound('Attachment not found', 'ATTACHMENT_NOT_FOUND');

  const sourceUrl = (await signedAttachmentUrl(rec.fields.ClickupTaskId, att.id)) || att.url;
  if (!sourceUrl) throw notFound('Attachment not found', 'ATTACHMENT_NOT_FOUND');

  let response;
  try {
    response = await fetchUrl(sourceUrl, false);
  } catch {
    throw new AppError(502, 'CLICKUP_ERROR', 'Could not download attachment');
  }

  if ((response.status === 401 || response.status === 403) && env.clickup.apiKey && att.url) {
    destroyStream(response);
    try {
      response = await fetchUrl(att.url, true);
    } catch {
      throw new AppError(502, 'CLICKUP_ERROR', 'Could not download attachment');
    }
  }

  if (response.status >= 400) {
    destroyStream(response);
    throw new AppError(502, 'CLICKUP_ERROR', 'Could not download attachment');
  }

  let head;
  try {
    head = await readFirstChunk(response.data);
  } catch {
    destroyStream(response);
    throw new AppError(502, 'CLICKUP_ERROR', 'Could not download attachment');
  }

  // A 200 can still be ClickUp's sign-in page. Never relabel that as the file.
  if (isHtmlResponse(response.headers['content-type'], head)) {
    destroyStream(response);
    throw new AppError(502, 'CLICKUP_ERROR', 'ClickUp did not return the file. Try syncing from ClickUp, then open it again.');
  }

  // ClickUp often labels images as application/octet-stream. With nosniff on,
  // the browser then only offers a download. Send a real image/pdf type and
  // Content-Disposition: inline so the file opens in the tab.
  const type = resolveContentType({
    upstreamType: response.headers['content-type'],
    name: att.name,
    extension: att.extension,
    bytes: head,
  });
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', contentDisposition(type, att.name));
  res.setHeader('Cache-Control', 'private');
  if (response.headers['content-length']) {
    res.setHeader('Content-Length', response.headers['content-length']);
  }

  try {
    await new Promise((resolve, reject) => {
      const finish = (err) => {
        response.data.removeListener('error', onError);
        res.removeListener('error', onError);
        if (err) reject(err);
        else resolve();
      };
      const onError = (err) => finish(err);
      const stream = response.data;
      if (head.length) res.write(head);
      // The whole file can arrive in the first chunk. end may already have
      // fired while we were choosing the content type, so finish here.
      if (stream.readableEnded) {
        res.end();
        finish();
        return;
      }
      stream.once('error', onError);
      res.once('error', onError);
      stream.once('end', () => finish());
      stream.pipe(res);
    });
  } catch (err) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    throw err;
  }
}

module.exports = { listGrouped, getOne, sync, streamAttachment, toPublicEntry, groupRecords };
