'use strict';

/**
 * Standalone monthly PDF report workflow for n8n import.
 * Output: n8n/aims-monthly-report-outlook.json
 *
 * Fixes:
 *  - ONE email per manager/HR (all PDFs attached) — not 1 email per employee
 *  - Graph sendMail for multi-attachment reliability
 *  - ClickUp: short channel digest + optional task with PDF attachments
 *    (Chat API cannot attach files — use CLICKUP_MONTHLY_LIST_ID for PDFs)
 */

const fs = require('fs');
const path = require('path');

const formatCode = fs.readFileSync(path.join('n8n', '_format-report-code.js'), 'utf8');
new Function('items', formatCode);

const PREV_MONTH_CODE = `// Previous calendar month bounds in PKT (UTC+5, no DST).
const now = new Date();
const pktMs = now.getTime() + 5 * 60 * 60 * 1000;
const pkt = new Date(pktMs);
const y = pkt.getUTCFullYear();
const m = pkt.getUTCMonth();
const prev = new Date(Date.UTC(y, m - 1, 1));
const last = new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() + 1, 0)).getUTCDate();
const pad = (n) => String(n).padStart(2, '0');
const from = \`\${prev.getUTCFullYear()}-\${pad(prev.getUTCMonth() + 1)}-01\`;
const to = \`\${prev.getUTCFullYear()}-\${pad(prev.getUTCMonth() + 1)}-\${pad(last)}\`;
return [{ json: { period: 'monthly', from, to, force: $json.force === true } }];`;

const GRAPH_BODY_CODE = `// Build Microsoft Graph /me/sendMail body with multi-PDF attachments.
// One package email per manager (not one email per employee).
const out = [];
for (const item of $input.all()) {
  const j = item.json;
  const attachments = (j.attachments || []).map((a) => ({
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: a.filename || 'monthly.pdf',
    contentType: a.contentType || 'application/pdf',
    contentBytes: a.contentBase64,
  }));
  out.push({
    json: {
      to: j.to,
      subject: j.subject,
      pdfCount: attachments.length,
      graphBody: {
        message: {
          subject: j.subject,
          body: {
            contentType: 'HTML',
            content: j.html || ' ',
          },
          toRecipients: [
            {
              emailAddress: { address: j.to },
            },
          ],
          attachments,
        },
        saveToSentItems: true,
      },
    },
  });
}
return out;`;

const PREP_CLICKUP_PDFS = `// Emit one item per org PDF for ClickUp task attachment upload.
const root = $('Format PDF emails + ClickUp').first().json;
const pdfs = Array.isArray(root.clickupPdfs) ? root.clickupPdfs : [];
const taskId = $json.id || $json.task_id || null;
if (!taskId) {
  throw new Error('ClickUp task id missing — create task first');
}
if (!pdfs.length) {
  return [{ json: { skipped: true, reason: 'no_pdfs', taskId } }];
}
return pdfs.map((p) => ({
  json: {
    taskId,
    filename: p.filename,
    contentBase64: p.contentBase64,
    contentType: p.contentType || 'application/pdf',
    employeeName: p.employeeName || null,
  },
  binary: {
    data: {
      data: p.contentBase64,
      fileName: p.filename || 'monthly.pdf',
      mimeType: p.contentType || 'application/pdf',
    },
  },
}));`;

const outlookCreds = {
  microsoftOutlookOAuth2Api: {
    id: 'm9WTLZOWpRKaVwEa',
    name: 'Sofi',
  },
};

