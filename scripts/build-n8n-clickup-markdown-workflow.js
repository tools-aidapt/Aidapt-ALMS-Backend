'use strict';

/**
 * AIMS attendance report → ClickUp Chat (markdown only).
 * No Outlook / PDF path.
 *
 * Output: n8n/aims-attendance-report-clickup-markdown.json
 *
 * Env required in n8n:
 *   CLICKUP_WORKSPACE_ID
 *   CLICKUP_CHANNEL_ID
 *   CLICKUP_API_TOKEN
 *
 * Header X-Job-Secret must match backend JOBS_SECRET.
 */

const fs = require('fs');
const path = require('path');

const formatCode = fs.readFileSync(path.join('n8n', '_format-report-code.js'), 'utf8');
new Function('items', formatCode);

const PREV_MONTH_CODE = `// Previous calendar month in PKT (UTC+5).
const now = new Date();
const pkt = new Date(now.getTime() + 5 * 60 * 60 * 1000);
const y = pkt.getUTCFullYear();
const m = pkt.getUTCMonth();
const prev = new Date(Date.UTC(y, m - 1, 1));
const last = new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() + 1, 0)).getUTCDate();
const pad = (n) => String(n).padStart(2, '0');
return [{
  json: {
    period: 'monthly',
    from: \`\${prev.getUTCFullYear()}-\${pad(prev.getUTCMonth() + 1)}-01\`,
    to: \`\${prev.getUTCFullYear()}-\${pad(prev.getUTCMonth() + 1)}-\${pad(last)}\`,
    force: $json.force === true,
  },
}];`;

const PREV_WEEK_CODE = `// Previous Mon–Sun week relative to "yesterday" in PKT.
const now = new Date();
const pkt = new Date(now.getTime() + 5 * 60 * 60 * 1000);
const y = pkt.getUTCFullYear();
const mon = pkt.getUTCMonth();
const d = pkt.getUTCDate();
const yesterday = new Date(Date.UTC(y, mon, d - 1));
const dow = yesterday.getUTCDay(); // 0=Sun … 6=Sat
const daysSinceMon = dow === 0 ? 6 : dow - 1;
const monday = new Date(yesterday.getTime() - daysSinceMon * 86400000);
const sunday = new Date(monday.getTime() + 6 * 86400000);
const pad = (n) => String(n).padStart(2, '0');
const fmt = (dt) => \`\${dt.getUTCFullYear()}-\${pad(dt.getUTCMonth() + 1)}-\${pad(dt.getUTCDate())}\`;
return [{
  json: {
    period: 'weekly',
    from: fmt(monday),
    to: fmt(sunday),
    force: $json.force === true,
  },
}];`;

const TODAY_DAILY_CODE = `// Today in PKT.
const now = new Date();
const pkt = new Date(now.getTime() + 5 * 60 * 60 * 1000);
const pad = (n) => String(n).padStart(2, '0');
const date = \`\${pkt.getUTCFullYear()}-\${pad(pkt.getUTCMonth() + 1)}-\${pad(pkt.getUTCDate())}\`;
return [{
  json: {
    period: 'daily',
    date,
    force: $json.force === true,
  },
}];`;

function setNode(id, name, position, assignments) {
  return {
    parameters: {
      assignments: { assignments },
      options: {},
    },
    id,
    name,
    type: 'n8n-nodes-base.set',
    typeVersion: 3.4,
    position,
  };
}

function manual(id, name, position) {
  return {
    parameters: {},
    id,
    name,
    type: 'n8n-nodes-base.manualTrigger',
    typeVersion: 1,
    position,
  };
}

function cron(id, name, position, expression) {
  return {
    parameters: {
      rule: {
        interval: [{ field: 'cronExpression', expression }],
      },
    },
    id,
    name,
    type: 'n8n-nodes-base.scheduleTrigger',
    typeVersion: 1.2,
    position,
  };
}

function code(id, name, position, jsCode) {
  return {
    parameters: { jsCode },
    id,
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position,
  };
}

