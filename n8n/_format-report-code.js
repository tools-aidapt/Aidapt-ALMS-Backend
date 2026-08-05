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
      return `${esc(type)} ${esc(range)}${esc(days)}`;
    })
    .join('<br>');
}

/** Full HTML card for one employee (monthly email body). */
function buildEmployeeInsightCardHtml(i) {
  const probation = i.onProbation
    ? `<span style="color:${brand.late};font-weight:600">On probation</span>${
        i.probationEndsOn ? ` · ends <strong>${esc(i.probationEndsOn)}</strong>` : ''
      }`
    : `<span style="color:${brand.muted}">${esc(i.employmentStatus || 'Full-time')}</span>`;
  const leaveDetail = formatLeaveItemsHtml(i.leaveItems);
  const pdfName = (i.pdf && i.pdf.filename) || null;

  return `
<tr>
  <td style="padding:0;border-bottom:1px solid ${brand.line}">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
      <tr>
        <td style="padding:16px 16px 8px;background:${brand.surface}">
          <div style="font-size:16px;font-weight:700;color:${brand.ink}">${esc(i.employeeName || '')}</div>
          <div style="margin-top:3px;font-size:12px;color:${brand.muted}">${esc(i.teamName || '—')} · ${probation}</div>
        </td>
      </tr>
      <tr>
        <td style="padding:0 16px 16px;background:${brand.surface}">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:${brand.white};border:1px solid ${brand.line};border-radius:8px;overflow:hidden">
            <tr>
              <td style="${td};width:25%"><span style="display:block;font-size:10px;color:${brand.muted};text-transform:uppercase;letter-spacing:0.04em">Worked</span><strong style="font-size:18px">${i.workedDays ?? 0}</strong></td>
              <td style="${td};width:25%"><span style="display:block;font-size:10px;color:${brand.muted};text-transform:uppercase;letter-spacing:0.04em">Expected</span><strong style="font-size:18px">${i.expectedWorkingDays ?? 0}</strong></td>
              <td style="${td};width:25%"><span style="display:block;font-size:10px;color:${brand.muted};text-transform:uppercase;letter-spacing:0.04em">Absent</span><strong style="font-size:18px;color:${i.absentDays ? brand.absent : brand.ink}">${i.absentDays ?? 0}</strong></td>
              <td style="${td};width:25%"><span style="display:block;font-size:10px;color:${brand.muted};text-transform:uppercase;letter-spacing:0.04em">Remote</span><strong style="font-size:18px">${i.remoteDays ?? 0}</strong></td>
            </tr>
            <tr>
              <td style="${td}"><span style="display:block;font-size:10px;color:${brand.muted};text-transform:uppercase;letter-spacing:0.04em">Onsite</span><strong>${i.onsiteDays ?? 0}</strong></td>
              <td style="${td}"><span style="display:block;font-size:10px;color:${brand.muted};text-transform:uppercase;letter-spacing:0.04em">Late</span><strong>${i.lateCount ?? i.lateDays ?? 0}</strong></td>
              <td style="${td}"><span style="display:block;font-size:10px;color:${brand.muted};text-transform:uppercase;letter-spacing:0.04em">Strikes</span><strong style="color:${i.strikeCount ? brand.late : brand.ink}">${i.strikeCount ?? 0}</strong></td>
              <td style="${td}"><span style="display:block;font-size:10px;color:${brand.muted};text-transform:uppercase;letter-spacing:0.04em">Avg in / out</span><strong>${esc(i.avgCheckInTime || '—')} / ${esc(i.avgCheckOutTime || '—')}</strong></td>
            </tr>
            <tr>
              <td style="${td}" colspan="2">
                <span style="display:block;font-size:10px;color:${brand.muted};text-transform:uppercase;letter-spacing:0.04em">Leave taken this month</span>
                <strong>${esc(i.leaveTakenLabel || 'None')}</strong>
                ${leaveDetail !== '—' ? `<div style="margin-top:4px;font-size:12px;color:${brand.muted};line-height:1.45">${leaveDetail}</div>` : ''}
              </td>
              <td style="${td}" colspan="2">
                <span style="display:block;font-size:10px;color:${brand.muted};text-transform:uppercase;letter-spacing:0.04em">Current leave balance</span>
                <span style="font-size:13px;line-height:1.45">${esc(i.leaveBalancesLabel || '—')}</span>
                ${pdfName ? `<div style="margin-top:6px;font-size:11px;color:${brand.muted}">PDF: <strong style="color:${brand.ink}">${esc(pdfName)}</strong></div>` : ''}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </td>
</tr>`;
}

function buildMonthlyPackageCoverHtml({ toName, roleLabel, insights }) {
  const rangeLabel = from === to ? from : `${from} → ${to}`;
  const list = Array.isArray(insights) ? insights : [];
  const cards = list.map(buildEmployeeInsightCardHtml).join('');

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
              </p>
              <p style="margin:0 0 16px;font-size:13px;color:${brand.muted};line-height:1.5">
                Below is the full HTML summary for every employee in your scope.
                Matching PDFs (one per employee) are attached to this email.
                Expected days = company Mon–Fri − holidays (same for all).
              </p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid ${brand.line};border-radius:8px;overflow:hidden">
                <tbody>
                  ${
                    cards ||
                    `<tr><td style="padding:20px;text-align:center;color:${brand.muted}">No employees in this view.</td></tr>`
                  }
                </tbody>
              </table>
              <p style="margin:14px 0 0;color:${brand.muted};font-size:12px">
                ${list.length} employee${list.length === 1 ? '' : 's'} · ${list.filter((i) => i.pdf).length} PDF${list.filter((i) => i.pdf).length === 1 ? '' : 's'} attached
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
  if (!items || !items.length) return null;
  return items
    .map((it) => {
      const type = it.leaveType || 'Leave';
      const range =
        it.fromDate && it.toDate && it.fromDate !== it.toDate
          ? `${it.fromDate} → ${it.toDate}`
          : it.fromDate || it.toDate || '—';
      const days = it.daysInPeriod != null ? ` (${it.daysInPeriod}d)` : '';
      return `  - ${type}: ${range}${days}`;
    })
    .join('\n');
}

