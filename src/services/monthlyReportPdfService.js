'use strict';

/**
 * One-page monthly attendance PDF for a single employee (pdfkit).
 * Used only for monthly reports — managers receive one PDF per reportee.
 */

const PDFDocument = require('pdfkit');

const COLORS = {
  navy: '#07111F',
  teal: '#0F766E',
  ink: '#0B1220',
  muted: '#5B6575',
  line: '#E6E9EF',
  surface: '#F7F8FA',
  late: '#B45309',
  absent: '#B91C1C',
  white: '#FFFFFF',
};

function safeFilenamePart(name) {
  return String(name || 'employee')
    .replace(/[^\w\s\-]+/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 60) || 'employee';
}

/**
 * @param {object} insight  monthly insight from reportService
 * @param {{from: string, to: string}} range
 * @returns {string} e.g. Alice_2026-07_monthly.pdf
 */
function monthlyPdfFilename(insight, range) {
  const ym = String(range.from || '').slice(0, 7) || 'month';
  return `${safeFilenamePart(insight.employeeName)}_${ym}_monthly.pdf`;
}

function drawLabelValue(doc, x, y, label, value, opts = {}) {
  const { labelColor = COLORS.muted, valueColor = COLORS.ink, valueSize = 16 } = opts;
  doc.fontSize(8).fillColor(labelColor).text(String(label).toUpperCase(), x, y, {
    width: opts.width || 150,
    characterSpacing: 0.4,
  });
  doc
    .fontSize(valueSize)
    .fillColor(valueColor)
    .text(String(value ?? '—'), x, y + 12, { width: opts.width || 150 });
}

/**
 * Render a one-employee monthly PDF.
 * @param {object} insight
 * @param {{from: string, to: string}} range
 * @returns {Promise<Buffer>}
 */
