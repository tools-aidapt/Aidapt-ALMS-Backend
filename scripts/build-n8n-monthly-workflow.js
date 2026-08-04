'use strict';

/**
 * Build a standalone monthly PDF report workflow for n8n import.
 *
 * Output: n8n/aims-monthly-report-outlook.json
 *
 * Flow:
 *   Cron 1st 08:15 PKT (previous month)
 *   Manual (previous month, force) / Manual July sample
 *     → Call AIMS attendance-report (period=monthly)
 *     → Format one email + PDF per employee
 *     → Prepare binary → Send via Outlook (PDF attachment)
 *     → ClickUp markdown summary
 */

const fs = require('fs');
const path = require('path');

const formatCode = fs.readFileSync(path.join('n8n', '_format-report-code.js'), 'utf8');
new Function('items', formatCode); // syntax check

const PREV_MONTH_CODE = `// Previous calendar month bounds in PKT (UTC+5, no DST).
const now = new Date();
const pktMs = now.getTime() + 5 * 60 * 60 * 1000;
const pkt = new Date(pktMs);
const y = pkt.getUTCFullYear();
const m = pkt.getUTCMonth(); // 0-based month of "today" in PKT
const prev = new Date(Date.UTC(y, m - 1, 1));
const last = new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() + 1, 0)).getUTCDate();
const pad = (n) => String(n).padStart(2, '0');
const from = \`\${prev.getUTCFullYear()}-\${pad(prev.getUTCMonth() + 1)}-01\`;
const to = \`\${prev.getUTCFullYear()}-\${pad(prev.getUTCMonth() + 1)}-\${pad(last)}\`;
return [{ json: { period: 'monthly', from, to, force: $json.force === true } }];`;

