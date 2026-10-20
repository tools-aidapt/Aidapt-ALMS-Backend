'use strict';

const axios = require('axios');
const env = require('../config/env');
const { pktTimeLabel } = require('../utils/dateUtils');

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
 * POST one email event to an n8n webhook.
 * @param {string} event  e.g. 'generic' | 'leave.approval_request' | 'attendance.reminder'
 * @param {object} payload rendered + structured fields
 * @param {{url?: string}} [opts] optional override webhook URL (dedicated flows)
 */
async function dispatch(event, payload, opts = {}) {
  const url = opts.url || webhookUrl;
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

  // eslint-disable-next-line no-console
  console.log(
    `[email:webhook] POST event=${event} emailReason=${payload.emailReason || '-'} to=${payload.to || '-'} url=${url}`
  );

  try {
    const resp = await httpClient.post(url, body, { headers });
    // eslint-disable-next-line no-console
    console.log(`[email:webhook] delivered event=${event} status=${resp.status}`);
    return { delivered: true, status: resp.status };
  } catch (err) {
    const status = err.response ? err.response.status : 'no-response';
    // eslint-disable-next-line no-console
    console.error(
      `[email:webhook] FAILED event=${event} status=${status} error=${err.message}`
    );
    throw err;
  }
}

/** Generic one-off email (e.g. new-account invite). */
function sendMail({ to, subject, html, text }) {
  return dispatch('generic', { to, subject, html, text: text || stripHtml(html) });
}

/**
 * Approval request with single-use approve/reject links.
 * stage 'manager' goes to the employee's manager; stage 'final' goes to Hitesh
 * after the manager has approved.
 */