const workflow = {
  name: 'AIMS — Attendance Report → ClickUp (Markdown)',
  meta: {
    templateCredsSetupCompleted: true,
    instanceId: '3995614c53330b8235732b6439f4722022fa77b84f9cd17e44c49abe50c94c1f',
    description:
      'Posts daily / weekly / monthly AIMS attendance reports to a ClickUp Chat channel as markdown. No email/PDF.',
  },
  settings: {
    executionOrder: 'v1',
    timezone: 'Asia/Karachi',
  },
  active: false,
  pinData: {},
  nodes: [
    // ── Crons ─────────────────────────────────────────────────────────────
    cron('cron-daily-001', 'Cron Daily 23:45 PKT', [-400, 80], '45 23 * * *'),
    cron('cron-weekly-001', 'Cron Weekly Mon 08:00 PKT', [-400, 280], '0 8 * * 1'),
    cron('cron-monthly-001', 'Cron Monthly 1st 08:15 PKT', [-400, 480], '15 8 1 * *'),

    // ── Manual ────────────────────────────────────────────────────────────
    manual('manual-daily-001', 'Manual — daily', [-400, 680]),
    manual('manual-weekly-001', 'Manual — weekly', [-400, 860]),
    manual('manual-monthly-001', 'Manual — monthly (prev)', [-400, 1040]),
    manual('manual-july-001', 'Manual — July 2026 monthly', [-400, 1220]),

    // force flags
    setNode('force-off-d', 'force=false (daily cron)', [-160, 80], [
      { id: 'a1', name: 'force', value: false, type: 'boolean' },
    ]),
    setNode('force-off-w', 'force=false (weekly cron)', [-160, 280], [
      { id: 'a2', name: 'force', value: false, type: 'boolean' },
    ]),
    setNode('force-off-m', 'force=false (monthly cron)', [-160, 480], [
      { id: 'a3', name: 'force', value: false, type: 'boolean' },
    ]),
    setNode('force-on-d', 'force=true (daily manual)', [-160, 680], [
      { id: 'a4', name: 'force', value: true, type: 'boolean' },
    ]),
    setNode('force-on-w', 'force=true (weekly manual)', [-160, 860], [
      { id: 'a5', name: 'force', value: true, type: 'boolean' },
    ]),
    setNode('force-on-m', 'force=true (monthly manual)', [-160, 1040], [
      { id: 'a6', name: 'force', value: true, type: 'boolean' },
    ]),
    setNode('july-set', 'Period = July 2026 monthly', [120, 1220], [
      { id: 'j1', name: 'period', value: 'monthly', type: 'string' },
      { id: 'j2', name: 'from', value: '2026-07-01', type: 'string' },
      { id: 'j3', name: 'to', value: '2026-07-31', type: 'string' },
      { id: 'j4', name: 'force', value: true, type: 'boolean' },
    ]),

    // bounds
    code('bounds-daily', 'Today (daily)', [120, 200], TODAY_DAILY_CODE),
    code('bounds-weekly', 'Previous week bounds', [120, 400], PREV_WEEK_CODE),
    code('bounds-monthly', 'Previous month bounds', [120, 600], PREV_MONTH_CODE),

    // API
    {
      parameters: {
        method: 'POST',
        url: 'https://aidapt-alms-backend-3was.onrender.com/api/jobs/attendance-report',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'Content-Type', value: 'application/json' },
            // Must match backend JOBS_SECRET
            { name: 'X-Job-Secret', value: '1a2b3c4d5e6f7g8h9i0j' },
          ],
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody:
          "={{ (() => { const b = { period: $json.period, force: $json.force === true }; if ($json.from) b.from = $json.from; if ($json.to) b.to = $json.to; if ($json.date) b.date = $json.date; return JSON.stringify(b); })() }}",
        options: {
          response: { response: {} },
          timeout: 300000,
        },
      },
      id: 'call-aims-001',
      name: 'Call AIMS attendance-report',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [420, 480],
    },

    // Format → markdown only (format script still builds emails; we only use markdown)
    {
      parameters: { jsCode: formatCode },
      id: 'format-001',
      name: 'Format ClickUp markdown',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [680, 480],
    },

    // ClickUp Chat
    {
      parameters: {
        method: 'POST',
        url: '=https://api.clickup.com/api/v3/workspaces/{{ $env.CLICKUP_WORKSPACE_ID }}/chat/channels/{{ $env.CLICKUP_CHANNEL_ID }}/messages',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'Authorization', value: '={{ $env.CLICKUP_API_TOKEN }}' },
            { name: 'Content-Type', value: 'application/json' },
            { name: 'accept', value: 'application/json' },
          ],
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody:
          "={{ JSON.stringify({ type: 'message', content_format: 'text/md', content: $json.clickupMarkdown }) }}",
        options: { timeout: 60000 },
      },
      id: 'post-clickup-001',
      name: 'Post markdown to ClickUp Chat',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [940, 480],
    },
  ],
  connections: {
    'Cron Daily 23:45 PKT': {
      main: [[{ node: 'force=false (daily cron)', type: 'main', index: 0 }]],
    },
    'Cron Weekly Mon 08:00 PKT': {
      main: [[{ node: 'force=false (weekly cron)', type: 'main', index: 0 }]],
    },
    'Cron Monthly 1st 08:15 PKT': {
      main: [[{ node: 'force=false (monthly cron)', type: 'main', index: 0 }]],
    },
    'Manual — daily': {
      main: [[{ node: 'force=true (daily manual)', type: 'main', index: 0 }]],
    },
    'Manual — weekly': {
      main: [[{ node: 'force=true (weekly manual)', type: 'main', index: 0 }]],
    },
    'Manual — monthly (prev)': {
      main: [[{ node: 'force=true (monthly manual)', type: 'main', index: 0 }]],
    },
    'Manual — July 2026 monthly': {
      main: [[{ node: 'Period = July 2026 monthly', type: 'main', index: 0 }]],
    },
    'force=false (daily cron)': {
      main: [[{ node: 'Today (daily)', type: 'main', index: 0 }]],
    },
    'force=false (weekly cron)': {
      main: [[{ node: 'Previous week bounds', type: 'main', index: 0 }]],
    },
    'force=false (monthly cron)': {
      main: [[{ node: 'Previous month bounds', type: 'main', index: 0 }]],
    },
    'force=true (daily manual)': {
      main: [[{ node: 'Today (daily)', type: 'main', index: 0 }]],
    },
    'force=true (weekly manual)': {
      main: [[{ node: 'Previous week bounds', type: 'main', index: 0 }]],
    },
    'force=true (monthly manual)': {
      main: [[{ node: 'Previous month bounds', type: 'main', index: 0 }]],
    },
    'Today (daily)': {
      main: [[{ node: 'Call AIMS attendance-report', type: 'main', index: 0 }]],
    },
    'Previous week bounds': {
      main: [[{ node: 'Call AIMS attendance-report', type: 'main', index: 0 }]],
    },
    'Previous month bounds': {
      main: [[{ node: 'Call AIMS attendance-report', type: 'main', index: 0 }]],
    },
    'Period = July 2026 monthly': {
      main: [[{ node: 'Call AIMS attendance-report', type: 'main', index: 0 }]],
    },
    'Call AIMS attendance-report': {
      main: [[{ node: 'Format ClickUp markdown', type: 'main', index: 0 }]],
    },
    'Format ClickUp markdown': {
      main: [[{ node: 'Post markdown to ClickUp Chat', type: 'main', index: 0 }]],
    },
  },
};

const out = path.join('n8n', 'aims-attendance-report-clickup-markdown.json');
fs.writeFileSync(out, JSON.stringify(workflow, null, 2));
console.log('wrote', out);
console.log('nodes:', workflow.nodes.length);
