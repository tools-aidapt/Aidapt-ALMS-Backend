'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { ROLES } = require('../src/middleware/auth');
const { AppError } = require('../src/middleware/errorHandler');
const regularizationService = require('../src/services/regularizationService');
const regularizationCtrl = require('../src/controllers/regularizationController');
const RegularizationRequest = require('../src/models/RegularizationRequest');

const EMP = '11111111-1111-1111-1111-111111111111';
const MGR = '22222222-2222-2222-2222-222222222222';
const REP = '33333333-3333-3333-3333-333333333333';
const OTHER = '44444444-4444-4444-4444-444444444444';
const HR = '55555555-5555-5555-5555-555555555555';

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
    Promise.resolve(p).then(() => resolve()).catch(reject);
  });
  return res;
}

async function expectStatus(fn, status) {
  try {
    await fn();
    assert.fail(`expected AppError ${status}`);
  } catch (err) {
    assert.ok(err instanceof AppError, `expected AppError, got ${err && err.message}`);
    assert.equal(err.status, status);
  }
}

describe('GET /api/regularizations/pending-for-approver', () => {
  let origList;
  let lastFilters;

  beforeEach(() => {
    origList = regularizationService.list;
    lastFilters = null;
    regularizationService.list = async (filters) => {
      lastFilters = filters;
      const rows = [
        {
          id: 'r-rep',
          employee: [REP],
          employeeId: REP,
          employeeName: 'Report',
          employeePhotoUrl: null,
          status: 'Pending',
          manager: [MGR],
        },
        {
          id: 'r-other',
          employee: [OTHER],
          employeeId: OTHER,
          employeeName: 'Other',
          employeePhotoUrl: null,
          status: 'Pending',
          manager: [HR],
        },
        {
          id: 'r-self',
          employee: [filters.excludeEmployeeId || MGR],
          employeeId: filters.excludeEmployeeId || MGR,
          status: 'Pending',
          manager: [HR],
        },
      ];
      // Service layer would apply filters; mirror them for the controller path
      // that delegates to listPendingForApprover → list.
      return rows.filter((r) => {
        if (filters.status && r.status !== filters.status) return false;
        if (filters.excludeEmployeeId && r.employeeId === filters.excludeEmployeeId) return false;
        if (filters.managerId && !(r.manager || []).includes(filters.managerId)) return false;
        return true;
      });
    };
  });

  afterEach(() => {
    regularizationService.list = origList;
  });

  test('Employee gets 403', async () => {
    // Restore real listPendingForApprover path (uses real service method).
    regularizationService.list = origList;
    await expectStatus(
      () =>
        invoke(regularizationCtrl.listPendingForApprover, {
          user: { id: EMP, role: ROLES.EMPLOYEE },
        }),
      403
    );
  });

  test('Manager sees only reports’ pending rows (managerId filter) and never self', async () => {
    // Use real listPendingForApprover; mock list only.
    const res = await invoke(regularizationCtrl.listPendingForApprover, {
      user: { id: MGR, role: ROLES.MANAGER },
    });
    assert.equal(lastFilters.status, 'Pending');
    assert.equal(lastFilters.managerId, MGR);
    assert.equal(lastFilters.excludeEmployeeId, MGR);
    assert.equal(lastFilters.employeeId, undefined);
    for (const row of res.body.data) {
      assert.notEqual(row.employeeId, MGR);
      assert.ok((row.manager || []).includes(MGR));
    }
  });

  test('HR Admin sees all pending except their own', async () => {
    const res = await invoke(regularizationCtrl.listPendingForApprover, {
      user: { id: HR, role: ROLES.HR_ADMIN },
    });
    assert.equal(lastFilters.status, 'Pending');
    assert.equal(lastFilters.managerId, undefined);
    assert.equal(lastFilters.excludeEmployeeId, HR);
    for (const row of res.body.data) {
      assert.notEqual(row.employeeId, HR);
    }
  });
});

describe('PATCH /api/regularizations/:id/approve authz', () => {
  let origGet;
  let origUpdate;
  let decideCalls;

  beforeEach(() => {
    origGet = RegularizationRequest.get;
    origUpdate = RegularizationRequest.update;
    decideCalls = [];
  });

  afterEach(() => {
    RegularizationRequest.get = origGet;
    RegularizationRequest.update = origUpdate;
  });

  function pendingReq({ employeeId, managerId }) {
    return {
      id: 'req-1',
      fields: {
        Employee: [employeeId],
        Manager: managerId ? [managerId] : [],
        Status: 'Pending',
        Date: '2026-07-01',
      },
    };
  }

  test('Manager cannot decide a non-report (not assigned) request — 403', async () => {
    RegularizationRequest.get = async () => pendingReq({ employeeId: OTHER, managerId: HR });
    await expectStatus(
      () => regularizationService.decideInApp('req-1', 'approve', { id: MGR, role: ROLES.MANAGER }),
      403
    );
  });

  test('Employee/self cannot approve own request even as HR Admin', async () => {
    RegularizationRequest.get = async () => pendingReq({ employeeId: HR, managerId: MGR });
    await expectStatus(
      () => regularizationService.decideInApp('req-1', 'reject', { id: HR, role: ROLES.HR_ADMIN }),
      403
    );
  });

  test('Assigned manager may reject a report request', async () => {
    const rec = pendingReq({ employeeId: REP, managerId: MGR });
    let state = rec;
    RegularizationRequest.get = async () => state;
    RegularizationRequest.update = async (id, fields) => {
      state = {
        id,
        fields: {
          ...state.fields,
          Status: fields.Status,
          DecidedAt: fields.DecidedAt,
        },
      };
      return state;
    };
    const Employee = require('../src/models/Employee');
    const origSelect = Employee.selectWhere;
    Employee.selectWhere = async () => [
      { id: REP, fields: { Name: 'Report', PhotoUrl: null } },
      { id: MGR, fields: { Name: 'Mgr', PhotoUrl: null } },
    ];
    try {
      const result = await regularizationService.decideInApp('req-1', 'reject', {
        id: MGR,
        role: ROLES.MANAGER,
      });
      assert.equal(result.punch, null);
      assert.equal(result.request.status, 'Rejected');
    } finally {
      Employee.selectWhere = origSelect;
    }
  });
});