const PREP_PDF_CODE = `// Convert monthly PDF base64 → n8n binary for Outlook attachment.
const results = [];
for (const item of $input.all()) {
  const j = { ...item.json };
  const pdf = j.pdf;
  delete j.pdf;
  if (pdf && pdf.contentBase64) {
    results.push({
      json: { ...j, hasPdf: true },
      binary: {
        pdf: {
          data: pdf.contentBase64,
          fileName: pdf.filename || 'monthly.pdf',
          mimeType: pdf.contentType || 'application/pdf',
        },
      },
    });
  } else {
    results.push({ json: { ...j, hasPdf: false } });
  }
}
return results;`;

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
      'Monthly only: one PDF per employee emailed via Outlook, markdown summary to ClickUp. Cron runs 1st of month 08:15 PKT for the previous month.',
  },
  settings: {
    executionOrder: 'v1',
    timezone: 'Asia/Karachi',
  },
  active: false,
  pinData: {},
  nodes: [
    // ── Triggers ──────────────────────────────────────────────────────────
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
      position: [-320, 200],
    },
    {
      parameters: {},
      id: 'manual-prev-month-001',
      name: 'Manual — previous month',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [-320, 420],
    },
    {
      parameters: {},
      id: 'manual-july-001',
      name: 'Manual — July 2026 sample',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [-320, 640],
    },

    // ── Period resolution ─────────────────────────────────────────────────
    {
      parameters: {
        assignments: {
          assignments: [
            { id: 'f1', name: 'force', value: false, type: 'boolean' },
          ],
        },
        options: {},
      },
      id: 'force-false-001',
      name: 'force = false',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [-80, 200],
    },
    {
      parameters: {
        assignments: {
          assignments: [
            { id: 'f2', name: 'force', value: true, type: 'boolean' },
          ],
        },
        options: {},
      },
      id: 'force-true-001',
      name: 'force = true',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [-80, 420],
    },
    {
      parameters: { jsCode: PREV_MONTH_CODE },
      id: 'prev-month-bounds-001',
      name: 'Previous month bounds',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [160, 300],
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
      id: 'july-2026-set-001',
      name: 'Period = July 2026 monthly',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [160, 640],
    },

    // ── Backend + format ──────────────────────────────────────────────────
    {
      parameters: {
        method: 'POST',
        url: 'https://aidapt-alms-backend-3was.onrender.com/api/jobs/attendance-report',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'Content-Type', value: 'application/json' },
            // Replace with your JOBS_SECRET (same value as X-Job-Secret on the API).
            { name: 'X-Job-Secret', value: '1a2b3c4d5e6f7g8h9i0j' },
          ],
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody:
          "={{ JSON.stringify({ period: 'monthly', from: $json.from, to: $json.to, force: $json.force === true }) }}",
        options: {
          response: { response: {} },
          // PDF generation for full month can exceed 2 minutes.
          timeout: 300000,
        },
      },
      id: 'call-aims-monthly-001',
      name: 'Call AIMS monthly report',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [420, 400],
    },
    {
      parameters: { jsCode: formatCode },
      id: 'format-monthly-001',
      name: 'Format PDF emails + ClickUp',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [660, 400],
    },

    // ── Email path ────────────────────────────────────────────────────────
    {
      parameters: {
        fieldToSplitOut: 'emails',
        options: {},
      },
      id: 'split-emails-monthly-001',
      name: 'Split Out emails',
      type: 'n8n-nodes-base.splitOut',
      typeVersion: 1,
      position: [900, 280],
    },
    {
      parameters: { jsCode: PREP_PDF_CODE },
      id: 'prep-pdf-monthly-001',
      name: 'Prepare PDF binary',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [1140, 280],
    },
    {
      parameters: {
        conditions: {
          options: {
            caseSensitive: true,
            leftValue: '',
            typeValidation: 'strict',
            version: 2,
          },
          conditions: [
            {
              id: 'cond-has-pdf',
              leftValue: '={{ $json.hasPdf }}',
              rightValue: true,
              operator: { type: 'boolean', operation: 'equals' },
            },
          ],
          combinator: 'and',
        },
        options: {},
      },
      id: 'if-has-pdf-monthly-001',
      name: 'IF has PDF',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [1380, 280],
    },
    {
      parameters: {
        toRecipients: '={{ $json.to }}',
        subject: '={{ $json.subject }}',
        bodyContent: '={{ $json.html }}',
        additionalFields: {
          bodyContentType: 'html',
          attachments: {
            attachments: [{ binaryPropertyName: 'pdf' }],
          },
        },
      },
      id: 'outlook-pdf-monthly-001',
      name: 'Send via Outlook (PDF)',
      type: 'n8n-nodes-base.microsoftOutlook',
      typeVersion: 2,
      position: [1620, 160],
      webhookId: 'aims-monthly-outlook-pdf',
      credentials: outlookCreds,
    },
    {
      parameters: {
        toRecipients: '={{ $json.to }}',
        subject: '={{ $json.subject }}',
        bodyContent: '={{ $json.html }}',
        additionalFields: {
          bodyContentType: 'html',
        },
      },
      id: 'outlook-html-monthly-001',
      name: 'Send via Outlook (no PDF fallback)',
      type: 'n8n-nodes-base.microsoftOutlook',
      typeVersion: 2,
      position: [1620, 400],
      webhookId: 'aims-monthly-outlook-html',
      credentials: outlookCreds,
    },

    // ── ClickUp ───────────────────────────────────────────────────────────
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
      id: 'clickup-monthly-001',
      name: 'Post markdown to ClickUp Channel',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [900, 560],
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
          { node: 'Post markdown to ClickUp Channel', type: 'main', index: 0 },
        ],
      ],
    },
    'Split Out emails': {
      main: [[{ node: 'Prepare PDF binary', type: 'main', index: 0 }]],
    },
    'Prepare PDF binary': {
      main: [[{ node: 'IF has PDF', type: 'main', index: 0 }]],
    },
    'IF has PDF': {
      main: [
        [{ node: 'Send via Outlook (PDF)', type: 'main', index: 0 }],
        [{ node: 'Send via Outlook (no PDF fallback)', type: 'main', index: 0 }],
      ],
    },
  },
};

const outPath = path.join('n8n', 'aims-monthly-report-outlook.json');
fs.writeFileSync(outPath, JSON.stringify(workflow, null, 2));
console.log('wrote', outPath);
console.log('nodes:', workflow.nodes.length);
console.log('import in n8n: Workflows → Import from File →', outPath);
