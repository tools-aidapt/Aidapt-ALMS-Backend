'use strict';

const env = require('../config/env');
const { AppError } = require('../middleware/errorHandler');
const FinanceEntry = require('../models/FinanceEntry');
const clickupClient = require('./clickupClient');
const { mapClickUpTask } = require('./financeFieldMap');

/**
 * Pull ORG - Finance and replace the local mirror.
 * @returns {Promise<{upserted: number, removed: number}>}
 */
async function syncFromClickUp() {
  if (!env.clickup.apiKey) {
    throw new AppError(503, 'CLICKUP_NOT_CONFIGURED', 'CLICKUP_API_KEY is not set');
  }
  if (!env.clickup.financeListId) {
    throw new AppError(503, 'CLICKUP_NOT_CONFIGURED', 'CLICKUP_FINANCE_LIST_ID is not set');
  }

  const tasks = await clickupClient.listTasks(env.clickup.financeListId);
  const rows = tasks
    .map((task) => mapClickUpTask(task, env.clickup.workspaceId))
    .filter(Boolean);

  return FinanceEntry.upsertAndPrune(rows);
}

module.exports = { syncFromClickUp, mapClickUpTask };