const workflow = {
  name: 'AIMS — Monthly Attendance Report (PDF) → Outlook + ClickUp',
  meta: {
    templateCredsSetupCompleted: true,
    instanceId: '3995614c53330b8235732b6439f4722022fa77b84f9cd17e44c49abe50c94c1f',
    description:
      'Monthly: one package email per manager/HR with all employee PDFs attached. Short markdown to ClickUp Chat; PDFs uploaded to a ClickUp task when CLICKUP_MONTHLY_LIST_ID is set.',
  },
  settings: {
    executionOrder: 'v1',
    timezone: 'Asia/Karachi',
  },
  active: false,
  pinData: {},
  nodes: [
    {
      parameters: {
        rule: {
          interval: [{ field: 'cronExpression', expression: '15 8 1 * *' }],
        },
      },
      id: 'cron-monthly-001',
      name: 'Cron 1st 08:15 PKT',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [-400, 160],
    },
    {
      parameters: {},
      id: 'manual-prev-001',
      name: 'Manual — previous month',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [-400, 360],
    },
    {
      parameters: {},
      id: 'manual-july-001',
      name: 'Manual — July 2026 sample',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [-400, 560],
    },
    {
      parameters: {
        assignments: {
          assignments: [{ id: 'f1', name: 'force', value: false, type: 'boolean' }],
        },
        options: {},
      },
      id: 'force-false-001',
      name: 'force = false',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [-160, 160],
    },
    {
      parameters: {
        assignments: {
          assignments: [{ id: 'f2', name: 'force', value: true, type: 'boolean' }],
        },
        options: {},
      },
      id: 'force-true-001',
      name: 'force = true',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [-160, 360],
    },
    {
      parameters: { jsCode: PREV_MONTH_CODE },
      id: 'prev-bounds-001',
      name: 'Previous month bounds',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [80, 260],
    },
    {
      parameters: {
        assignments: {
          assignments: [
            { id: 'j1', name: 'period', value: 'monthly', type: 'string' },
            { id: 'j2', name: 'from', value: '2026-07-01', type: 'string' },
            { id: 'j3', name: 'to', value: '2026-07-31', type: 'string' },
            { id: 'j4', name: 'force', value: true, type: 'boolean' },
          ],
        },
        options: {},
      },
      id: 'july-set-001',
      name: 'Period = July 2026 monthly',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [80, 560],
    },
    {
      parameters: {
        method: 'POST',
        url: 'https://aidapt-alms-backend-3was.onrender.com/api/jobs/attendance-report',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'X-Job-Secret', value: '1a2b3c4d5e6f7g8h9i0j' },
          ],
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody:
          "={{ JSON.stringify({ period: 'monthly', from: $json.from, to: $json.to, force: $json.force === true }) }}",
        options: {
          response: { response: {} },
          timeout: 300000,
        },
      },
      id: 'call-aims-001',
      name: 'Call AIMS monthly report',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [340, 360],
    },
    {
      parameters: { jsCode: formatCode },
      id: 'format-001',
      name: 'Format PDF emails + ClickUp',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [580, 360],
    },

    // ── Email: package per manager ────────────────────────────────────────
    {
      parameters: {
        fieldToSplitOut: 'emails',
        options: {},
      },
      id: 'split-emails-001',
      name: 'Split Out emails',
      type: 'n8n-nodes-base.splitOut',
      typeVersion: 1,
      position: [820, 200],
    },
    {
      parameters: { jsCode: GRAPH_BODY_CODE },
      id: 'graph-body-001',
      name: 'Build Graph sendMail body',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [1060, 200],
    },
    {
      parameters: {
        method: 'POST',
        url: 'https://graph.microsoft.com/v1.0/me/sendMail',
        authentication: 'predefinedCredentialType',
        nodeCredentialType: 'microsoftOutlookOAuth2Api',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ $json.graphBody }}',
        options: { timeout: 120000 },
      },
      id: 'graph-send-001',
      name: 'Send package email (Graph)',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [1300, 200],
      credentials: outlookCreds,
    },

    // ── ClickUp Chat digest (markdown only — API cannot attach files here) ─
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
          "={{ JSON.stringify({ type: 'message', content_format: 'text/md', content: $json.clickupMarkdown + '\\n\\n_PDFs emailed to managers. Full PDFs also land on the monthly ClickUp task when CLICKUP_MONTHLY_LIST_ID is set._' }) }}",
        options: { timeout: 60000 },
      },
      id: 'clickup-chat-001',
      name: 'Post digest to ClickUp Chat',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [820, 480],
    },

    // ── ClickUp task + PDF attachments (optional via env list id) ─────────
    {
      parameters: {
        conditions: {
          options: {
            caseSensitive: true,
            leftValue: '',
            typeValidation: 'loose',
            version: 2,
          },
          conditions: [
            {
              id: 'has-list',
              leftValue: '={{ $env.CLICKUP_MONTHLY_LIST_ID }}',
              rightValue: '',
              operator: { type: 'string', operation: 'notEmpty' },
            },
          ],
          combinator: 'and',
        },
        options: {},
      },
      id: 'if-clickup-list-001',
      name: 'IF ClickUp list configured',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [820, 680],
    },
    {
      parameters: {
        method: 'POST',
        url: '=https://api.clickup.com/api/v2/list/{{ $env.CLICKUP_MONTHLY_LIST_ID }}/task',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'Authorization', value: '={{ $env.CLICKUP_API_TOKEN }}' },
            { name: 'Content-Type', value: 'application/json' },
          ],
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody:
          "={{ JSON.stringify({ name: $json.clickupTaskName || $json.subject, markdown_description: $json.clickupMarkdown, status: 'to do' }) }}",
        options: { timeout: 60000 },
      },
      id: 'create-clickup-task-001',
      name: 'Create ClickUp task',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [1060, 640],
    },
    {
      parameters: { jsCode: PREP_CLICKUP_PDFS },
      id: 'prep-cu-pdfs-001',
      name: 'Prepare ClickUp PDF items',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [1300, 640],
    },
    {
      parameters: {
        method: 'POST',
        url: '=https://api.clickup.com/api/v2/task/{{ $json.taskId }}/attachment',
        sendHeaders: true,
        headerParameters: {
          parameters: [{ name: 'Authorization', value: '={{ $env.CLICKUP_API_TOKEN }}' }],
        },
        sendBody: true,
        contentType: 'multipart-form-data',
        bodyParameters: {
          parameters: [
            {
              parameterType: 'formBinaryData',
              name: 'attachment',
              inputDataFieldName: 'data',
            },
          ],
        },
        options: { timeout: 120000 },
      },
      id: 'upload-cu-pdf-001',
      name: 'Upload PDF to ClickUp task',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [1540, 640],
    },
  ],
  connections: {
    'Cron 1st 08:15 PKT': {
      main: [[{ node: 'force = false', type: 'main', index: 0 }]],
    },
    'Manual — previous month': {
      main: [[{ node: 'force = true', type: 'main', index: 0 }]],
    },
    'Manual — July 2026 sample': {
      main: [[{ node: 'Period = July 2026 monthly', type: 'main', index: 0 }]],
    },
    'force = false': {
      main: [[{ node: 'Previous month bounds', type: 'main', index: 0 }]],
    },
    'force = true': {
      main: [[{ node: 'Previous month bounds', type: 'main', index: 0 }]],
    },
    'Previous month bounds': {
      main: [[{ node: 'Call AIMS monthly report', type: 'main', index: 0 }]],
    },
    'Period = July 2026 monthly': {
      main: [[{ node: 'Call AIMS monthly report', type: 'main', index: 0 }]],
    },
    'Call AIMS monthly report': {
      main: [[{ node: 'Format PDF emails + ClickUp', type: 'main', index: 0 }]],
    },
    'Format PDF emails + ClickUp': {
      main: [
        [
          { node: 'Split Out emails', type: 'main', index: 0 },
          { node: 'Post digest to ClickUp Chat', type: 'main', index: 0 },
          { node: 'IF ClickUp list configured', type: 'main', index: 0 },
        ],
      ],
    },
    'Split Out emails': {
      main: [[{ node: 'Build Graph sendMail body', type: 'main', index: 0 }]],
    },
    'Build Graph sendMail body': {
      main: [[{ node: 'Send package email (Graph)', type: 'main', index: 0 }]],
    },
    'IF ClickUp list configured': {
      main: [[{ node: 'Create ClickUp task', type: 'main', index: 0 }], []],
    },
    'Create ClickUp task': {
      main: [[{ node: 'Prepare ClickUp PDF items', type: 'main', index: 0 }]],
    },
    'Prepare ClickUp PDF items': {
      main: [[{ node: 'Upload PDF to ClickUp task', type: 'main', index: 0 }]],
    },
  },
};

const outPath = path.join('n8n', 'aims-monthly-report-outlook.json');
fs.writeFileSync(outPath, JSON.stringify(workflow, null, 2));
console.log('wrote', outPath);

// Also refresh combined workflow format code
require('./build-n8n-workflow.js');
