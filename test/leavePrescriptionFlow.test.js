'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/config/db');
const LeaveRequest = require('../src/models/LeaveRequest');
const Employee = require('../src/models/Employee');
const holidayService = require('../src/services/holidayService');
const uploadService = require('../src/services/uploadService');
const emailService = require('../src/services/emailService');
const leaveService = require('../src/services/leaveService');
const { AppError } = require('../src/middleware/errorHandler');
const { todayPktDateStr } = require('../src/utils/dateUtils');
const { addCalendarDays } = require('../src/utils/sickLeaveEvidence');

const EMP = '11111111-1111-1111-1111-111111111111';
const MGR = '22222222-2222-2222-2222-222222222222';
const REQ = '33333333-3333-3333-3333-333333333333';
const UPLOAD = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const originals = [];

function remember(obj, key) {
  originals.push({ obj, key, value: obj[key] });
}

function restoreAll() {
  for (const slot of originals) slot.obj[slot.key] = slot.value;
  originals.length = 0;
}

function request(overrides = {}) {
  const fields = {
    Employee: [EMP],
    Manager: [MGR],
    LeaveType: 'Sick',
    FromDate: '2026-10-19',
    ToDate: '2026-10-20',
    Days: 2,
    Reason: 'Fever',
    Status: 'Awaiting Prescription',
    EvidenceUrl: null,
    DecisionToken: 'tok',
    ...overrides.fields,
  };
  return { id: REQ, ...overrides, fields };
}

beforeEach(() => {
  remember(LeaveRequest, 'get');
  remember(LeaveRequest, 'update');
  remember(LeaveRequest, 'selectWhere');
  remember(Employee, 'get');
  remember(Employee, 'selectWhere');
  remember(holidayService, 'holidayDateSet');
  remember(uploadService, 'getById');
  remember(emailService, 'sendLeaveDecisionNotice');
  remember(emailService, 'sendLeaveEvidenceReview');
  remember(db, 'withTransaction');

  Employee.get = async (id) => ({
    id,
    fields: {
      Name: id === MGR ? 'Manager' : 'Employee',
      Email: id === MGR ? 'manager@example.com' : 'employee@example.com',
      AssignedShift: [],
      Manager: id === EMP ? [MGR] : [],
    },
  });
  Employee.selectWhere = async () => [];
  holidayService.holidayDateSet = async () => new Set();
  emailService.sendLeaveDecisionNotice = async () => {};
  emailService.sendLeaveEvidenceReview = async () => {};
  uploadService.getById = async () => ({
    id: UPLOAD,
    employee_id: EMP,
    purpose: 'sick_leave_evidence',
  });
});

afterEach(() => {
  restoreAll();
});

