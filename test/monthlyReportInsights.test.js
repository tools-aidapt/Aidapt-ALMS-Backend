'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildEmployeeMonthlyInsight } = require('../src/services/reportService');

const EMP = {
  id: 'e1',
  fields: { Name: 'Alice', Team: ['t1'], AssignedShift: ['s1'] },
};

const shift9to18 = {
  id: 's1',
  fields: {
    StartTime: '09:00',
    EndTime: '18:00',
    WorkingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
  },
};

function row(partial) {
  return {
    employeeId: 'e1',
    employeeName: 'Alice',
    teamName: 'Ops',
    lateByMinutes: 0,
    overtimeHours: null,
    isLate: false,
    mode: null,
    workedMinutes: null,
    ...partial,
  };
}

describe('buildEmployeeMonthlyInsight', () => {
  test('sums worked hours and counts onsite/remote', () => {
    const empRows = [
      row({ date: '2026-07-01', status: 'Present', mode: 'Office', workedMinutes: 540 }), // Wed
      row({ date: '2026-07-02', status: 'Present', mode: 'Remote', workedMinutes: 480 }), // Thu
      row({ date: '2026-07-03', status: 'Absent' }), // Fri
      row({ date: '2026-07-04', status: 'No record' }), // Sat
      row({ date: '2026-07-05', status: 'No record' }), // Sun
    ];

    const insight = buildEmployeeMonthlyInsight(EMP, empRows, {
      holidaySet: new Set(),
      leaveSet: new Set(),
      shift: shift9to18,
    });

    assert.equal(insight.workedMinutes, 1020);
    assert.equal(insight.workedHours, 17);
    assert.equal(insight.onsiteDays, 1);
    assert.equal(insight.remoteDays, 1);
    assert.equal(insight.presentDays, 2);
    assert.equal(insight.absentDays, 1);
    // Wed+Thu+Fri = 3 expected working days × 9h
    assert.equal(insight.expectedWorkingDays, 3);
    assert.equal(insight.expectedHours, 27);
    assert.equal(insight.hoursVariance, -10);
  });

  test('excludes holidays and leave from expected hours', () => {
    const empRows = [
      row({ date: '2026-07-01', status: 'Present', mode: 'Office', workedMinutes: 540 }), // Wed
      row({ date: '2026-07-02', status: 'On Leave' }), // Thu leave
      row({ date: '2026-07-03', status: 'Holiday' }), // Fri holiday marked
    ];

    const insight = buildEmployeeMonthlyInsight(EMP, empRows, {
      holidaySet: new Set(['2026-07-03']),
      leaveSet: new Set(['2026-07-02']),
      shift: shift9to18,
    });

    assert.equal(insight.expectedWorkingDays, 1); // only Wed
    assert.equal(insight.expectedHours, 9);
    assert.equal(insight.leaveDays, 1);
    assert.equal(insight.holidayDays, 1);
    assert.equal(insight.workedHours, 9);
    assert.equal(insight.hoursVariance, 0);
  });

  test('counts late days and still-checked-in separately', () => {
    const empRows = [
      row({
        date: '2026-07-01',
        status: 'Present',
        mode: 'Office',
        workedMinutes: 540,
        isLate: true,
        lateByMinutes: 12,
      }),
      row({ date: '2026-07-02', status: 'Still checked in', mode: 'Remote' }),
    ];

    const insight = buildEmployeeMonthlyInsight(EMP, empRows, {
      holidaySet: new Set(),
      leaveSet: new Set(),
      shift: shift9to18,
    });

    assert.equal(insight.lateDays, 1);
    assert.equal(insight.lateMinutes, 12);
    assert.equal(insight.stillCheckedInDays, 1);
    assert.equal(insight.remoteDays, 1);
    assert.equal(insight.onsiteDays, 1);
  });
});