function sendLeaveApprovalRequest({
  managerEmail,
  approverEmail,
  approverName,
  stage = 'manager',
  finalApproverName,
  managerName,
  employeeName,
  employeeEmail,
  request,
  token,
}) {
  const to = approverEmail || managerEmail;
  const isFinal = stage === 'final';
  const base = env.appBaseUrl.replace(/\/$/, '');
  const link = (action) =>
    `${base}/api/leave/requests/${request.id}/decide?token=${token}&action=${action}`;

  const approveUrl = link('approve');
  const rejectUrl = link('reject');
  const leaveType = request.fields.LeaveType;
  const subject = isFinal
    ? `Final approval needed: ${employeeName}'s ${leaveType} leave`
    : `Leave request from ${employeeName} (${leaveType})`;
  const nextApprover = finalApproverName || 'the final approver';
  const intro = isFinal
    ? `${escapeHtml(employeeName)}'s <strong>${leaveType}</strong> leave was approved${
        managerName ? ` by ${escapeHtml(managerName)}` : ' by their manager'
      } and now needs your final approval.`
    : `${escapeHtml(employeeName)} has requested <strong>${leaveType}</strong> leave. If you approve, it goes to ${escapeHtml(nextApprover)} for final approval.`;
  const html = `
    <p>${intro}</p>
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
    emailReason: 'leave',
    to,
    employeeName,
    employeeEmail: employeeEmail || null,
    subject,
    html,
    text: stripHtml(html),
    // Structured data so the n8n workflow can build its own template if preferred.
    data: {
      requestId: request.id,
      stage,
      employeeName,
      employeeEmail: employeeEmail || null,
      approverName: approverName || null,
      approverEmail: to,
      managerEmail: to,
      managerName: managerName || null,
      finalApproverName: nextApprover,
      leaveType,
      fromDate: request.fields.FromDate,
      toDate: request.fields.ToDate,
      days: request.fields.Days,
      reason: request.fields.Reason || '',
      approveUrl,
      rejectUrl,
    },
  });
}

/**
 * Notify the manager that an employee submitted a regularization request.
 * Regularization is approved in-app (no token link), so this points the manager
 * to the app to review their approval queue.
 */
function sendRegularizationApprovalRequest({ managerEmail, employeeName, employeeEmail, request }) {
  const base = env.appBaseUrl.replace(/\/$/, '');
  const f = request.fields;
  const checkIn = pktTimeLabel(f.RequestedCheckInTime) || '—';
  const checkOut = pktTimeLabel(f.RequestedCheckOutTime) || '—';
  const subject = `Regularization request from ${employeeName} (${f.Date})`;
  const html = `
    <p>${escapeHtml(employeeName)} has requested an attendance regularization.</p>
    <ul>
      <li>Date: ${f.Date}</li>
      <li>Requested check-in: ${checkIn}</li>
      <li>Requested check-out: ${checkOut}</li>
      <li>Reason: ${escapeHtml(f.Reason || '—')}</li>
    </ul>
    <p>Log in to review and approve or reject: <a href="${base}">${base}</a></p>
  `;

  return dispatch('regularization.approval_request', {
    emailReason: 'regularization',
    to: managerEmail,
    employeeName,
    employeeEmail: employeeEmail || null,
    subject,
    html,
    text: stripHtml(html),
    // Structured data so the n8n workflow can re-template if preferred.
    data: {
      requestId: request.id,
      employeeName,
      employeeEmail: employeeEmail || null,
      managerEmail,
      date: f.Date,
      requestedCheckInTime: f.RequestedCheckInTime || null,
      requestedCheckOutTime: f.RequestedCheckOutTime || null,
      requestedCheckInPkt: pktTimeLabel(f.RequestedCheckInTime) || null,
      requestedCheckOutPkt: pktTimeLabel(f.RequestedCheckOutTime) || null,
      reason: f.Reason || '',
      reviewUrl: base,
    },
  });
}

function mailDate(value) {
  if (!value) return '—';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

/**
 * Manager approval request for remote work, with single-use approve/reject links.
 * Until this is approved, a remote check-in on those dates counts as Absent.
 */
function sendRemoteWorkApprovalRequest({ managerEmail, employeeName, employeeEmail, request, token }) {
  const base = env.appBaseUrl.replace(/\/$/, '');
  const link = (action) =>
    `${base}/api/remote-work/requests/${request.id}/decide?token=${token}&action=${action}`;
  const f = request.fields;
  const fromDate = mailDate(f.FromDate);
  const toDate = mailDate(f.ToDate);
  const approveUrl = link('approve');
  const rejectUrl = link('reject');
  const subject = `Remote work request from ${employeeName} (${fromDate})`;
  const html = `
    <p>${escapeHtml(employeeName)} has requested to work remotely.</p>
    <ul>
      <li>From: ${fromDate}</li>
      <li>To: ${toDate}</li>
      <li>Working days: ${f.Days}</li>
      <li>Reason: ${escapeHtml(f.Reason || '—')}</li>
    </ul>
    <p>Without your approval, a remote check-in on these dates is counted as <strong>Absent</strong>.</p>
    <p>
      <a href="${approveUrl}">Approve</a> &nbsp;|&nbsp;
      <a href="${rejectUrl}">Reject</a>
    </p>
    <p style="color:#888;font-size:12px">These links are single-use.</p>
  `;

  return dispatch('remote_work.approval_request', {
    emailReason: 'remote_work',
    to: managerEmail,
    employeeName,
    employeeEmail: employeeEmail || null,
    subject,
    html,
    text: stripHtml(html),
    data: {
      requestId: request.id,
      employeeName,
      employeeEmail: employeeEmail || null,
      managerEmail,
      fromDate,
      toDate,
      days: f.Days,
      reason: f.Reason || '',
      approveUrl,
      rejectUrl,
    },
  });
}

/** Notify the employee of the decision on their remote work request. */
function sendRemoteWorkDecisionNotice({ employeeEmail, employeeName, request, decision }) {
  const f = request.fields;
  const fromDate = mailDate(f.FromDate);
  const toDate = mailDate(f.ToDate);
  const subject = `Your remote work request was ${decision.toLowerCase()}`;
  const html = `
    <p>Hi ${escapeHtml(employeeName)},</p>
    <p>Your remote work request (${fromDate} → ${toDate}, ${f.Days} working day(s))
       has been <strong>${decision}</strong>.</p>
    <p>${
      decision === 'Approved'
        ? 'Remote check-ins on these dates count as present.'
        : 'Remote check-ins on these dates count as absent.'
    }</p>
  `;

  return dispatch('remote_work.decision', {
    emailReason: 'remote_work',
    to: employeeEmail,
    employeeName,
    employeeEmail: employeeEmail || null,
    subject,
    html,
    text: stripHtml(html),
    data: {
      requestId: request.id,
      employeeName,
      employeeEmail: employeeEmail || null,
      fromDate,
      toDate,
      days: f.Days,
      decision,
    },
  });
}

/** Notify the employee of the final decision, or a rejection at either step. */
function sendLeaveDecisionNotice({ employeeEmail, employeeName, request, decision, stage }) {
  const subject = `Your leave request was ${decision.toLowerCase()}`;
  const how =
    decision === 'Rejected' && stage === 'manager'
      ? 'Rejected by your manager'
      : decision === 'Rejected' && stage === 'final'
        ? 'Rejected at final approval'
        : decision;
  const html = `
    <p>Hi ${escapeHtml(employeeName)},</p>
    <p>Your ${request.fields.LeaveType} leave (${request.fields.FromDate} → ${request.fields.ToDate},
       ${request.fields.Days} day(s)) has been <strong>${escapeHtml(how)}</strong>.</p>
  `;

  return dispatch('leave.decision', {
    emailReason: 'leave',
    to: employeeEmail,
    employeeName,
    employeeEmail: employeeEmail || null,
    subject,
    html,
    text: stripHtml(html),
    data: {
      requestId: request.id,
      employeeName,
      employeeEmail: employeeEmail || null,
      leaveType: request.fields.LeaveType,
      fromDate: request.fields.FromDate,
      toDate: request.fields.ToDate,
      days: request.fields.Days,
      decision,
      stage: stage || null,
    },
  });
}

/**
 * Password-reset OTP email — dispatched to the single n8n webhook
 * (N8N_EMAIL_WEBHOOK_URL) like every other email type. n8n branches on the
 * `emailReason: 'OTP'` field, receives the subject + full content, and sends
 * the actual email.
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
  return dispatch('auth.password_reset_otp', {
    emailReason: 'OTP',
    to: email,
    employeeName: name || null,
    employeeEmail: email,
    subject,
    html,
    text: stripHtml(html),
    data: { otp, expiresMinutes },
  });
}

/**
 * Attendance check-in / check-out reminder at shift start or end.
 * Uses N8N_ATTENDANCE_REMINDER_WEBHOOK_URL when set (falls back to N8N_EMAIL_WEBHOOK_URL).
 * @param {{to, employeeName, type: 'checkin'|'checkout', date, shiftTime, checkInTime?}} args
 */
function sendAttendanceReminder({ to, employeeName, type, date, shiftTime, checkInTime }) {
  const isCheckIn = type === 'checkin';
  const subject = isCheckIn
    ? `Reminder: please check in (${date})`
    : `Reminder: please check out (${date})`;
  const html = isCheckIn
    ? `
      <p>Hi ${escapeHtml(employeeName || '')},</p>
      <p>Your shift starts at <strong>${shiftTime}</strong> PKT today (${date}).</p>
      <p>Please check in on ALMS if you have not already.</p>
    `
    : `
      <p>Hi ${escapeHtml(employeeName || '')},</p>
      <p>Your shift ends at <strong>${shiftTime}</strong> PKT today (${date}).</p>
      <p>You are still checked in${checkInTime ? ` (since ${pktTimeLabel(checkInTime)})` : ''}.
         Please check out on ALMS.</p>
    `;

  return dispatch(
    'attendance.reminder',
    {
      emailReason: 'attendance_reminder',
      to,
      employeeName: employeeName || null,
      employeeEmail: to,
      subject,
      html,
      text: stripHtml(html),
      data: {
        type,
        date,
        shiftTime,
        checkInTime: checkInTime || null,
        checkInTimePkt: checkInTime ? pktTimeLabel(checkInTime) : null,
      },
    },
    { url: env.email.attendanceReminderWebhookUrl }
  );
}

/**
 * Attendance report for Managers / team leads / HR Admin.
 * Monthly: cover email + one PDF attachment per employee.
 * Daily/weekly: HTML day detail (no PDFs).
 * HTML follows Aidapt brand: navy + teal, operator-led clarity.
 * @param {{to, recipientName, role, period, from, to: toDate, subject, rows, insights?, attachments?}} args
 */
function sendAttendanceReport({
  to,
  recipientName,
  role,
  period,
  from,
  to: toDate,
  subject,
  rows,
  insights,
  attachments,
}) {
  // Aidapt brand tokens (aidapt.co — operator-led AI firm)
  const brand = {
    navy: '#07111F',
    teal: '#14B8A6',
    tealDark: '#0F766E',
    ink: '#0B1220',
    muted: '#5B6575',
    line: '#E6E9EF',
    surface: '#F7F8FA',
    white: '#FFFFFF',
    late: '#B45309',
  };

  const th = `padding:10px 12px;border-bottom:1px solid ${brand.line};text-align:left;font-size:11px;letter-spacing:0.04em;text-transform:uppercase;color:${brand.muted};font-weight:600;background:${brand.surface}`;
  const td = `padding:10px 12px;border-bottom:1px solid ${brand.line};font-size:13px;color:${brand.ink};vertical-align:top`;

  const tableRows = (rows || [])
    .map((r) => {
      const checkOut =
        r.status === 'Still checked in'
          ? 'Still checked in'
          : r.status === 'On Leave'
            ? '—'
            : r.checkOutTime || '—';
      const statusLabel = `${r.status || ''}${r.isLate ? ' (Late)' : ''}`;
      const statusColor =
        r.status === 'Absent'
          ? '#B91C1C'
          : r.status === 'On Leave'
            ? brand.tealDark
            : r.status === 'Still checked in'
              ? brand.late
              : r.isLate
                ? brand.late
                : brand.ink;
      return `
      <tr>
        <td style="${td}">${escapeHtml(r.teamName || '—')}</td>
        <td style="${td}"><strong>${escapeHtml(r.employeeName || '')}</strong></td>
        <td style="${td}">${r.date}</td>
        <td style="${td}">${r.status === 'On Leave' ? '—' : r.checkInTime || '—'}</td>
        <td style="${td}">${escapeHtml(checkOut)}</td>
        <td style="${td};color:${statusColor}">${escapeHtml(statusLabel)}</td>
        <td style="${td}">${escapeHtml(r.mode || '—')}</td>
        <td style="${td}">${r.workedDuration || '—'}</td>
      </tr>`;
    })
    .join('');

  const rangeLabel = from === toDate ? from : `${from} → ${toDate}`;
  const periodTitle =
    period === 'daily' ? 'Daily' : period === 'weekly' ? 'Weekly' : 'Monthly';

  const isMonthly = period === 'monthly';
  // Prefer explicit attachments list; fall back to insight.pdf.
  const pdfAttachments = isMonthly
    ? Array.isArray(attachments) && attachments.length
      ? attachments
      : (insights || []).map((i) => i.pdf).filter(Boolean)
    : [];

  function formatLeaveItemsHtml(items) {
    if (!items || !items.length) return '—';
    return items
      .map((it) => {
        const type = it.leaveType || 'Leave';
        const range =
          it.fromDate && it.toDate && it.fromDate !== it.toDate
            ? `${it.fromDate} → ${it.toDate}`
            : it.fromDate || it.toDate || '—';
        const days = it.daysInPeriod != null ? ` (${it.daysInPeriod}d)` : '';
        return `${escapeHtml(type)} ${escapeHtml(range)}${escapeHtml(days)}`;
      })
      .join('<br>');
  }

  const insightCards = (insights || [])
    .map((i) => {
      const probationHtml = i.onProbation
        ? `<span style="color:${brand.late};font-weight:600">On probation</span>${
            i.probationEndsOn
              ? ` · ends <strong>${escapeHtml(i.probationEndsOn)}</strong>`
              : ''
          }`
        : `<span style="color:${brand.muted}">${escapeHtml(i.employmentStatus || 'Full-time')}</span>`;
      const leaveDetail = formatLeaveItemsHtml(i.leaveItems);
      const pdfName = (i.pdf && i.pdf.filename) || null;
      return `
      <tr>
        <td style="padding:0;border-bottom:1px solid ${brand.line}">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
            <tr>
              <td style="padding:16px 16px 8px;background:${brand.surface}">
                <div style="font-size:16px;font-weight:700;color:${brand.ink}">${escapeHtml(i.employeeName || '')}</div>
                <div style="margin-top:3px;font-size:12px;color:${brand.muted}">${escapeHtml(i.teamName || '—')} · ${probationHtml}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:0 16px 16px;background:${brand.surface}">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:${brand.white};border:1px solid ${brand.line};border-radius:8px;overflow:hidden">
                  <tr>
                    <td style="${td};width:25%"><span style="display:block;font-size:10px;color:${brand.muted};text-transform:uppercase">Worked</span><strong style="font-size:18px">${i.workedDays ?? 0}</strong></td>
                    <td style="${td};width:25%"><span style="display:block;font-size:10px;color:${brand.muted};text-transform:uppercase">Expected</span><strong style="font-size:18px">${i.expectedWorkingDays ?? 0}</strong></td>
                    <td style="${td};width:25%"><span style="display:block;font-size:10px;color:${brand.muted};text-transform:uppercase">Absent</span><strong style="font-size:18px;color:${i.absentDays ? '#B91C1C' : brand.ink}">${i.absentDays ?? 0}</strong></td>
                    <td style="${td};width:25%"><span style="display:block;font-size:10px;color:${brand.muted};text-transform:uppercase">Remote</span><strong style="font-size:18px">${i.remoteDays ?? 0}</strong></td>
                  </tr>
                  <tr>
                    <td style="${td}"><span style="display:block;font-size:10px;color:${brand.muted};text-transform:uppercase">Onsite</span><strong>${i.onsiteDays ?? 0}</strong></td>
                    <td style="${td}"><span style="display:block;font-size:10px;color:${brand.muted};text-transform:uppercase">Late</span><strong>${i.lateCount ?? i.lateDays ?? 0}</strong></td>
                    <td style="${td}"><span style="display:block;font-size:10px;color:${brand.muted};text-transform:uppercase">Strikes</span><strong style="color:${i.strikeCount ? brand.late : brand.ink}">${i.strikeCount ?? 0}</strong></td>
                    <td style="${td}"><span style="display:block;font-size:10px;color:${brand.muted};text-transform:uppercase">Avg in/out</span><strong>${escapeHtml(i.avgCheckInTime || '—')} / ${escapeHtml(i.avgCheckOutTime || '—')}</strong></td>
                  </tr>
                  <tr>
                    <td style="${td}" colspan="2">
                      <span style="display:block;font-size:10px;color:${brand.muted};text-transform:uppercase">Leave taken this month</span>
                      <strong>${escapeHtml(i.leaveTakenLabel || 'None')}</strong>
                      ${leaveDetail !== '—' ? `<div style="margin-top:4px;font-size:12px;color:${brand.muted}">${leaveDetail}</div>` : ''}
                    </td>
                    <td style="${td}" colspan="2">
                      <span style="display:block;font-size:10px;color:${brand.muted};text-transform:uppercase">Current leave balance</span>
                      <span style="font-size:13px">${escapeHtml(i.leaveBalancesLabel || '—')}</span>
                      ${pdfName ? `<div style="margin-top:6px;font-size:11px;color:${brand.muted}">PDF: <strong>${escapeHtml(pdfName)}</strong></div>` : ''}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>`;
    })
    .join('');

  const insightsSection =
    isMonthly && (insights || []).length
      ? `
    <div>
      <h2 style="margin:0 0 6px;font-size:16px;color:${brand.ink};font-weight:600">Monthly report — all employees</h2>
      <p style="margin:0 0 14px;color:${brand.muted};font-size:13px;line-height:1.55">
        Full summary below. Matching PDFs (one per employee) are attached to this email.
        Expected days = company Mon–Fri − holidays (same for all).
      </p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid ${brand.line};border-radius:8px;overflow:hidden">
        <tbody>${insightCards}</tbody>
      </table>
      <p style="margin:14px 0 0;color:${brand.muted};font-size:12px">
        ${(insights || []).length} employee${(insights || []).length === 1 ? '' : 's'}
        · ${pdfAttachments.length} PDF${pdfAttachments.length === 1 ? '' : 's'} attached
      </p>
    </div>`
      : isMonthly
        ? `
    <p style="margin:0;padding:20px 12px;text-align:center;color:${brand.muted};font-size:13px;border:1px solid ${brand.line};border-radius:8px">
      No monthly report for this view. If you lead a team, ensure members are assigned to your team in AIMS.
    </p>`
        : '';

  const emptyDaily = `
    <tr>
      <td colspan="8" style="padding:20px 12px;text-align:center;color:${brand.muted};font-size:13px">
        No attendance rows in this view. If you lead a team, ensure members are assigned to your team in AIMS.
      </td>
    </tr>`;

  // Monthly emails are HTML employee cards + PDFs. Daily/weekly keep per-day detail.
  const dailySection = isMonthly
    ? ''
    : `
              <div>
                <h2 style="margin:0 0 14px;font-size:16px;color:${brand.ink};font-weight:600">Daily detail</h2>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid ${brand.line};border-radius:8px;overflow:hidden">
                  <thead>
                    <tr>
                      <th style="${th}">Team</th>
                      <th style="${th}">Employee</th>
                      <th style="${th}">Date</th>
                      <th style="${th}">Check-in</th>
                      <th style="${th}">Check-out</th>
                      <th style="${th}">Status</th>
                      <th style="${th}">Mode</th>
                      <th style="${th}">Worked</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${tableRows || emptyDaily}
                  </tbody>
                </table>
                <p style="margin:14px 0 0;color:${brand.muted};font-size:12px">
                  ${(rows || []).length} row${(rows || []).length === 1 ? '' : 's'}
                </p>
              </div>`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:0;background:${brand.surface};font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${brand.surface};padding:24px 12px">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:880px;background:${brand.white};border:1px solid ${brand.line};border-radius:12px;overflow:hidden">
          <tr>
            <td style="background:${brand.navy};padding:22px 28px">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <div style="font-size:20px;font-weight:700;color:${brand.white};letter-spacing:-0.02em">
                      Aidapt<span style="color:${brand.teal}">.</span>
                    </div>
                    <div style="margin-top:4px;font-size:12px;color:rgba(255,255,255,0.65);letter-spacing:0.06em;text-transform:uppercase">
                      Attendance &amp; Leave · ALMS
                    </div>
                  </td>
                  <td align="right" style="color:${brand.teal};font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase">
                    ${escapeHtml(periodTitle)} report
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="height:3px;background:${brand.teal};font-size:0;line-height:0">&nbsp;</td>
          </tr>
          <tr>
            <td style="padding:28px">
              <p style="margin:0 0 8px;font-size:15px;color:${brand.ink}">
                Hi ${escapeHtml(recipientName || '')},
              </p>
              <p style="margin:0 0 22px;font-size:14px;color:${brand.muted};line-height:1.55">
                Here is your <strong style="color:${brand.ink}">${escapeHtml(period)}</strong> attendance ${isMonthly ? 'report package' : 'report'} for
                <strong style="color:${brand.ink}">${escapeHtml(rangeLabel)}</strong>
                <span style="color:${brand.teal}"> · ${escapeHtml(role || 'team')} view</span>.
                ${isMonthly ? ' Open the attached PDFs for each employee’s full monthly summary.' : ''}
              </p>
              ${insightsSection}
              ${dailySection}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 28px;background:${brand.surface};border-top:1px solid ${brand.line}">
              <p style="margin:0;font-size:11px;color:${brand.muted};line-height:1.5">
                Sent by Aidapt ALMS · The operator’s AI firm ·
                <a href="https://aidapt.co" style="color:${brand.tealDark};text-decoration:none">aidapt.co</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  // Graph / n8n attachment shape for monthly PDFs.
  const attachmentPayload = pdfAttachments.map((p) => ({
    filename: p.filename,
    contentType: p.contentType || 'application/pdf',
    contentBase64: p.contentBase64,
    employeeId: p.employeeId || null,
    employeeName: p.employeeName || null,
  }));

  return dispatch('attendance.report', {
    emailReason: isMonthly ? 'attendance_report_monthly_pdf' : 'attendance_report',
    to,
    employeeName: recipientName || null,
    employeeEmail: to,
    subject,
    html,
    text: stripHtml(html),
    attachments: attachmentPayload,
    data: {
      period,
      from,
      to: toDate,
      role,
      // Monthly: omit day-by-day rows; insights without heavy base64 in nested data.
      rows: isMonthly ? [] : rows,
      insights: isMonthly
        ? (insights || []).map(({ pdf, ...rest }) => ({
            ...rest,
            pdfFilename: pdf && pdf.filename ? pdf.filename : null,
          }))
        : insights || null,
      pdfCount: attachmentPayload.length,
    },
  });
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
  sendRemoteWorkApprovalRequest,
  sendRemoteWorkDecisionNotice,
  sendRegularizationApprovalRequest,
  sendPasswordResetOtp,
  sendAttendanceReminder,
  sendAttendanceReport,
  n8nConfigured: configured,
};