describe('prescription after return', () => {
  test('a file attached with the request shows as submitted while approval is still pending', () => {
    const row = leaveService.serialize(
      request({
        fields: {
          Status: 'Pending',
          EvidenceUrl: `https://alms.example.com/api/uploads/${UPLOAD}`,
        },
      })
    );
    assert.equal(row.prescriptionStatus, 'submitted');
    assert.equal(row.evidenceRequired, true);
    assert.match(row.prescriptionNote, /attached with this request/);
  });

  test('final approval of a request that already has a file opens prescription review', async () => {
    const queries = [];
    const url = `https://alms.example.com/api/uploads/${UPLOAD}`;
    db.withTransaction = async (fn) => {
      const client = {
        async query(sql, params) {
          queries.push({ sql, params });
          if (sql.includes('SELECT status')) return { rows: [{ status: 'Manager Approved' }] };
          return { rows: [] };
        },
      };
      return fn(client);
    };
    LeaveRequest.get = async () =>
      request({
        fields: {
          Status: 'Prescription Submitted',
          EvidenceUrl: url,
          DecisionToken: 'review-tok',
        },
      });
    let reviewed = false;
    emailService.sendLeaveEvidenceReview = async () => {
      reviewed = true;
    };

    const result = await leaveService.grantFinalApproval(
      request({
        fields: {
          Status: 'Manager Approved',
          EvidenceUrl: url,
          Days: 3,
          LeaveType: 'Sick',
        },
      }),
      'final-approver'
    );

    const update = queries.find((q) => q.sql.includes('UPDATE leave_requests'));
    assert.equal(update.params[0], 'Prescription Submitted');
    assert.equal(typeof update.params[2], 'string');
    assert.equal(reviewed, true);
    assert.equal(result.status, 'Prescription Submitted');
  });

  test('final approval without a file still waits until the employee is back', async () => {
    const queries = [];
    db.withTransaction = async (fn) => {
      const client = {
        async query(sql, params) {
          queries.push({ sql, params });
          if (sql.includes('SELECT status')) return { rows: [{ status: 'Manager Approved' }] };
          return { rows: [] };
        },
      };
      return fn(client);
    };
    LeaveRequest.get = async () =>
      request({ fields: { Status: 'Awaiting Prescription', EvidenceUrl: null } });

    const result = await leaveService.grantFinalApproval(
      request({
        fields: {
          Status: 'Manager Approved',
          EvidenceUrl: null,
          Days: 3,
          LeaveType: 'Sick',
        },
      }),
      'final-approver'
    );

    const update = queries.find((q) => q.sql.includes('UPDATE leave_requests'));
    assert.equal(update.params[0], 'Awaiting Prescription');
    assert.equal(update.params[2], null);
    assert.equal(result.status, 'Awaiting Prescription');
    assert.equal(result.prescriptionStatus, 'not_submitted');
  });

  test('upload is refused until the return day', async () => {
    const today = todayPktDateStr();
    LeaveRequest.get = async () =>
      request({ fields: { ToDate: today, Status: 'Awaiting Prescription' } });

    await assert.rejects(
      () => leaveService.submitEvidence(REQ, EMP, { evidenceUrl: `https://alms.example.com/api/uploads/${UPLOAD}` }),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'NOT_BACK_YET');
        return true;
      }
    );
  });

  test('upload on or after the return day moves the request to review', async () => {
    const today = todayPktDateStr();
    const toDate = addCalendarDays(today, -10);
    let saved = null;
    LeaveRequest.get = async () =>
      request({ fields: { ToDate: toDate, Status: 'Awaiting Prescription' } });
    LeaveRequest.update = async (_id, fields) => {
      saved = fields;
      return request({
        fields: {
          ToDate: toDate,
          Status: fields.Status,
          EvidenceUrl: fields.EvidenceUrl,
          DecisionToken: fields.DecisionToken,
        },
      });
    };

    const result = await leaveService.submitEvidence(REQ, EMP, {
      evidenceUrl: `https://alms.example.com/api/uploads/${UPLOAD}`,
    });
    assert.equal(saved.Status, 'Prescription Submitted');
    assert.ok(String(saved.EvidenceUrl).endsWith(`/api/uploads/${UPLOAD}`));
    assert.equal(result.status, 'Prescription Submitted');
  });

  test('accepting the prescription deducts the sick balance', async () => {
    const queries = [];
    const client = {
      async query(sql, params) {
        queries.push({ sql, params });
        if (sql.includes('SELECT status')) return { rows: [{ status: 'Prescription Submitted' }] };
        if (sql.includes('AS bal')) return { rows: [{ bal: 5 }] };
        return { rows: [] };
      },
    };
    const rec = request({
      fields: { Status: 'Prescription Submitted', Days: 2, LeaveType: 'Sick' },
    });
    await leaveService.deductBalanceAndApprove(client, rec, MGR, {
      expected: 'Prescription Submitted',
    });
    const balance = queries.find((q) => q.sql.includes('UPDATE leave_balances'));
    const approved = queries.find((q) => q.sql.includes("status = $1") && q.sql.includes('leave_requests'));
    assert.ok(balance);
    assert.deepEqual(balance.params, [2, EMP]);
    assert.equal(approved.params[0], 'Approved');
    assert.equal(approved.params[1], MGR);
  });

  test('accepting with too little balance does not approve the request', async () => {
    const queries = [];
    const client = {
      async query(sql) {
        queries.push(sql);
        if (sql.includes('SELECT status')) return { rows: [{ status: 'Prescription Submitted' }] };
        if (sql.includes('AS bal')) return { rows: [{ bal: 1 }] };
        return { rows: [] };
      },
    };
    const rec = request({
      fields: { Status: 'Prescription Submitted', Days: 2, LeaveType: 'Sick' },
    });
    await assert.rejects(
      () =>
        leaveService.deductBalanceAndApprove(client, rec, MGR, {
          expected: 'Prescription Submitted',
        }),
      (err) => {
        assert.equal(err.code, 'INSUFFICIENT_BALANCE');
        return true;
      }
    );
    assert.equal(queries.some((sql) => sql.includes('UPDATE leave_requests')), false);
  });

  test('rejecting on the return day sends the request back for another file', async () => {
    const today = todayPktDateStr();
    let saved = null;
    LeaveRequest.get = async () =>
      request({
        fields: {
          ToDate: addCalendarDays(today, -1),
          Status: 'Prescription Submitted',
          EvidenceUrl: 'https://alms.example.com/api/uploads/' + UPLOAD,
        },
      });
    LeaveRequest.update = async (_id, fields) => {
      saved = fields;
      return request({ fields: { ...fields, ToDate: addCalendarDays(today, -1) } });
    };

    // Leave ended yesterday only if yesterday was a working day and today is the return day.
    // Force the return day to be today by ending the leave on a date whose next working day is today.
    const result = await leaveService.rejectEvidence(REQ, { id: MGR });
    assert.equal(saved.EvidenceUrl, null);
    assert.equal(saved.Status, 'Awaiting Prescription');
    assert.equal(result.status, 'Awaiting Prescription');
  });

  test('rejecting after the return day closes the leave', async () => {
    const today = todayPktDateStr();
    let saved = null;
    LeaveRequest.get = async () =>
      request({
        fields: {
          ToDate: addCalendarDays(today, -14),
          Status: 'Prescription Submitted',
        },
      });
    LeaveRequest.update = async (_id, fields) => {
      saved = fields;
      return request({ fields });
    };

    await leaveService.rejectEvidence(REQ, { id: MGR });
    assert.equal(saved.Status, 'Prescription Missing');
    assert.equal(saved.EvidenceUrl, null);
  });

  test('the end-of-day job closes a file that is still missing', async () => {
    const today = todayPktDateStr();
    const open = request({
      fields: { ToDate: addCalendarDays(today, -14), Status: 'Awaiting Prescription' },
    });
    const waiting = request({
      fields: { ToDate: today, Status: 'Awaiting Prescription' },
    });
    let saved = null;
    LeaveRequest.selectWhere = async () => [open, waiting];
    LeaveRequest.update = async (id, fields) => {
      saved = { id, fields };
      return request({ fields });
    };
    LeaveRequest.get = async () => request({ fields: { Status: 'Prescription Missing' } });

    const result = await leaveService.closeMissingPrescriptions(today);
    assert.equal(result.closed, 1);
    assert.equal(saved.id, REQ);
    assert.equal(saved.fields.Status, 'Prescription Missing');
  });
});
