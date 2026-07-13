'use strict';

const axios = require('axios');
const env = require('../config/env');

/**
 * Email dispatch via n8n.
 *
 * The backend does NOT send email directly. It POSTs a structured JSON payload
 * to an n8n webhook, and the n8n workflow performs the actual send. Each payload
 * carries an `event` discriminator plus both fully-rendered fields (to/subject/
 * html/text) and the raw structured data, so the n8n side can either relay the
 * rendered mail as-is or re-template it.
 *
 * If the webhook URL is not configured (e.g. local dev), we fall back to logging
 * the payload so the rest of the flow — and the approval link — is still visible.
 */

const webhookUrl = env.email.n8nWebhookUrl;
const configured = Boolean(webhookUrl);

const httpClient = axios.create({ timeout: 15000 });

/**
 * POST one email event to n8n.
 * @param {string} event  e.g. 'generic' | 'leave.approval_request' | 'auth.password_reset_otp'
 * @param {object} payload rendered + structured fields
 * @param {string} [url]  target webhook (defaults to the general N8N_EMAIL_WEBHOOK_URL)
 */
async function dispatch(event, payload, url = webhookUrl) {
  const body = { event, from: env.email.from, ...payload };

  if (!url) {
    // eslint-disable-next-line no-console
    console.log('[email:webhook-not-configured]', JSON.stringify(body));
    return { delivered: false, reason: 'no webhook url configured — logged only' };
  }

  const headers = { 'Content-Type': 'application/json' };
  if (env.email.n8nWebhookToken) {
    headers.Authorization = `Bearer ${env.email.n8nWebhookToken}`;
  }

  await httpClient.post(url, body, { headers });
  return { delivered: true };
}

/** Generic one-off email (e.g. new-account invite). */
function sendMail({ to, subject, html, text }) {
  return dispatch('generic', { to, subject, html, text: text || stripHtml(html) });
}

/**
 * Manager approval request with single-use approve/reject links.
 */
function sendLeaveApprovalRequest({ managerEmail, employeeName, request, token }) {
  const base = env.appBaseUrl.replace(/\/$/, '');
  const link = (action) =>
    `${base}/api/leave/requests/${request.id}/decide?token=${token}&action=${action}`;

  const approveUrl = link('approve');
  const rejectUrl = link('reject');
  const subject = `Leave request from ${employeeName} (${request.fields.LeaveType})`;
  const html = `
    <p>${escapeHtml(employeeName)} has requested <strong>${request.fields.LeaveType}</strong> leave.</p>
    <ul>
      <li>From: ${request.fields.FromDate}</li>
      <li>To: ${request.fields.ToDate}</li>
      <li>Days: ${request.fields.Days}</li>
      <li>Reason: ${escapeHtml(request.fields.Reason || '—')}</li>
    </ul>
    <p>
      <a href="${approveUrl}">Approve</a> &nbsp;|&nbsp;
      <a href="${rejectUrl}">Reject</a>
    </p>
    <p style="color:#888;font-size:12px">These links are single-use.</p>
  `;

  return dispatch('leave.approval_request', {
    to: managerEmail,
    subject,
    html,
    text: stripHtml(html),
    // Structured data so the n8n workflow can build its own template if preferred.
    data: {
      requestId: request.id,
      employeeName,
      leaveType: request.fields.LeaveType,
      fromDate: request.fields.FromDate,
      toDate: request.fields.ToDate,
      days: request.fields.Days,
      reason: request.fields.Reason || '',
      approveUrl,
      rejectUrl,
    },
  });
}

/** Notify the employee of the decision on their leave request. */
function sendLeaveDecisionNotice({ employeeEmail, employeeName, request, decision }) {
  const subject = `Your leave request was ${decision.toLowerCase()}`;
  const html = `
    <p>Hi ${escapeHtml(employeeName)},</p>
    <p>Your ${request.fields.LeaveType} leave (${request.fields.FromDate} → ${request.fields.ToDate},
       ${request.fields.Days} day(s)) has been <strong>${decision}</strong>.</p>
  `;

  return dispatch('leave.decision', {
    to: employeeEmail,
    subject,
    html,
    text: stripHtml(html),
    data: {
      requestId: request.id,
      employeeName,
      leaveType: request.fields.LeaveType,
      fromDate: request.fields.FromDate,
      toDate: request.fields.ToDate,
      days: request.fields.Days,
      decision,
    },
  });
}

/**
 * Password-reset OTP email — dispatched to the dedicated password-reset webhook
 * (N8N_PASSWORD_RESET_WEBHOOK_URL). n8n receives the subject + full content and
 * sends the actual email.
 */
function sendPasswordResetOtp({ email, name, otp, expiresMinutes = 10 }) {
  const subject = 'Your ALMS password reset code';
  const html = `
    <p>Hi ${escapeHtml(name || '')},</p>
    <p>Your ALMS password reset code is:</p>
    <p style="font-size:26px;font-weight:bold;letter-spacing:4px">${otp}</p>
    <p>It expires in ${expiresMinutes} minutes and can be used once.
       If you didn't request this, you can ignore this email.</p>
  `;
  return dispatch(
    'auth.password_reset_otp',
    { to: email, subject, html, text: stripHtml(html), data: { otp, expiresMinutes } },
    env.email.passwordResetWebhookUrl
  );
}

function stripHtml(html = '') {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = {
  sendMail,
  sendLeaveApprovalRequest,
  sendLeaveDecisionNotice,
  sendPasswordResetOtp,
  n8nConfigured: configured,
};
