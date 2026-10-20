'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { AppError } = require('../src/middleware/errorHandler');
const {
  needsEvidence,
  resolveSickLeaveEvidence,
} = require('../src/utils/sickLeaveEvidence');

const EMP = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const UPLOAD = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BASE = 'https://alms.example.com';

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
    leaveType: 'Sick',
    days: 2,
    evidenceUrl: `${BASE}/api/uploads/${UPLOAD}`,
    upload: upload(),
    employeeId: EMP,
    appBaseUrl: BASE,
    ...overrides,
  });
}

describe('sick leave prescription rule', () => {
  test('two or more sick working days require evidence', () => {
    assert.equal(needsEvidence('Sick', 2), true);
    assert.equal(needsEvidence('Sick', 5), true);
    assert.equal(needsEvidence('Sick', 1), false);
    assert.equal(needsEvidence('Annual', 10), false);
    assert.equal(needsEvidence('Casual', 3), false);
  });

  test('sick leave of 2 days without a file is rejected', () => {
    assert.throws(() => resolve({ evidenceUrl: '', upload: null }), (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.status, 400);
      assert.equal(err.code, 'EVIDENCE_REQUIRED');
      return true;
    });
  });

  test('one sick day does not require a file', () => {
    assert.equal(resolve({ days: 1, evidenceUrl: null, upload: null }), null);
  });

  test('a valid prescription is stored as a canonical upload URL', () => {
    assert.equal(
      resolve({ evidenceUrl: `${BASE}/api/uploads/${UPLOAD}?unused=1` }),
      `${BASE}/api/uploads/${UPLOAD}`
    );
  });

  test('a photo or CNIC upload cannot stand in for a prescription', () => {
    assert.throws(() => resolve({ upload: upload({ purpose: 'photo' }) }), (err) => {
      assert.equal(err.code, 'INVALID_EVIDENCE');
      return true;
    });
  });

  test('another employee\'s prescription is rejected', () => {
    assert.throws(() => resolve({ upload: upload({ employee_id: OTHER }) }), (err) => {
      assert.equal(err.status, 403);
      assert.equal(err.code, 'INVALID_EVIDENCE');
      return true;
    });
  });

  test('annual leave may omit evidence', () => {
    assert.equal(
      resolve({ leaveType: 'Annual', days: 4, evidenceUrl: null, upload: null }),
      null
    );
  });
});
