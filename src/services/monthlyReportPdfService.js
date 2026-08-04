'use strict';

/**
 * One-page monthly attendance PDF for a single employee (pdfkit).
 * Visual system matches ALMS email brand: navy #07111F + teal #14B8A6.
 */

const PDFDocument = require('pdfkit');

// Aidapt / ALMS brand tokens (aligned with emailService)
const BRAND = {
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

function safeFilenamePart(name) {
  return String(name || 'employee')
    .replace(/[^\w\s\-]+/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 60) || 'employee';
}

function monthlyPdfFilename(insight, range) {
  const ym = String(range.from || '').slice(0, 7) || 'month';
  return `${safeFilenamePart(insight.employeeName)}_${ym}_monthly.pdf`;
}

function drawMetric(doc, x, y, w, h, label, value, opts = {}) {
  const valueColor = opts.valueColor || BRAND.ink;
  const valueSize = opts.valueSize || 18;
  doc.roundedRect(x, y, w, h, 4).fill(BRAND.surface);
  // Left teal rail for brand identity
  doc.rect(x, y, 3, h).fill(BRAND.teal);
  doc
    .font('Helvetica')
    .fontSize(7.5)
    .fillColor(BRAND.muted)
    .text(String(label).toUpperCase(), x + 12, y + 10, {
      width: w - 20,
      characterSpacing: 0.6,
    });
  doc
    .font('Helvetica-Bold')
    .fontSize(valueSize)
    .fillColor(valueColor)
    .text(String(value ?? '—'), x + 12, y + 24, { width: w - 20 });
}

/**
 * @param {object} insight
 * @param {{from: string, to: string}} range
 * @returns {Promise<Buffer>}
 */
function renderEmployeeMonthlyPdf(insight, range) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 0,
      info: {
        Title: `Monthly attendance — ${insight.employeeName || 'Employee'}`,
        Author: 'Aidapt ALMS',
        Subject: `${range.from} → ${range.to}`,
        Keywords: 'Aidapt, ALMS, attendance',
      },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const left = 48;
    const contentW = pageW - 96;
    const rangeLabel =
      range.from === range.to ? range.from : `${range.from} → ${range.to}`;

    // ── Hero header (brand first) ─────────────────────────────────────────
    doc.rect(0, 0, pageW, 96).fill(BRAND.navy);
    doc.rect(0, 96, pageW, 4).fill(BRAND.teal);

    // Wordmark: Aidapt.
    doc.font('Helvetica-Bold').fontSize(22).fillColor(BRAND.white).text('Aidapt', left, 28, {
      continued: true,
    });
    doc.fillColor(BRAND.teal).text('.');
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#9AA6B8')
      .text('The operator’s AI firm', left, 54);
    doc
      .fontSize(8)
      .fillColor('#7A8799')
      .text('Attendance & Leave · ALMS', left, 68);

    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(BRAND.teal)
      .text('MONTHLY REPORT', left, 36, { width: contentW, align: 'right' });
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#9AA6B8')
      .text(rangeLabel, left, 52, { width: contentW, align: 'right' });

    let y = 120;

    // ── Employee name (hero of content) ───────────────────────────────────
    doc
      .font('Helvetica-Bold')
      .fontSize(20)
      .fillColor(BRAND.ink)
      .text(insight.employeeName || 'Employee', left, y, { width: contentW });
    y = doc.y + 6;

    const metaParts = [insight.teamName || null, rangeLabel].filter(Boolean);
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor(BRAND.muted)
      .text(metaParts.join('  ·  '), left, y);
    y = doc.y + 8;

    if (insight.onProbation) {
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor(BRAND.late)
        .text(
          `ON PROBATION${insight.probationEndsOn ? ` · ends ${insight.probationEndsOn}` : ''}${
            insight.dateOfJoining ? ` · joined ${insight.dateOfJoining}` : ''
          }`,
          left,
          y
        );
      y = doc.y + 14;
    } else {
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(BRAND.muted)
        .text(insight.employmentStatus || 'Full-time', left, y);
      y = doc.y + 14;
    }

    // Teal divider
    doc
      .moveTo(left, y)
      .lineTo(left + contentW, y)
      .lineWidth(1)
      .strokeColor(BRAND.teal)
      .stroke();
    y += 16;

    // ── Core metrics ──────────────────────────────────────────────────────
    const gap = 10;
    const cardH = 56;
    const cardW = (contentW - gap * 2) / 3;

    const row1 = [
      { label: 'Worked days', value: insight.workedDays ?? 0 },
      { label: 'Expected days', value: insight.expectedWorkingDays ?? 0 },
      {
        label: 'Absent',
        value: insight.absentDays ?? 0,
        valueColor: insight.absentDays ? BRAND.absent : BRAND.ink,
      },
    ];
    row1.forEach((c, i) => {
      drawMetric(doc, left + i * (cardW + gap), y, cardW, cardH, c.label, c.value, c);
    });
    y += cardH + gap;

    const row2 = [
      { label: 'Onsite', value: insight.onsiteDays ?? 0 },
      { label: 'Remote', value: insight.remoteDays ?? 0 },
      {
        label: 'Avg in / out',
        value: `${insight.avgCheckInTime || '—'} / ${insight.avgCheckOutTime || '—'}`,
        valueSize: 12,
      },
    ];
    row2.forEach((c, i) => {
      drawMetric(doc, left + i * (cardW + gap), y, cardW, cardH, c.label, c.value, c);
    });
    y += cardH + gap;

    const row3 = [
      { label: 'Late', value: insight.lateCount ?? insight.lateDays ?? 0 },
      {
        label: 'Strikes',
        value: insight.strikeCount ?? 0,
        valueColor: insight.strikeCount ? BRAND.late : BRAND.ink,
      },
      {
        label: 'Leave days',
        value: insight.leaveDays ?? 0,
        valueColor: insight.leaveDays ? BRAND.tealDark : BRAND.ink,
      },
    ];
    row3.forEach((c, i) => {
      drawMetric(doc, left + i * (cardW + gap), y, cardW, cardH, c.label, c.value, c);
    });
    y += cardH + 18;

    // ── Leave panel ───────────────────────────────────────────────────────
    const leaveItems = Array.isArray(insight.leaveItems) ? insight.leaveItems : [];
    const leaveH = Math.min(120, 72 + leaveItems.slice(0, 3).length * 14);
    doc.roundedRect(left, y, contentW, leaveH, 4).fill(BRAND.surface);
    doc.rect(left, y, 3, leaveH).fill(BRAND.teal);

    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor(BRAND.ink)
      .text('Leave', left + 14, y + 12);
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(BRAND.muted)
      .text('TAKEN THIS MONTH', left + 14, y + 30, { characterSpacing: 0.5 });
    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor(BRAND.ink)
      .text(insight.leaveTakenLabel || 'None', left + 14, y + 42, {
        width: contentW / 2 - 28,
      });

    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(BRAND.muted)
      .text('CURRENT BALANCE', left + contentW / 2, y + 30, { characterSpacing: 0.5 });
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor(BRAND.ink)
      .text(insight.leaveBalancesLabel || 'Annual 0 · Sick 0 · Casual 0', left + contentW / 2, y + 42, {
        width: contentW / 2 - 20,
      });

    let ly = y + 62;
    if (leaveItems.length) {
      for (const it of leaveItems.slice(0, 3)) {
        const type = it.leaveType || 'Leave';
        const r =
          it.fromDate && it.toDate && it.fromDate !== it.toDate
            ? `${it.fromDate} → ${it.toDate}`
            : it.fromDate || it.toDate || '—';
        const days = it.daysInPeriod != null ? ` (${it.daysInPeriod}d)` : '';
        doc
          .font('Helvetica')
          .fontSize(9)
          .fillColor(BRAND.ink)
          .text(`• ${type}: ${r}${days}`, left + 14, ly, { width: contentW - 28 });
        ly = doc.y + 2;
      }
    }
    y += leaveH + 16;

    // ── Detail rows ───────────────────────────────────────────────────────
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor(BRAND.ink)
      .text('Hours & detail', left, y);
    y = doc.y + 8;

    const detail = [
      ['Present / half days', `${insight.presentDays ?? 0} / ${insight.halfDays ?? 0}`],
      ['Holiday days', insight.holidayDays ?? 0],
      ['Worked hours', insight.workedDuration || '—'],
      ['Expected hours', insight.expectedDuration || '—'],
      ['Hours variance', insight.hoursVarianceDuration || '—'],
    ];
    for (const [label, value] of detail) {
      doc.font('Helvetica').fontSize(9).fillColor(BRAND.muted).text(label, left, y, { width: 150 });
      doc.fillColor(BRAND.ink).text(String(value), left + 160, y, { width: contentW - 160 });
      y = Math.max(doc.y, y + 13);
    }

    // ── Footer band ───────────────────────────────────────────────────────
    const footY = pageH - 36;
    doc.rect(0, footY - 8, pageW, 44).fill(BRAND.navy);
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#9AA6B8')
      .text('Sent by Aidapt ALMS  ·  The operator’s AI firm  ·  aidapt.co', left, footY + 4, {
        width: contentW,
      });

    doc.end();
  });
}

async function buildEmployeeMonthlyPdfAttachment(insight, range) {
  const buffer = await renderEmployeeMonthlyPdf(insight, range);
  const filename = monthlyPdfFilename(insight, range);
  return {
    employeeId: insight.employeeId || null,
    employeeName: insight.employeeName || null,
    filename,
    contentType: 'application/pdf',
    contentBase64: buffer.toString('base64'),
    byteLength: buffer.length,
  };
}

async function attachMonthlyPdfs(insights, range) {
  if (!insights || !insights.length) return [];
  const out = [];
  for (const insight of insights) {
    const pdf = await buildEmployeeMonthlyPdfAttachment(insight, range);
    out.push({ ...insight, pdf });
  }
  return out;
}

module.exports = {
  renderEmployeeMonthlyPdf,
  buildEmployeeMonthlyPdfAttachment,
  attachMonthlyPdfs,
  monthlyPdfFilename,
  BRAND,
};