function renderEmployeeMonthlyPdf(insight, range) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 48,
      info: {
        Title: `Monthly attendance — ${insight.employeeName || 'Employee'}`,
        Author: 'Aidapt ALMS',
        Subject: `${range.from} → ${range.to}`,
      },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = doc.page.width;
    const left = 48;
    const contentWidth = pageWidth - 96;

    // Header bar
    doc.rect(0, 0, pageWidth, 72).fill(COLORS.navy);
    doc.rect(0, 72, pageWidth, 3).fill(COLORS.teal);
    doc
      .fillColor(COLORS.white)
      .fontSize(20)
      .font('Helvetica-Bold')
      .text('Aidapt.', left, 22, { continued: false });
    doc
      .fontSize(9)
      .font('Helvetica')
      .fillColor('rgba(255,255,255,0.7)')
      .fillColor('#A8B3C4')
      .text('Attendance & Leave · ALMS', left, 46);
    doc
      .fontSize(10)
      .fillColor(COLORS.teal)
      .font('Helvetica-Bold')
      .text('MONTHLY REPORT', left, 28, { width: contentWidth, align: 'right' });

    let y = 100;

    // Employee block
    doc
      .fontSize(18)
      .fillColor(COLORS.ink)
      .font('Helvetica-Bold')
      .text(insight.employeeName || 'Employee', left, y);
    y = doc.y + 4;
    const teamLine = [insight.teamName, range.from === range.to ? range.from : `${range.from} → ${range.to}`]
      .filter(Boolean)
      .join(' · ');
    doc.fontSize(11).font('Helvetica').fillColor(COLORS.muted).text(teamLine, left, y);
    y = doc.y + 8;

    let statusLine;
    if (insight.onProbation) {
      statusLine = `On probation${
        insight.probationEndsOn ? ` · ends ${insight.probationEndsOn}` : ''
      }${insight.dateOfJoining ? ` · joined ${insight.dateOfJoining}` : ''}`;
    } else {
      statusLine = insight.employmentStatus || 'Full-time';
    }
    doc
      .fontSize(10)
      .fillColor(insight.onProbation ? COLORS.late : COLORS.muted)
      .text(statusLine, left, y);
    y = doc.y + 18;

    // Metric cards row 1
    const cardH = 58;
    const gap = 10;
    const cardW = (contentWidth - gap * 2) / 3;
    const cards1 = [
      { label: 'Worked days', value: insight.workedDays ?? 0 },
      { label: 'Expected days', value: insight.expectedWorkingDays ?? 0 },
      {
        label: 'Absent',
        value: insight.absentDays ?? 0,
        valueColor: insight.absentDays ? COLORS.absent : COLORS.ink,
      },
    ];
    cards1.forEach((c, i) => {
      const x = left + i * (cardW + gap);
      doc.roundedRect(x, y, cardW, cardH, 6).fill(COLORS.surface);
      doc.roundedRect(x, y, cardW, cardH, 6).lineWidth(0.5).strokeColor(COLORS.line).stroke();
      drawLabelValue(doc, x + 12, y + 12, c.label, c.value, {
        width: cardW - 24,
        valueColor: c.valueColor || COLORS.ink,
        valueSize: 20,
      });
    });
    y += cardH + 12;

    // Metric cards row 2
    const cards2 = [
      { label: 'Late this month', value: insight.lateCount ?? insight.lateDays ?? 0 },
      {
        label: 'Strikes this month',
        value: insight.strikeCount ?? 0,
        valueColor: insight.strikeCount ? COLORS.late : COLORS.ink,
      },
      {
        label: 'Avg in / out (PKT)',
        value: `${insight.avgCheckInTime || '—'} / ${insight.avgCheckOutTime || '—'}`,
        valueSize: 13,
      },
    ];
    cards2.forEach((c, i) => {
      const x = left + i * (cardW + gap);
      doc.roundedRect(x, y, cardW, cardH, 6).fill(COLORS.surface);
      doc.roundedRect(x, y, cardW, cardH, 6).lineWidth(0.5).strokeColor(COLORS.line).stroke();
      drawLabelValue(doc, x + 12, y + 12, c.label, c.value, {
        width: cardW - 24,
        valueColor: c.valueColor || COLORS.ink,
        valueSize: c.valueSize || 20,
      });
    });
    y += cardH + 20;

    // Leave section
    doc
      .fontSize(12)
      .font('Helvetica-Bold')
      .fillColor(COLORS.ink)
      .text('Leave', left, y);
    y = doc.y + 8;
    doc
      .fontSize(10)
      .font('Helvetica')
      .fillColor(COLORS.muted)
      .text('Taken this month', left, y);
    doc
      .fillColor(COLORS.ink)
      .text(insight.leaveTakenLabel || 'None', left + 120, y, { width: contentWidth - 120 });
    y = Math.max(doc.y, y + 14) + 4;

    const items = Array.isArray(insight.leaveItems) ? insight.leaveItems : [];
    if (items.length) {
      for (const it of items) {
        const type = it.leaveType || 'Leave';
        const rangeLabel =
          it.fromDate && it.toDate && it.fromDate !== it.toDate
            ? `${it.fromDate} → ${it.toDate}`
            : it.fromDate || it.toDate || '—';
        const days = it.daysInPeriod != null ? ` (${it.daysInPeriod}d)` : '';
        doc
          .fontSize(10)
          .fillColor(COLORS.ink)
          .text(`• ${type}: ${rangeLabel}${days}`, left + 12, y, { width: contentWidth - 12 });
        y = doc.y + 2;
      }
      y += 6;
    }

    doc.fontSize(10).fillColor(COLORS.muted).text('Balances remaining', left, y);
    doc
      .fillColor(COLORS.ink)
      .text(insight.leaveBalancesLabel || 'Annual 0 · Sick 0 · Casual 0', left + 120, y, {
        width: contentWidth - 120,
      });
    y = Math.max(doc.y, y + 14) + 16;

    // Extra attendance context
    doc.fontSize(12).font('Helvetica-Bold').fillColor(COLORS.ink).text('Attendance detail', left, y);
    y = doc.y + 8;
    const detail = [
      ['Present days', insight.presentDays ?? 0],
      ['Onsite days', insight.onsiteDays ?? 0],
      ['Remote days', insight.remoteDays ?? 0],
      ['Leave days', insight.leaveDays ?? 0],
      ['Holiday days', insight.holidayDays ?? 0],
      ['Worked hours', insight.workedDuration || '—'],
      ['Expected hours', insight.expectedDuration || '—'],
      ['Hours variance', insight.hoursVarianceDuration || '—'],
    ];
    for (const [label, value] of detail) {
      doc.fontSize(10).font('Helvetica').fillColor(COLORS.muted).text(label, left, y, { width: 160 });
      doc.fillColor(COLORS.ink).text(String(value), left + 170, y, { width: contentWidth - 170 });
      y = Math.max(doc.y, y + 14);
    }

    // Footer
    const footerY = doc.page.height - 40;
    doc
      .moveTo(left, footerY - 8)
      .lineTo(left + contentWidth, footerY - 8)
      .strokeColor(COLORS.line)
      .lineWidth(0.5)
      .stroke();
    doc
      .fontSize(8)
      .fillColor(COLORS.muted)
      .text('Sent by Aidapt ALMS · The operator’s AI firm · aidapt.co', left, footerY, {
        width: contentWidth,
        align: 'left',
      });

    doc.end();
  });
}

/**
 * Build PDF payload for one employee insight (no Buffer in return).
 * @returns {Promise<{employeeId, employeeName, filename, contentType, contentBase64, byteLength}>}
 */
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

/**
 * Attach pdf metadata onto each insight (mutates copies).
 * @param {Array<object>} insights
 * @param {{from: string, to: string}} range
 */
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
};