/** One markdown section per employee (ClickUp). */
function buildEmployeeInsightMarkdown(i, index) {
  const n = index + 1;
  const probation = i.onProbation
    ? `On probation${i.probationEndsOn ? ` · ends ${i.probationEndsOn}` : ''}${
        i.dateOfJoining ? ` · joined ${i.dateOfJoining}` : ''
      }`
    : i.employmentStatus || 'Full-time';
  const lines = [
    `### ${n}. ${mdCell(i.employeeName)}`,
    '',
    `| | |`,
    `| --- | --- |`,
    `| **Team** | ${mdCell(i.teamName)} |`,
    `| **Status** | ${mdCell(probation)} |`,
    `| **Worked days** | ${i.workedDays ?? 0} (onsite ${i.onsiteDays ?? 0} · remote ${i.remoteDays ?? 0}) |`,
    `| **Expected days** | ${i.expectedWorkingDays ?? 0} |`,
    `| **Absent** | ${i.absentDays ?? 0} |`,
    `| **Late** | ${i.lateCount ?? i.lateDays ?? 0} |`,
    `| **Strikes** | ${i.strikeCount ?? 0} |`,
    `| **Avg check-in / out** | ${mdCell(i.avgCheckInTime)} / ${mdCell(i.avgCheckOutTime)} |`,
    `| **Leave taken** | ${mdCell(i.leaveTakenLabel || 'None')} |`,
    `| **Leave balance** | ${mdCell(i.leaveBalancesLabel)} |`,
  ];
  if (i.pdf && i.pdf.filename) {
    lines.push(`| **PDF** | \`${mdCell(i.pdf.filename)}\` |`);
  }
  lines.push('');
  const leaveLines = formatLeaveItemsMd(i.leaveItems);
  if (leaveLines) {
    lines.push('**Leave details**');
    lines.push(leaveLines);
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

function buildInsightsMarkdown(insights) {
  if (!insights || !insights.length) return '_No employees in this monthly report._\n';
  const lines = [
    '### Team monthly summary',
    '',
    `**${insights.length}** employee${insights.length === 1 ? '' : 's'} · Expected days = Mon–Fri − holidays (same for all)`,
    '',
    '---',
    '',
  ];
  insights.forEach((i, idx) => {
    lines.push(buildEmployeeInsightMarkdown(i, idx));
  });
  return lines.join('\n');
}

function buildDailyMarkdown(rows) {
  const byEmp = new Map();
  for (const r of rows || []) {
    const key = r.employeeId || r.employeeName || 'unknown';
    if (!byEmp.has(key)) {
      byEmp.set(key, { name: r.employeeName, team: r.teamName, days: [] });
    }
    byEmp.get(key).days.push(r);
  }

  const lines = ['### Detail by employee', ''];
  let n = 0;
  for (const emp of byEmp.values()) {
    n += 1;
    lines.push(`### ${n}. ${mdCell(emp.name)}`);
    lines.push(`_${mdCell(emp.team)}_`);
    lines.push('');
    lines.push('| Date | In | Out | Status | Mode | Worked |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const r of emp.days) {
      const checkOut =
        r.status === 'Still checked in'
          ? 'Still checked in'
          : r.status === 'On Leave'
            ? '—'
            : r.checkOutTime || '—';
      const checkIn = r.status === 'On Leave' ? '—' : r.checkInTime || '—';
      const status = `${r.status || ''}${r.isLate ? ' (Late)' : ''}`;
      lines.push(
        `| ${mdCell(r.date)} | ${mdCell(checkIn)} | ${mdCell(checkOut)} | ${mdCell(status)} | ${mdCell(r.mode)} | ${mdCell(r.workedDuration)} |`
      );
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  if (!n) lines.push('_No attendance rows._\n');
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
    `**Period:** ${rangeLabel}`,
    `**Employees:** ${employeeCount}`,
    '',
    '---',
    '',
  ];

  if (isMonthly) {
    parts.push(buildInsightsMarkdown(insights || []));
  } else {
    const MAX_ROWS = 120;
    const clipped = (rows || []).slice(0, MAX_ROWS);
    parts.push(buildDailyMarkdown(clipped));
    if ((rows || []).length > MAX_ROWS) {
      parts.push(`_…and ${(rows || []).length - MAX_ROWS} more rows (see email)._\n`);
    }
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
    // ONE email per manager/HR: full HTML for all employees + all PDFs attached.
    const list = Array.isArray(insights) ? insights : [];
    const withPdf = list.filter((i) => i && i.pdf && i.pdf.contentBase64);
    for (const i of withPdf) {
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
    if (!list.length) continue;
    emails.push({
      channel: 'email',
      to: toEmail,
      toName,
      subject,
      // Full HTML cards for every employee in this manager's scope
      html: buildMonthlyPackageCoverHtml({ toName, roleLabel, insights: list }),
      period,
      from,
      toDate: to,
      hasPdf: withPdf.length > 0,
      pdfCount: withPdf.length,
      rowCount: list.length,
      scope: roleLabel,
      attachments: withPdf.map((i) => ({
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
