'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { ROLES } = require('../src/middleware/auth');
const { AppError } = require('../src/middleware/errorHandler');
const reportService = require('../src/services/reportService');
const attendanceCtrl = require('../src/controllers/attendanceController');

const EMP = '11111111-1111-1111-1111-111111111111';
const MGR = '22222222-2222-2222-2222-222222222222';
const HR = '55555555-5555-5555-5555-555555555555';
const LEAD = '66666666-6666-6666-6666-666666666666';

async function expectStatus(fn, status) {
  try {
    await fn();
    assert.fail(`expected AppError ${status}`);
  } catch (err) {
    assert.ok(err instanceof AppError, `expected AppError, got ${err && err.message}`);
    assert.equal(err.status, status);
  }
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  return res;
}

async function invoke(handler, req) {
  const res = mockRes();
  await new Promise((resolve, reject) => {
    const p = handler(req, res, (err) => (err ? reject(err) : resolve()));
    Promise.resolve(p)
      .then(() => resolve())
      .catch(reject);
  });
  return res;
}

describe('GET /api/attendance/month-end-report scoping', () => {
  let origGet;
  let lastArgs;

  beforeEach(() => {
    origGet = reportService.getMonthEndReports;
    lastArgs = null;
    reportService.getMonthEndReports = async (args) => {
      lastArgs = args;
      return {
        period: { month: '2026-08', from: args.from, to: args.to },
        reports: [{ employeeId: (args.employeeIds && args.employeeIds[0]) || 'all' }],
      };
    };
  });

  afterEach(() => {
    reportService.getMonthEndReports = origGet;
  });

  test('Employee, omitted scope → own report', async () => {
    const res = await invoke(attendanceCtrl.monthEndReport, {
      user: { id: EMP, role: ROLES.EMPLOYEE },
      query: { month: '2026-08' },
    });
    assert.deepEqual(lastArgs.employeeIds, [EMP]);
    assert.equal(lastArgs.from, '2026-08-01');
    assert.equal(lastArgs.to, '2026-08-31');
    assert.equal(res.body.data.scope, 'self');
    assert.equal(res.body.data.period.month, '2026-08');
  });

  test('Employee, scope=all → 403', async () => {
    await expectStatus(
      () =>
        invoke(attendanceCtrl.monthEndReport, {
          user: { id: EMP, role: ROLES.EMPLOYEE },
          query: { scope: 'all', month: '2026-08' },
        }),
      403
    );
    assert.equal(lastArgs, null);
  });

  test('Manager, scope=all → 403', async () => {
    await expectStatus(
      () =>
        invoke(attendanceCtrl.monthEndReport, {
          user: { id: MGR, role: ROLES.MANAGER },
          query: { scope: 'all' },
        }),
      403
    );
    assert.equal(lastArgs, null);
  });

  test('HR Admin, omitted scope → own report', async () => {
    const res = await invoke(attendanceCtrl.monthEndReport, {
      user: { id: HR, role: ROLES.HR_ADMIN },
      query: { month: '2026-08' },
    });
    assert.deepEqual(lastArgs.employeeIds, [HR]);
    assert.equal(res.body.data.scope, 'self');
  });

  test('HR Admin, scope=all → all employees', async () => {
    const res = await invoke(attendanceCtrl.monthEndReport, {
      user: { id: HR, role: ROLES.HR_ADMIN },
      query: { scope: 'all', month: '2026-08' },
    });
    assert.equal(lastArgs.employeeIds, null);
    assert.equal(res.body.data.scope, 'all');
  });

  test('Leadership, scope=all → all employees', async () => {
    const res = await invoke(attendanceCtrl.monthEndReport, {
      user: { id: LEAD, role: ROLES.EMPLOYEE, isLeadership: true },
      query: { scope: 'all', month: '2026-08' },
    });
    assert.equal(lastArgs.employeeIds, null);
    assert.equal(res.body.data.scope, 'all');
  });
});
