'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildEmployeeMonthlyInsight,
  averageHm,
  addCalendarMonths,
  PROBATION_MONTHS,
} = require('../src/services/reportService');

const EMP = {
  id: 'e1',
  fields: {
    Name: 'Alice',
    Team: ['t1'],
    AssignedShift: ['s1'],
    EmploymentStatus: 'Full-time',
    DateOfJoining: '2024-01-15',
  },
};

const EMP_PROBATION = {
  id: 'e2',
  fields: {
    Name: 'Bob',
    Team: ['t1'],
    AssignedShift: ['s1'],
    EmploymentStatus: 'Probation',
    DateOfJoining: '2026-04-01',
  },
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
    checkInTime: null,
    checkOutTime: null,
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
    assert.equal(insight.workedDays, 2);
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
    assert.equal(insight.workedDays, 2); // present + still checked in
    assert.equal(insight.remoteDays, 1);
    assert.equal(insight.onsiteDays, 1);
  });

  test('averages check-in and check-out times', () => {
    const empRows = [
      row({
        date: '2026-07-01',
        status: 'Present',
        workedMinutes: 540,
        checkInTime: '09:00',
        checkOutTime: '18:00',
      }),
      row({
        date: '2026-07-02',
        status: 'Present',
        workedMinutes: 540,
        checkInTime: '09:30',
        checkOutTime: '18:30',
      }),
    ];

    const insight = buildEmployeeMonthlyInsight(EMP, empRows, {
      holidaySet: new Set(),
      leaveSet: new Set(),
      shift: shift9to18,
    });

    assert.equal(insight.avgCheckInTime, '09:15');
    assert.equal(insight.avgCheckOutTime, '18:15');
  });

  test('includes probation, leave taken/balances, and strikes', () => {
    const empRows = [
      row({
        date: '2026-07-01',
        status: 'Present',
        workedMinutes: 540,
        checkInTime: '09:10',
        checkOutTime: '18:00',
        isLate: true,
        lateByMinutes: 10,
      }),
      row({ date: '2026-07-02', status: 'On Leave' }),
    ];

    const insight = buildEmployeeMonthlyInsight(EMP_PROBATION, empRows, {
      holidaySet: new Set(),
      leaveSet: new Set(['2026-07-02']),
      shift: shift9to18,
      leaveMeta: {
        taken: { annual: 1, sick: 0, casual: 0 },
        items: [
          {
            leaveType: 'Annual',
            fromDate: '2026-07-02',
            toDate: '2026-07-02',
            endsOn: '2026-07-02',
            daysInPeriod: 1,
            totalDays: 1,
          },
        ],
      },
      leaveBalances: { annual: 8, sick: 5, casual: 2 },
      strikeInfo: {
        lateCount: 1,
        strikeCount: 2,
        items: [{ date: '2026-07-01', reason: 'Immediate strike' }],
      },
    });

    assert.equal(insight.onProbation, true);
    assert.equal(insight.dateOfJoining, '2026-04-01');
    assert.equal(insight.probationEndsOn, addCalendarMonths('2026-04-01', PROBATION_MONTHS));
    assert.equal(insight.leaveTaken.annual, 1);
    assert.equal(insight.leaveTakenLabel, 'Annual 1');
    assert.equal(insight.leaveBalances.sick, 5);
    assert.match(insight.leaveBalancesLabel, /Annual 8/);
    assert.equal(insight.lateCount, 1);
    assert.equal(insight.strikeCount, 2);
    assert.equal(insight.leaveItems.length, 1);
    assert.equal(insight.leaveItems[0].endsOn, '2026-07-02');
  });
});

describe('averageHm', () => {
  test('returns null for empty list', () => {
    assert.equal(averageHm([]), null);
  });

  test('averages HH:mm strings', () => {
    assert.equal(averageHm(['10:00', '11:00']), '10:30');
  });
});

describe('addCalendarMonths', () => {
  test('adds months and clamps day', () => {
    assert.equal(addCalendarMonths('2026-01-31', 1), '2026-02-28');
    assert.equal(addCalendarMonths('2026-04-01', 3), '2026-07-01');
  });
});
