'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  renderEmployeeMonthlyPdf,
  monthlyPdfFilename,
  buildEmployeeMonthlyPdfAttachment,
} = require('../src/services/monthlyReportPdfService');

const insight = {
  employeeId: 'e1',
  employeeName: 'Alice Khan',
  teamName: 'Ops',
  workedDays: 18,
  expectedWorkingDays: 22,
  absentDays: 1,
  lateCount: 2,
  lateDays: 2,
  strikeCount: 1,
  avgCheckInTime: '09:12',
  avgCheckOutTime: '18:05',
  onProbation: true,
  probationEndsOn: '2026-07-01',
  dateOfJoining: '2026-04-01',
  employmentStatus: 'Probation',
  leaveTakenLabel: 'Annual 1',
  leaveItems: [
    {
      leaveType: 'Annual',
      fromDate: '2026-07-10',
      toDate: '2026-07-10',
      daysInPeriod: 1,
    },
  ],
  leaveBalancesLabel: 'Annual 9 · Sick 5 · Casual 2',
  presentDays: 18,
  onsiteDays: 15,
  remoteDays: 3,
  leaveDays: 1,
  holidayDays: 0,
  workedDuration: '162 hours 0 mins',
  expectedDuration: '198 hours 0 mins',
  hoursVarianceDuration: '−36 hours 0 mins',
};

describe('monthlyReportPdfService', () => {
  test('renders a non-empty PDF buffer', async () => {
    const buf = await renderEmployeeMonthlyPdf(insight, {
      from: '2026-07-01',
      to: '2026-07-31',
    });
    assert.ok(Buffer.isBuffer(buf));
    assert.ok(buf.length > 500);
    // PDF magic header
    assert.equal(buf.subarray(0, 4).toString('utf8'), '%PDF');
  });

  test('filename is safe and includes month', () => {
    const name = monthlyPdfFilename(insight, { from: '2026-07-01', to: '2026-07-31' });
    assert.equal(name, 'Alice_Khan_2026-07_monthly.pdf');
  });

  test('attachment payload includes base64', async () => {
    const att = await buildEmployeeMonthlyPdfAttachment(insight, {
      from: '2026-07-01',
      to: '2026-07-31',
    });
    assert.equal(att.contentType, 'application/pdf');
    assert.ok(att.contentBase64.length > 100);
    assert.equal(att.filename, 'Alice_Khan_2026-07_monthly.pdf');
    assert.equal(att.employeeName, 'Alice Khan');
  });
});
