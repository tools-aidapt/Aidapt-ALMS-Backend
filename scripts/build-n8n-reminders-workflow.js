'use strict';

/**
 * Assembles n8n/aims-attendance-reminders-outlook.json
 * Run: node scripts/build-n8n-reminders-workflow.js
 */

const fs = require('fs');

const formatCode = fs.readFileSync('n8n/_format-reminder-email.js', 'utf8');
new Function('items', formatCode);

const filterCode = `const raw = items[0].json;
// n8n Webhook v2 often puts the POST JSON on .body
const payload =
  raw.body && typeof raw.body === 'object' && (raw.body.event || raw.body.to || raw.body.emailReason)
    ? raw.body
    : raw;
const event = payload.event || '';
const reason = payload.emailReason || '';
if (event !== 'attendance.reminder' && reason !== 'attendance_reminder') {
  return [];
}
return [{ json: payload }];
`;

const workflow = {
  name: 'AIMS — Attendance Reminders → Outlook',
  meta: {
    templateCredsSetupCompleted: true,
    instanceId: '3995614c53330b8235732b6439f4722022fa77b84f9cd17e44c49abe50c94c1f',
    description:
      'Every minute triggers AIMS reminder job; webhook receives attendance.reminder and emails via Outlook (Aidapt branded). Set N8N_EMAIL_WEBHOOK_URL to this webhook Production URL.',
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
          interval: [{ field: 'cronExpression', expression: '* * * * *' }],
        },
      },
      id: 'cron-reminders-every-min',
      name: 'Cron every minute PKT',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [-200, 0],
    },
    {
      parameters: {},
      id: 'manual-reminders',
      name: 'Manual Test reminders',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [-200, 200],
    },
    {
      parameters: {
        method: 'POST',
        url: 'https://aidapt-alms-backend-3was.onrender.com/api/jobs/attendance-reminders',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'X-Job-Secret', value: '1a2b3c4d5e6f7g8h9i0j' },
          ],
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={}',
        options: {
          timeout: 120000,
          response: { response: {} },
        },
      },
      id: 'http-run-reminders',
      name: 'Call AIMS attendance-reminders',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [120, 80],
    },
    {
      parameters: {
        httpMethod: 'POST',
        path: 'aims-email',
        responseMode: 'onReceived',
        options: {},
      },
      id: 'webhook-email',
      name: 'Webhook — AIMS email events',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [-200, 420],
      webhookId: 'aims-email-webhook',
    },
    {
      parameters: { jsCode: filterCode },
      id: 'filter-reminder-only',
      name: 'Filter — reminders only',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [120, 420],
    },
    {
      parameters: { jsCode: formatCode },
      id: 'format-reminder-email',
      name: 'Format Aidapt reminder email',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [400, 420],
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
      id: 'outlook-send-reminder',
      name: 'Send reminder via Outlook',
      type: 'n8n-nodes-base.microsoftOutlook',
      typeVersion: 2,
      position: [680, 420],
      webhookId: 'bb46f75e-ebca-42ff-acd4-c2070fa0ba46',
      credentials: {
        microsoftOutlookOAuth2Api: {
          id: 'm9WTLZOWpRKaVwEa',
          name: 'Sofi',
        },
      },
    },
  ],
  connections: {
    'Cron every minute PKT': {
      main: [[{ node: 'Call AIMS attendance-reminders', type: 'main', index: 0 }]],
    },
    'Manual Test reminders': {
      main: [[{ node: 'Call AIMS attendance-reminders', type: 'main', index: 0 }]],
    },
    'Webhook — AIMS email events': {
      main: [[{ node: 'Filter — reminders only', type: 'main', index: 0 }]],
    },
    'Filter — reminders only': {
      main: [[{ node: 'Format Aidapt reminder email', type: 'main', index: 0 }]],
    },
    'Format Aidapt reminder email': {
      main: [[{ node: 'Send reminder via Outlook', type: 'main', index: 0 }]],
    },
  },
};

fs.writeFileSync(
  'n8n/aims-attendance-reminders-outlook.json',
  JSON.stringify(workflow, null, 2)
);
console.log('wrote n8n/aims-attendance-reminders-outlook.json');
console.log(workflow.nodes.map((n) => n.name).join('\n'));
