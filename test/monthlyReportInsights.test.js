'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildEmployeeMonthlyInsight,
  toMonthEndReport,
  latesFromRows,
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

  test('does not reduce expected days for leave (same company calendar for all)', () => {
    const empRows = [
      row({ date: '2026-07-01', status: 'Present', mode: 'Office', workedMinutes: 540 }), // Wed
      row({ date: '2026-07-02', status: 'On Leave' }), // Thu leave
      row({ date: '2026-07-03', status: 'Holiday' }), // Fri holiday
    ];

    const insight = buildEmployeeMonthlyInsight(EMP, empRows, {
      holidaySet: new Set(['2026-07-03']),
      leaveSet: new Set(['2026-07-02']),
      shift: shift9to18,
      leaveMeta: {
        taken: { annual: 1, sick: 0, casual: 0 },
        items: [{ leaveType: 'Annual', fromDate: '2026-07-02', toDate: '2026-07-02', daysInPeriod: 1 }],
      },
      leaveBalances: { annual: 9, sick: 5, casual: 2 },
    });

    // Company Mon–Fri: Wed+Thu counted, Fri is holiday → 2 expected (leave does not drop it)
    assert.equal(insight.expectedWorkingDays, 2);
    assert.equal(insight.leaveDays, 1);
    assert.equal(insight.holidayDays, 1);
    assert.equal(insight.workedDays, 1);
    assert.equal(insight.leaveTakenLabel, 'Annual 1');
    assert.match(insight.leaveBalancesLabel, /Annual 9/);
  });

  test('remote days count as worked days', () => {
    const empRows = [
      row({ date: '2026-07-01', status: 'Present', mode: 'Office', workedMinutes: 540 }),
      row({ date: '2026-07-02', status: 'Present', mode: 'Remote', workedMinutes: 480 }),
    ];

    const insight = buildEmployeeMonthlyInsight(EMP, empRows, {
      holidaySet: new Set(),
      leaveSet: new Set(),
      shift: shift9to18,
    });

    assert.equal(insight.onsiteDays, 1);
    assert.equal(insight.remoteDays, 1);
    assert.equal(insight.workedDays, 2);
    assert.equal(insight.expectedWorkingDays, 2);
  });

  test('unapproved remote check-in counts as absent, not a worked remote day', () => {
    const empRows = [
      row({
        date: '2026-07-01',
        status: 'Absent',
        mode: 'Remote',
        workedMinutes: 480,
        checkInTime: '10:05',
        checkOutTime: '18:05',
        isLate: true,
        lateByMinutes: 5,
      }),
      row({ date: '2026-07-02', status: 'Present', mode: 'Office', workedMinutes: 540 }),
    ];

    const insight = buildEmployeeMonthlyInsight(EMP, empRows, {
      holidaySet: new Set(),
      leaveSet: new Set(),
      shift: shift9to18,
    });

    assert.equal(insight.absentDays, 1);
    assert.equal(insight.remoteDays, 0);
    assert.equal(insight.presentDays, 1);
    assert.equal(insight.workedDays, 1);
    assert.equal(insight.workedMinutes, 540);
    assert.equal(insight.lateDays, 0);
    assert.equal(insight.onsiteDays, 1);
  });

  test('two people with different leave still share same expected days', () => {
    const baseRows = [
      row({ date: '2026-07-01', status: 'Present', mode: 'Office', workedMinutes: 540 }),
      row({ date: '2026-07-02', status: 'Present', mode: 'Remote', workedMinutes: 480 }),
      row({ date: '2026-07-03', status: 'Present', mode: 'Office', workedMinutes: 540 }),
    ];
    const alice = buildEmployeeMonthlyInsight(EMP, baseRows, {
      holidaySet: new Set(),
      leaveSet: new Set(),
      shift: shift9to18,
    });
    const bobRows = [
      row({ date: '2026-07-01', status: 'Present', mode: 'Office', workedMinutes: 540 }),
      row({ date: '2026-07-02', status: 'On Leave' }),
      row({ date: '2026-07-03', status: 'Present', mode: 'Office', workedMinutes: 540 }),
    ];
    const bob = buildEmployeeMonthlyInsight(EMP_PROBATION, bobRows, {
      holidaySet: new Set(),
      leaveSet: new Set(['2026-07-02']),
      shift: shift9to18,
    });

    assert.equal(alice.expectedWorkingDays, bob.expectedWorkingDays);
    assert.equal(alice.expectedWorkingDays, 3);
    assert.equal(bob.leaveDays, 1);
    assert.equal(bob.workedDays, 2);
    assert.equal(alice.workedDays, 3);
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

describe('latesFromRows', () => {
  test('returns punch-based lates with date and check-in, sorted by date', () => {
    const lates = latesFromRows([
      row({
        date: '2026-07-03',
        status: 'Present',
        isLate: true,
        checkInTime: '09:40',
        lateByMinutes: 25,
      }),
      row({ date: '2026-07-01', status: 'Present', isLate: false, checkInTime: '09:00' }),
      row({
        date: '2026-07-02',
        status: 'Present',
        isLate: true,
        checkInTime: '09:12',
        lateByMinutes: 7,
      }),
    ]);
    assert.equal(lates.length, 2);
    assert.deepEqual(lates[0], {
      date: '2026-07-02',
      checkInTime: '09:12',
      lateByMinutes: 7,
    });
    assert.deepEqual(lates[1], {
      date: '2026-07-03',
      checkInTime: '09:40',
      lateByMinutes: 25,
    });
  });
});

describe('toMonthEndReport', () => {
  test('maps insight + late punches; includes leave reason; lateCount is punch-based', () => {
    const empRows = [
      row({
        date: '2026-07-01',
        status: 'Present',
        mode: 'Office',
        workedMinutes: 540,
        isLate: true,
        checkInTime: '09:22',
        lateByMinutes: 7,
      }),
      row({ date: '2026-07-02', status: 'On Leave' }),
      row({
        date: '2026-07-03',
        status: 'Present',
        mode: 'Remote',
        workedMinutes: 480,
        isLate: false,
        checkInTime: '09:00',
      }),
    ];

    const insight = buildEmployeeMonthlyInsight(EMP, empRows, {
      holidaySet: new Set(),
      leaveSet: new Set(['2026-07-02']),
      shift: shift9to18,
      leaveMeta: {
        taken: { annual: 0, sick: 0, casual: 1 },
        items: [
          {
            leaveType: 'Casual',
            fromDate: '2026-07-02',
            toDate: '2026-07-02',
            daysInPeriod: 1,
            totalDays: 1,
            reason: 'Personal work',
          },
        ],
      },
      leaveBalances: { annual: 10, sick: 5, casual: 1 },
      strikeInfo: { lateCount: 99, strikeCount: 3, items: [] },
    });

    const report = toMonthEndReport(insight, empRows, { monthlySalary: 90000 });
    assert.equal(report.employeeName, 'Alice');
    assert.equal(report.expectedWorkingDays, 3);
    assert.equal(report.workedDays, 2);
    assert.equal(report.leaveDays, 1);
    assert.equal(report.lateCount, 1);
    assert.deepEqual(report.lates, [
      { date: '2026-07-01', checkInTime: '09:22', lateByMinutes: 7 },
    ]);
    assert.deepEqual(report.leaveTaken, { annual: 0, sick: 0, casual: 1 });
    assert.equal(report.leaveItems.length, 1);
    assert.equal(report.leaveItems[0].reason, 'Personal work');
    assert.equal(report.leaveItems[0].leaveType, 'Casual');
    assert.deepEqual(report.leaveBalances, { annual: 10, sick: 5, casual: 1 });
    assert.equal(report.monthlySalary, 90000);
    assert.equal(report.payableDays, 3);
    assert.equal(report.payableAmount, 90000);
    assert.equal(report.unpaidDays, 0);
    assert.equal(report.onProbation, false);
  });

  test('full-time applied leave is paid (no salary cut)', () => {
    const empRows = [
      row({ date: '2026-07-01', status: 'Present', mode: 'Office', workedMinutes: 540 }),
      row({ date: '2026-07-02', status: 'On Leave' }),
      row({ date: '2026-07-03', status: 'Present', mode: 'Office', workedMinutes: 540 }),
    ];
    const insight = buildEmployeeMonthlyInsight(EMP, empRows, {
      holidaySet: new Set(),
      leaveSet: new Set(['2026-07-02']),
      shift: shift9to18,
      leaveMeta: { taken: { annual: 1, sick: 0, casual: 0 }, items: [] },
      leaveBalances: { annual: 9, sick: 5, casual: 2 },
    });
    const report = toMonthEndReport(insight, empRows, { monthlySalary: 90000 });
    assert.equal(report.leaveDays, 1);
    assert.equal(report.absentDays, 0);
    assert.equal(report.payableDays, 3);
    assert.equal(report.payableAmount, 90000);
    assert.equal(report.unpaidDays, 0);
  });

  test('probation leave and absences are unpaid', () => {
    const empRows = [
      row({ date: '2026-07-01', status: 'Present', mode: 'Office', workedMinutes: 540 }),
      row({ date: '2026-07-02', status: 'On Leave' }),
      row({ date: '2026-07-03', status: 'Absent' }),
    ];
    const insight = buildEmployeeMonthlyInsight(EMP_PROBATION, empRows, {
      holidaySet: new Set(),
      leaveSet: new Set(['2026-07-02']),
      shift: shift9to18,
      leaveMeta: { taken: { annual: 0, sick: 0, casual: 1 }, items: [] },
      leaveBalances: { annual: 10, sick: 5, casual: 4 },
    });
    const report = toMonthEndReport(insight, empRows, { monthlySalary: 40000 });
    assert.equal(report.onProbation, true);
    assert.equal(report.workedDays, 1);
    assert.equal(report.leaveDays, 1);
    assert.equal(report.absentDays, 1);
    assert.equal(report.payableDays, 1);
    assert.equal(report.unpaidDays, 2);
    assert.equal(report.absenceCoverage.fromCasual, 0);
    assert.equal(report.absenceCoverage.fromAnnual, 0);
    assert.equal(report.payableAmount, 13333.33);
  });

  test('full-time unauthorized absence covers Casual then Annual', () => {
    const empRows = [
      row({ date: '2026-07-01', status: 'Present', mode: 'Office', workedMinutes: 540 }),
      row({ date: '2026-07-02', status: 'Absent' }),
      row({ date: '2026-07-03', status: 'Absent' }),
    ];
    const insight = buildEmployeeMonthlyInsight(EMP, empRows, {
      holidaySet: new Set(),
      leaveSet: new Set(),
      shift: shift9to18,
      leaveBalances: { annual: 10, sick: 5, casual: 1 },
    });
    const report = toMonthEndReport(insight, empRows, { monthlySalary: 90000 });
    assert.equal(report.workedDays, 1);
    assert.equal(report.absentDays, 2);
    assert.equal(report.absenceCoverage.fromCasual, 1);
    assert.equal(report.absenceCoverage.fromAnnual, 1);
    assert.equal(report.unpaidDays, 0);
    assert.equal(report.payableDays, 3);
    assert.equal(report.payableAmount, 90000);
    assert.deepEqual(report.leaveBalancesAfterCoverage, { annual: 9, sick: 5, casual: 0 });
  });

  test('full-time remaining absences after leave is exhausted are unpaid', () => {
    const empRows = [
      row({ date: '2026-07-01', status: 'Present', mode: 'Office', workedMinutes: 540 }),
      row({ date: '2026-07-02', status: 'Absent' }),
      row({ date: '2026-07-03', status: 'Absent' }),
    ];
    const insight = buildEmployeeMonthlyInsight(EMP, empRows, {
      holidaySet: new Set(),
      leaveSet: new Set(),
      shift: shift9to18,
      leaveBalances: { annual: 0, sick: 5, casual: 1 },
    });
    const report = toMonthEndReport(insight, empRows, { monthlySalary: 90000 });
    assert.equal(report.absenceCoverage.fromCasual, 1);
    assert.equal(report.absenceCoverage.fromAnnual, 0);
    assert.equal(report.unpaidDays, 1);
    assert.equal(report.payableDays, 2);
    assert.equal(report.payableAmount, 60000);
  });

  test('payableAmount is null when salary is missing', () => {
    const empRows = [
      row({ date: '2026-07-01', status: 'Present', mode: 'Office', workedMinutes: 540 }),
    ];
    const insight = buildEmployeeMonthlyInsight(EMP, empRows, {
      holidaySet: new Set(),
      leaveSet: new Set(),
      shift: shift9to18,
    });
    const report = toMonthEndReport(insight, empRows);
    assert.equal(report.leaveDays, 0);
    assert.equal(report.payableDays, 1);
    assert.equal(report.monthlySalary, null);
    assert.equal(report.payableAmount, null);
  });

  test('payableAmount prorates when absents reduce payable days', () => {
    const empRows = [
      row({ date: '2026-07-01', status: 'Present', mode: 'Office', workedMinutes: 540 }),
      row({ date: '2026-07-02', status: 'Absent' }),
      row({ date: '2026-07-03', status: 'Present', mode: 'Office', workedMinutes: 540 }),
    ];
    const insight = buildEmployeeMonthlyInsight(EMP, empRows, {
      holidaySet: new Set(),
      leaveSet: new Set(),
      shift: shift9to18,
    });
    const report = toMonthEndReport(insight, empRows, { monthlySalary: 90000 });
    assert.equal(report.expectedWorkingDays, 3);
    assert.equal(report.workedDays, 2);
    assert.equal(report.leaveDays, 0);
    assert.equal(report.payableDays, 2);
    assert.equal(report.payableAmount, 60000);
    assert.equal(report.unpaidDays, 1);
  });
});
