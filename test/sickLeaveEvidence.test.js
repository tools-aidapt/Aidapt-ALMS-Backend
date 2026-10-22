'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { AppError } = require('../src/middleware/errorHandler');
const {
  needsEvidence,
  resolveSickLeaveEvidence,
  returnDayAfter,
  returnWindowOpen,
  returnWindowOver,
  shouldCloseForMissingPrescription,
} = require('../src/utils/sickLeaveEvidence');

const EMP = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const UPLOAD = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BASE = 'https://alms.example.com';
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

function upload(overrides = {}) {
  return {
    id: UPLOAD,
    employee_id: EMP,
    purpose: 'sick_leave_evidence',
    ...overrides,
  };
}

function resolve(overrides = {}) {
  return resolveSickLeaveEvidence({
    evidenceUrl: `${BASE}/api/uploads/${UPLOAD}`,
    upload: upload(),
    employeeId: EMP,
    appBaseUrl: BASE,
    ...overrides,
  });
}

describe('sick leave prescription rule', () => {
  test('two or more sick working days need a prescription later', () => {
    assert.equal(needsEvidence('Sick', 2), true);
    assert.equal(needsEvidence('Sick', 5), true);
    assert.equal(needsEvidence('Sick', 1), false);
    assert.equal(needsEvidence('Annual', 10), false);
    assert.equal(needsEvidence('Casual', 3), false);
  });

  test('applying without a file is allowed', () => {
    assert.equal(resolve({ evidenceUrl: '', upload: null }), null);
    assert.equal(resolve({ evidenceUrl: null, upload: null }), null);
  });

  test('a valid prescription is stored as a canonical upload URL', () => {
    assert.equal(
      resolve({ evidenceUrl: `${BASE}/api/uploads/${UPLOAD}?unused=1` }),
      `${BASE}/api/uploads/${UPLOAD}`
    );
  });

  test('a photo or CNIC upload cannot stand in for a prescription', () => {
    assert.throws(() => resolve({ upload: upload({ purpose: 'photo' }) }), (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, 'INVALID_EVIDENCE');
      return true;
    });
  });

  test("another employee's prescription is rejected", () => {
    assert.throws(() => resolve({ upload: upload({ employee_id: OTHER }) }), (err) => {
      assert.equal(err.status, 403);
      assert.equal(err.code, 'INVALID_EVIDENCE');
      return true;
    });
  });
});

describe('return day', () => {
  test('the return day is the next working day after the leave ends', () => {
    // Wednesday 21 Oct 2026 → Thursday 22 Oct 2026
    assert.equal(returnDayAfter('2026-10-21', WEEKDAYS, []), '2026-10-22');
  });

  test('a Friday leave returns on Monday', () => {
    assert.equal(returnDayAfter('2026-10-23', WEEKDAYS, []), '2026-10-26');
  });

  test('a holiday on the next working day is skipped', () => {
    // Thursday 22 Oct is a holiday, so Wednesday's leave returns Friday
    assert.equal(returnDayAfter('2026-10-21', WEEKDAYS, ['2026-10-22']), '2026-10-23');
  });

  test('upload opens on the return day and the window closes the day after', () => {
    assert.equal(returnWindowOpen('2026-10-22', '2026-10-22'), true);
    assert.equal(returnWindowOpen('2026-10-21', '2026-10-22'), false);
    assert.equal(returnWindowOver('2026-10-22', '2026-10-22'), false);
    assert.equal(returnWindowOver('2026-10-23', '2026-10-22'), true);
  });

  test('a missing file is closed at the end of the return day', () => {
    assert.equal(
      shouldCloseForMissingPrescription({
        status: 'Awaiting Prescription',
        today: '2026-10-22',
        returnDay: '2026-10-22',
      }),
      true
    );
    assert.equal(
      shouldCloseForMissingPrescription({
        status: 'Prescription Submitted',
        today: '2026-10-22',
        returnDay: '2026-10-22',
      }),
      false
    );
    assert.equal(
      shouldCloseForMissingPrescription({
        status: 'Awaiting Prescription',
        today: '2026-10-21',
        returnDay: '2026-10-22',
      }),
      false
    );
  });
});
