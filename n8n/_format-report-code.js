const payload = items[0].json;
const data = payload.data || payload;
const period = data.period || 'daily';
const from = data.from;
const to = data.to;
const allRows = Array.isArray(data.rows) ? data.rows : [];
const allInsights = Array.isArray(data.insights) ? data.insights : [];
const recipientReports = Array.isArray(data.recipientReports) ? data.recipientReports : [];

// Aidapt brand tokens
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
  absent: '#B91C1C',
};

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function mdCell(s) {
  return String(s ?? '—').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function findReport(matchers) {
  return (
    recipientReports.find((r) => {
      const n = norm(r.name);
      return matchers.some((m) => n.includes(m));
    }) || null
  );
}

function filterByTeamHints(rows, teamHints) {
  if (!teamHints.length) return rows || [];
  return (rows || []).filter((r) =>
    teamHints.some((h) => norm(r.teamName || '').includes(h))
  );
}

const th = `padding:10px 12px;border-bottom:1px solid ${brand.line};text-align:left;font-size:11px;letter-spacing:0.04em;text-transform:uppercase;color:${brand.muted};font-weight:600;background:${brand.surface}`;
const td = `padding:10px 12px;border-bottom:1px solid ${brand.line};font-size:13px;color:${brand.ink};vertical-align:top`;
const tdCenter = `${td};text-align:center`;

function buildDailyHtml(rows) {
  return (rows || [])
    .map((r) => {
      const checkOut =
        r.status === 'Still checked in'
          ? 'Still checked in'
          : r.status === 'On Leave'
            ? '—'
            : r.checkOutTime || '—';
      const checkIn = r.status === 'On Leave' ? '—' : r.checkInTime || '—';
      const statusLabel = `${r.status || ''}${r.isLate ? ' (Late)' : ''}`;
      const statusColor =
        r.status === 'Absent'
          ? brand.absent
          : r.status === 'On Leave'
            ? brand.tealDark
            : r.status === 'Still checked in'
              ? brand.late
              : r.isLate
                ? brand.late
                : brand.ink;
      return `<tr>
  <td style="${td}">${esc(r.teamName || '—')}</td>
  <td style="${td}"><strong>${esc(r.employeeName || '')}</strong></td>
  <td style="${td}">${esc(r.date)}</td>
  <td style="${td}">${esc(checkIn)}</td>
  <td style="${td}">${esc(checkOut)}</td>
  <td style="${td};color:${statusColor}">${esc(statusLabel)}</td>
  <td style="${td}">${esc(r.mode || '—')}</td>
  <td style="${td}">${esc(r.workedDuration || '—')}</td>
</tr>`;
    })
    .join('');
}

function buildMonthlyPackageCoverHtml({ toName, roleLabel, insights }) {
  const rangeLabel = from === to ? from : `${from} → ${to}`;
  const list = Array.isArray(insights) ? insights : [];
  const rowsHtml = list
    .map((i) => {
      const leave = i.leaveTakenLabel && i.leaveTakenLabel !== 'None' ? i.leaveTakenLabel : '—';
      return `<tr>
  <td style="${td}"><strong>${esc(i.employeeName || '')}</strong></td>
  <td style="${tdCenter}">${i.workedDays ?? 0}</td>
  <td style="${tdCenter}">${i.expectedWorkingDays ?? 0}</td>
  <td style="${tdCenter}">${i.absentDays ?? 0}</td>
  <td style="${tdCenter}">${i.remoteDays ?? 0}</td>
  <td style="${td}">${esc(leave)}</td>
  <td style="${td}"><span style="font-size:12px">${esc(i.leaveBalancesLabel || '—')}</span></td>
  <td style="${td}">${esc((i.pdf && i.pdf.filename) || '—')}</td>
</tr>`;
    })
    .join('');

  return `<!DOCTYPE html>
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
                    <div style="font-size:20px;font-weight:700;color:${brand.white};letter-spacing:-0.02em">Aidapt<span style="color:${brand.teal}">.</span></div>
                    <div style="margin-top:4px;font-size:12px;color:rgba(255,255,255,0.65);letter-spacing:0.06em;text-transform:uppercase">Attendance &amp; Leave · ALMS</div>
                  </td>
                  <td align="right" style="color:${brand.teal};font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase">Monthly report</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr><td style="height:3px;background:${brand.teal};font-size:0;line-height:0">&nbsp;</td></tr>
          <tr>
            <td style="padding:28px">
              <p style="margin:0 0 8px;font-size:15px;color:${brand.ink}">Hi ${esc(toName)},</p>
              <p style="margin:0 0 18px;font-size:14px;color:${brand.muted};line-height:1.55">
                Your <strong style="color:${brand.ink}">monthly</strong> attendance package for
                <strong style="color:${brand.ink}">${esc(rangeLabel)}</strong>
                <span style="color:${brand.teal}"> · ${esc(roleLabel)} view</span>.
                Each employee has a brand PDF attached (one file per person).
              </p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid ${brand.line};border-radius:8px;overflow:hidden">
                <thead>
                  <tr>
                    <th style="${th}">Employee</th>
                    <th style="${th}">Worked</th>
                    <th style="${th}">Expected</th>
                    <th style="${th}">Absent</th>
                    <th style="${th}">Remote</th>
                    <th style="${th}">Leave taken</th>
                    <th style="${th}">Balance</th>
                    <th style="${th}">PDF</th>
                  </tr>
                </thead>
                <tbody>${rowsHtml || `<tr><td colspan="8" style="${td};text-align:center;color:${brand.muted}">No employees in this view.</td></tr>`}</tbody>
              </table>
              <p style="margin:14px 0 0;color:${brand.muted};font-size:12px">
                ${list.length} PDF${list.length === 1 ? '' : 's'} attached · Expected days = company Mon–Fri − holidays (same for all)
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 28px;background:${brand.surface};border-top:1px solid ${brand.line}">
              <p style="margin:0;font-size:11px;color:${brand.muted}">Sent by Aidapt ALMS · The operator’s AI firm · aidapt.co</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildEmailHtml({ toName, roleLabel, rows }) {
  const rangeLabel = from === to ? from : `${from} → ${to}`;
  const periodTitle = period === 'daily' ? 'Daily' : period === 'weekly' ? 'Weekly' : 'Monthly';
  const daily = buildDailyHtml(rows);
  const emptyDaily = `<tr>
  <td colspan="8" style="padding:20px 12px;text-align:center;color:${brand.muted};font-size:13px">
    No attendance rows in this view. Ensure your team members are assigned under your team in AIMS.
  </td>
</tr>`;

  return `<!DOCTYPE html>
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
                    ${esc(periodTitle)} report
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
              <p style="margin:0 0 8px;font-size:15px;color:${brand.ink}">Hi ${esc(toName)},</p>
              <p style="margin:0 0 22px;font-size:14px;color:${brand.muted};line-height:1.55">
                Here is your <strong style="color:${brand.ink}">${esc(period)}</strong> attendance report for
                <strong style="color:${brand.ink}">${esc(rangeLabel)}</strong>
                <span style="color:${brand.teal}"> · ${esc(roleLabel)} view</span>.
              </p>
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
                    ${daily || emptyDaily}
                  </tbody>
                </table>
                <p style="margin:14px 0 0;color:${brand.muted};font-size:12px">
                  ${(rows || []).length} row${(rows || []).length === 1 ? '' : 's'}
                </p>
              </div>
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
}

function formatLeaveItemsMd(items) {
  if (!items || !items.length) return '—';
  return items
    .map((it) => {
      const type = it.leaveType || 'Leave';
      const range =
        it.fromDate && it.toDate && it.fromDate !== it.toDate
          ? `${it.fromDate} → ${it.toDate}`
          : it.fromDate || it.toDate || '—';
      const days = it.daysInPeriod != null ? ` (${it.daysInPeriod}d)` : '';
      return `${type} ${range}${days}`;
    })
    .join('; ');
}

function buildInsightsMarkdown(insights) {
  if (!insights || !insights.length) return '_No monthly summary for this view._\n';
  const lines = [
    '### Monthly employee summary',
    '',
    '_PDFs are emailed to managers (one package email per manager). Full files also attach to the ClickUp monthly task when configured._',
    '',
  ];
  for (const i of insights) {
    const probation = i.onProbation
      ? `On probation${i.probationEndsOn ? ` (ends ${i.probationEndsOn})` : ''}`
      : i.employmentStatus || 'Full-time';
    const pdfName = (i.pdf && i.pdf.filename) || null;
    lines.push(`**${mdCell(i.employeeName)}** · ${mdCell(i.teamName)} · ${mdCell(probation)}`);
    lines.push(
      `- Days: **${i.workedDays ?? 0}** worked / **${i.expectedWorkingDays ?? 0}** expected · Absent **${i.absentDays ?? 0}** · Remote **${i.remoteDays ?? 0}**`
    );
    lines.push(
      `- Late **${i.lateCount ?? i.lateDays ?? 0}** · Strikes **${i.strikeCount ?? 0}** · Avg in/out **${mdCell(i.avgCheckInTime)} / ${mdCell(i.avgCheckOutTime)}**`
    );
    lines.push(
      `- Leave taken: ${mdCell(i.leaveTakenLabel || 'None')}${
        i.leaveItems && i.leaveItems.length ? ` · ${mdCell(formatLeaveItemsMd(i.leaveItems))}` : ''
      }`
    );
    lines.push(`- Balance: ${mdCell(i.leaveBalancesLabel)}`);
    if (pdfName) lines.push(`- PDF: \`${mdCell(pdfName)}\``);
    lines.push('');
  }
  return lines.join('\n');
}

function buildDailyMarkdown(rows) {
  const lines = [
    '### Daily detail',
    '',
    '| Team | Employee | Date | In | Out | Status | Mode | Worked |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of rows || []) {
    const checkOut =
      r.status === 'Still checked in'
        ? 'Still checked in'
        : r.status === 'On Leave'
          ? '—'
          : r.checkOutTime || '—';
    const checkIn = r.status === 'On Leave' ? '—' : r.checkInTime || '—';
    const status = `${r.status || ''}${r.isLate ? ' (Late)' : ''}`;
    lines.push(
      `| ${mdCell(r.teamName)} | ${mdCell(r.employeeName)} | ${mdCell(r.date)} | ${mdCell(checkIn)} | ${mdCell(checkOut)} | ${mdCell(status)} | ${mdCell(r.mode)} | ${mdCell(r.workedDuration)} |`
    );
  }
  lines.push('');
  return lines.join('\n');
}

function buildClickUpMarkdown({ rows, insights }) {
  const rangeLabel = from === to ? from : `${from} → ${to}`;
  const title =
    period === 'daily'
      ? `Daily attendance — ${from}`
      : period === 'weekly'
        ? `Weekly attendance — ${from} → ${to}`
        : `Monthly attendance — ${from} → ${to}`;

  const isMonthly = period === 'monthly';
  const employeeCount = isMonthly
    ? (insights || []).length
    : new Set((rows || []).map((r) => r.employeeId)).size;

  const parts = [
    `## ${title}`,
    '',
    isMonthly
      ? `Period: **${rangeLabel}** · Employees in view: **${employeeCount}** (summary only)`
      : `Period: **${rangeLabel}** · Employees in view: **${employeeCount}** · Rows: **${(rows || []).length}**`,
    '',
  ];

  if (isMonthly) {
    parts.push(buildInsightsMarkdown(insights || []));
  } else {
    const MAX_DAILY_ROWS = 80;
    const clipped = (rows || []).slice(0, MAX_DAILY_ROWS);
    const more =
      (rows || []).length > MAX_DAILY_ROWS
        ? `\n_…and ${(rows || []).length - MAX_DAILY_ROWS} more rows (see email for full detail)._\n`
        : '';
    parts.push(buildDailyMarkdown(clipped));
    if (more) parts.push(more);
  }

  parts.push('_Sent by Aidapt ALMS_');
  return parts.join('\n');
}

const rangeLabel = from === to ? from : `${from} → ${to}`;
const subject =
  period === 'daily'
    ? `Daily attendance — ${from}`
    : period === 'weekly'
      ? `Weekly attendance — ${from} → ${to}`
      : `Monthly attendance — ${from} → ${to}`;

const targets = [
  {
    label: 'Muhammad Ateeb',
    matchers: ['ateeb'],
    emailFallback: 'm.ateeb@aidapt.co',
    scope: 'reportees',
    teamHints: ['operations'],
  },
  {
    label: 'Muhammad Irtaza',
    matchers: ['irtaza'],
    emailFallback: 's.irtaza@aidapt.co',
    scope: 'reportees',
    teamHints: ['data'],
  },
  {
    label: 'Hitesh Mahajan',
    matchers: ['hitesh'],
    emailFallback: 'REPLACE_HITESH@aidapt.co',
    scope: 'organization',
    teamHints: [],
  },
];

const emails = [];
/** Org-wide PDFs for ClickUp task upload (monthly only). */
const clickupPdfs = [];
const pdfSeen = new Set();

for (const t of targets) {
  const report = findReport(t.matchers);
  let rows;
  let insights;
  let roleLabel;
  if (t.scope === 'organization') {
    rows = report && report.role === 'HR Admin' ? report.rows : allRows;
    insights = report && report.role === 'HR Admin' ? report.insights : allInsights;
    roleLabel = 'organization';
  } else {
    rows = report ? report.rows || [] : [];
    insights = report ? report.insights || [] : [];
    roleLabel = 'team';
    if (
      (!(rows || []).length || (period === 'monthly' && !(insights || []).length)) &&
      t.teamHints &&
      t.teamHints.length
    ) {
      rows = filterByTeamHints(allRows, t.teamHints);
      insights = filterByTeamHints(allInsights, t.teamHints);
    }
  }
  const toEmail =
    report && report.email && !String(report.email).startsWith('REPLACE_')
      ? report.email
      : t.emailFallback;
  const toName = (report && report.name) || t.label;

  if (period === 'monthly') {
    // ONE email per manager/HR with ALL employee PDFs attached (not 1 email per employee).
    const list = Array.isArray(insights) ? insights.filter((i) => i && i.pdf && i.pdf.contentBase64) : [];
    for (const i of list) {
      const key = i.employeeId || i.pdf.filename;
      if (!pdfSeen.has(key)) {
        pdfSeen.add(key);
        clickupPdfs.push({
          employeeId: i.employeeId || null,
          employeeName: i.employeeName || null,
          filename: i.pdf.filename,
          contentBase64: i.pdf.contentBase64,
          contentType: i.pdf.contentType || 'application/pdf',
        });
      }
    }
    if (!list.length && !(insights || []).length) continue;
    emails.push({
      channel: 'email',
      to: toEmail,
      toName,
      subject,
      html: buildMonthlyPackageCoverHtml({ toName, roleLabel, insights: list }),
      period,
      from,
      toDate: to,
      hasPdf: list.length > 0,
      pdfCount: list.length,
      rowCount: list.length,
      scope: roleLabel,
      // Multiple PDFs for Graph sendMail
      attachments: list.map((i) => ({
        filename: i.pdf.filename,
        contentBase64: i.pdf.contentBase64,
        contentType: i.pdf.contentType || 'application/pdf',
        employeeId: i.employeeId || null,
        employeeName: i.employeeName || null,
      })),
    });
  } else {
    emails.push({
      channel: 'email',
      to: toEmail,
      toName,
      subject,
      html: buildEmailHtml({ toName, roleLabel, rows }),
      period,
      from,
      toDate: to,
      hasPdf: false,
      pdfCount: 0,
      attachments: [],
      rowCount: (rows || []).length,
      scope: roleLabel,
    });
  }
}

const clickupMarkdown = buildClickUpMarkdown({
  rows: allRows,
  insights: allInsights,
});

return [
  {
    json: {
      period,
      from,
      to,
      subject,
      rangeLabel,
      emails,
      clickupMarkdown,
      clickupTitle: subject,
      // Used by monthly workflow to create a ClickUp task + attach PDFs
      clickupPdfs,
      clickupTaskName: `Monthly attendance PDFs — ${rangeLabel}`,
    },
  },
];
