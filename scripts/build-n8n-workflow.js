'use strict';

const fs = require('fs');

const formatCode = fs.readFileSync('n8n/_format-report-code.js', 'utf8');
new Function('items', formatCode); // syntax check

const workflow = {
  name: 'AIMS — Attendance Report → Outlook + ClickUp',
  meta: {
    templateCredsSetupCompleted: true,
    instanceId: '3995614c53330b8235732b6439f4722022fa77b84f9cd17e44c49abe50c94c1f',
    description:
      'Cron AIMS attendance-report, email scoped HTML via Outlook, post markdown to ClickUp Chat channel.',
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
          interval: [{ field: 'cronExpression', expression: '45 23 * * *' }],
        },
      },
      id: '35fcf499-3160-4f94-89d5-2c9aa877250c',
      name: 'Cron Daily 23:45 PKT',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [-176, 16],
    },
    {
      parameters: {
        rule: {
          interval: [{ field: 'cronExpression', expression: '0 8 * * 1' }],
        },
      },
      id: '574e2a97-a84f-441c-954f-660f1c4635b2',
      name: 'Cron Weekly Mon 08:00 PKT',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [-176, 240],
    },
    {
      parameters: {
        rule: {
          interval: [{ field: 'cronExpression', expression: '15 8 1 * *' }],
        },
      },
      id: 'c1d9a74b-629d-4226-8337-64563c6b39f1',
      name: 'Cron Monthly 1st 08:15 PKT',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [-176, 464],
    },
    {
      parameters: {
        assignments: {
          assignments: [
            { id: 'p1', name: 'period', value: 'daily', type: 'string' },
          ],
        },
        options: {},
      },
      id: '897e4aef-1ef1-4490-9303-f01f0e1b3845',
      name: 'Period = daily',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [96, 16],
    },
    {
      parameters: {
        assignments: {
          assignments: [
            { id: 'p2', name: 'period', value: 'weekly', type: 'string' },
          ],
        },
        options: {},
      },
      id: '001b9639-d929-41a6-b56f-4a772a24537f',
      name: 'Period = weekly',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [96, 240],
    },
    {
      parameters: {
        assignments: {
          assignments: [
            { id: 'p3', name: 'period', value: 'monthly', type: 'string' },
          ],
        },
        options: {},
      },
      id: '6c42ad74-f0fa-4fbb-8c62-564bce2475f3',
      name: 'Period = monthly',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [96, 464],
    },
    {
      parameters: {},
      id: '17798020-dc37-48fa-829d-23c2de0cddd3',
      name: 'Manual Test (daily)',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [-176, 688],
    },
    {
      parameters: {
        assignments: {
          assignments: [
            { id: 'p4', name: 'period', value: 'daily', type: 'string' },
            { id: 'p5', name: 'force', value: true, type: 'boolean' },
          ],
        },
        options: {},
      },
      id: 'e6394a9e-0cdf-412b-8524-dcc958d79b27',
      name: 'Period = daily (manual)',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [96, 688],
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
          "={{ JSON.stringify({ period: $json.period, force: $json.force === true }) }}",
        options: {
          response: { response: {} },
          timeout: 120000,
        },
      },
      id: 'af8641c7-5dd2-4ba2-a230-34a3aa1f7dff',
      name: 'Call AIMS attendance-report',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [352, 320],
    },
    {
      parameters: { jsCode: formatCode },
      id: '57153e1d-8a4c-4dd6-8f91-e297b893d283',
      name: 'Format email + ClickUp markdown',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [592, 320],
    },
    {
      parameters: {
        fieldToSplitOut: 'emails',
        options: {},
      },
      id: 'split-emails-001',
      name: 'Split Out emails',
      type: 'n8n-nodes-base.splitOut',
      typeVersion: 1,
      position: [832, 208],
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
      id: '1c9dcd65-55e7-4906-a5de-05ca976a75c7',
      name: 'Send via Outlook',
      type: 'n8n-nodes-base.microsoftOutlook',
      typeVersion: 2,
      position: [1072, 208],
      webhookId: 'bb46f75e-ebca-42ff-acd4-c2070fa0ba46',
      credentials: {
        microsoftOutlookOAuth2Api: {
          id: 'm9WTLZOWpRKaVwEa',
          name: 'Sofi',
        },
      },
    },
    {
      parameters: {
        method: 'POST',
        // Fill these n8n env vars: CLICKUP_WORKSPACE_ID, CLICKUP_CHANNEL_ID, CLICKUP_API_TOKEN
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
      name: 'Post markdown to ClickUp Channel',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [832, 448],
    },
  ],
  connections: {
    'Cron Daily 23:45 PKT': {
      main: [[{ node: 'Period = daily', type: 'main', index: 0 }]],
    },
    'Cron Weekly Mon 08:00 PKT': {
      main: [[{ node: 'Period = weekly', type: 'main', index: 0 }]],
    },
    'Cron Monthly 1st 08:15 PKT': {
      main: [[{ node: 'Period = monthly', type: 'main', index: 0 }]],
    },
    'Manual Test (daily)': {
      main: [[{ node: 'Period = daily (manual)', type: 'main', index: 0 }]],
    },
    'Period = daily': {
      main: [[{ node: 'Call AIMS attendance-report', type: 'main', index: 0 }]],
    },
    'Period = weekly': {
      main: [[{ node: 'Call AIMS attendance-report', type: 'main', index: 0 }]],
    },
    'Period = monthly': {
      main: [[{ node: 'Call AIMS attendance-report', type: 'main', index: 0 }]],
    },
    'Period = daily (manual)': {
      main: [[{ node: 'Call AIMS attendance-report', type: 'main', index: 0 }]],
    },
    'Call AIMS attendance-report': {
      main: [[{ node: 'Format email + ClickUp markdown', type: 'main', index: 0 }]],
    },
    'Format email + ClickUp markdown': {
      main: [
        [
          { node: 'Split Out emails', type: 'main', index: 0 },
          { node: 'Post markdown to ClickUp Channel', type: 'main', index: 0 },
        ],
      ],
    },
    'Split Out emails': {
      main: [[{ node: 'Send via Outlook', type: 'main', index: 0 }]],
    },
  },
};

fs.writeFileSync(
  'n8n/aims-attendance-report-outlook.json',
  JSON.stringify(workflow, null, 2)
);
console.log('wrote n8n/aims-attendance-report-outlook.json');
