'use strict';

const axios = require('axios');
const env = require('../config/env');
const { AppError } = require('../middleware/errorHandler');

const BASE = 'https://api.clickup.com/api/v2';
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

function notConfigured() {
  return new AppError(503, 'CLICKUP_NOT_CONFIGURED', 'CLICKUP_API_KEY is not set');
}

function clickupError(err) {
  const status = err.response && err.response.status;
  const data = err.response && err.response.data;
  let detail = '';
  if (data && typeof data.err === 'string') detail = `: ${data.err}`;
  else if (data && typeof data.error === 'string') detail = `: ${data.error}`;
  const suffix = status ? ` (${status})` : '';
  return new AppError(502, 'CLICKUP_ERROR', `ClickUp request failed${suffix}${detail}`);
}

async function clickupGet(path, params) {
  const key = env.clickup.apiKey;
  if (!key) throw notConfigured();
  try {
    const res = await axios.get(`${BASE}${path}`, {
      headers: { Authorization: key },
      params,
      timeout: 30000,
    });
    return res.data;
  } catch (err) {
    throw clickupError(err);
  }
}

/**
 * Every task on a list, including closed ones. Pages of 100 until a short page.
 */
async function listTasks(listId) {
  if (!/^\d+$/.test(String(listId || ''))) {
    throw new AppError(503, 'CLICKUP_NOT_CONFIGURED', 'CLICKUP_FINANCE_LIST_ID is not set');
  }

  const tasks = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await clickupGet(`/list/${listId}/task`, {
      include_closed: true,
      page,
    });
    if (!data || !Array.isArray(data.tasks)) {
      throw new AppError(502, 'CLICKUP_ERROR', 'ClickUp task list response was not recognized');
    }
    const batch = data.tasks;
    tasks.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return tasks;
}

/**
 * One task. Its `attachments` carry URLs signed with a short-lived authz_token,
 * which is the only form ClickUp will serve the file from.
 */
async function getTask(taskId) {
  return clickupGet(`/task/${encodeURIComponent(String(taskId))}`);
}

module.exports = { listTasks, getTask };
