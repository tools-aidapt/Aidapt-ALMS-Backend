'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { ROLES } = require('../src/middleware/auth');
const { AppError } = require('../src/middleware/errorHandler');
const leaveService = require('../src/services/leaveService');
const leaveCtrl = require('../src/controllers/leaveController');
const LeaveRequest = require('../src/models/LeaveRequest');
const Employee = require('../src/models/Employee');

const EMP = '11111111-1111-1111-1111-111111111111';
const MGR = '22222222-2222-2222-2222-222222222222';
const REP = '33333333-3333-3333-3333-333333333333';
const OTHER = '44444444-4444-4444-4444-444444444444';
const HR = '55555555-5555-5555-5555-555555555555';

function employee(id, managerIds = []) {
  return { id, fields: { Manager: managerIds, Name: id } };
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

describe('GET /api/leave/requests list scoping', () => {
  let origList;
  let lastFilters;

  beforeEach(() => {
    origList = leaveService.list;
    lastFilters = null;
    leaveService.list = async (filters) => {
      lastFilters = filters;
      return [
        {
          id: 'l1',
          employee: [filters.employeeId],
          employeeId: filters.employeeId,
          status: filters.status || 'Pending',
        },
      ];
    };
  });

  afterEach(() => {
    leaveService.list = origList;
  });

  test('Employee no employeeId → own rows only', async () => {
    const res = await invoke(leaveCtrl.list, {
      user: { id: EMP, role: ROLES.EMPLOYEE },
      query: {},
    });
    assert.equal(lastFilters.employeeId, EMP);
    assert.deepEqual([...new Set(res.body.data.map((r) => r.employeeId))], [EMP]);
  });

  test('Manager no employeeId → own rows only (not company-wide)', async () => {
    const res = await invoke(leaveCtrl.list, {
      user: { id: MGR, role: ROLES.MANAGER },
      query: { status: 'Pending' },
    });
    assert.equal(lastFilters.employeeId, MGR);
    assert.equal(lastFilters.status, 'Pending');
  });

  test('Manager requesting non-report → 403', async () => {
    const origGet = Employee.get;
    Employee.get = async () => employee(OTHER, [HR]);
    try {
      await expectStatus(
        () =>
          invoke(leaveCtrl.list, {
            user: { id: MGR, role: ROLES.MANAGER },
            query: { employeeId: OTHER },
          }),
        403
      );
    } finally {
      Employee.get = origGet;
    }
  });

  test('Manager requesting direct report → that id only', async () => {
    const origGet = Employee.get;
    Employee.get = async (id) => (id === REP ? employee(REP, [MGR]) : null);
    try {
      const res = await invoke(leaveCtrl.list, {
        user: { id: MGR, role: ROLES.MANAGER },
        query: { employeeId: REP },
      });
      assert.equal(lastFilters.employeeId, REP);
    } finally {
      Employee.get = origGet;
    }
  });
});

describe('GET /api/leave/pending-for-approver', () => {
  let origList;
  let lastFilters;

  beforeEach(() => {
    origList = leaveService.list;
    lastFilters = null;
    leaveService.list = async (filters) => {
      lastFilters = filters;
      const rows = [
        {
          id: 'l-rep',
          employee: [REP],
          employeeId: REP,
          employeeName: 'Report',
          employeePhotoUrl: null,
          status: 'Pending',
          manager: [MGR],
        },
        {
          id: 'l-other',
          employee: [OTHER],
          employeeId: OTHER,
          status: 'Pending',
          manager: [HR],
        },
        {
          id: 'l-self',
          employee: [filters.excludeEmployeeId],
          employeeId: filters.excludeEmployeeId,
          status: 'Pending',
          manager: [MGR],
        },
      ];
      return rows.filter((r) => {
        if (filters.status && r.status !== filters.status) return false;
        if (filters.excludeEmployeeId && r.employeeId === filters.excludeEmployeeId) return false;
        if (filters.managerId && !(r.manager || []).includes(filters.managerId)) return false;
        return true;
      });
    };
  });

  afterEach(() => {
    leaveService.list = origList;
  });

  test('Employee gets 403', async () => {
    leaveService.list = origList;
    await expectStatus(
      () =>
        invoke(leaveCtrl.listPendingForApprover, {
          user: { id: EMP, role: ROLES.EMPLOYEE },
        }),
      403
    );
  });

  test('Manager sees only reports’ pending and never self', async () => {
    const res = await invoke(leaveCtrl.listPendingForApprover, {
      user: { id: MGR, role: ROLES.MANAGER },
    });
    assert.equal(lastFilters.status, 'Pending');
    assert.equal(lastFilters.managerId, MGR);
    assert.equal(lastFilters.excludeEmployeeId, MGR);
    for (const row of res.body.data) {
      assert.notEqual(row.employeeId, MGR);
      assert.ok((row.manager || []).includes(MGR));
    }
  });

  test('HR Admin sees all pending except their own', async () => {
    const res = await invoke(leaveCtrl.listPendingForApprover, {
      user: { id: HR, role: ROLES.HR_ADMIN },
    });
    assert.equal(lastFilters.managerId, undefined);
    assert.equal(lastFilters.excludeEmployeeId, HR);
    for (const row of res.body.data) {
      assert.notEqual(row.employeeId, HR);
    }
  });
});

describe('PATCH leave approve/reject authz', () => {
  let origGet;

  beforeEach(() => {
    origGet = LeaveRequest.get;
  });

  afterEach(() => {
    LeaveRequest.get = origGet;
  });

  test('Manager cannot decide a non-report request — 403', async () => {
    LeaveRequest.get = async () => ({
      id: 'x',
      fields: {
        Employee: [OTHER],
        Manager: [HR],
        Status: 'Pending',
      },
    });
    await expectStatus(
      () => leaveService.decideInApp('x', 'approve', { id: MGR, role: ROLES.MANAGER }),
      403
    );
  });

  test('Caller cannot decide their own leave request', async () => {
    LeaveRequest.get = async () => ({
      id: 'x',
      fields: {
        Employee: [HR],
        Manager: [MGR],
        Status: 'Pending',
      },
    });
    await expectStatus(
      () => leaveService.decideInApp('x', 'reject', { id: HR, role: ROLES.HR_ADMIN }),
      403
    );
  });
});

describe('leave serialize employeeId', () => {
  test('includes scalar employeeId', () => {
    const row = leaveService.serialize({
      id: 'l1',
      fields: {
        Employee: [EMP],
        LeaveType: 'Annual',
        Status: 'Pending',
      },
    });
    assert.equal(row.employeeId, EMP);
    assert.deepEqual(row.employee, [EMP]);
  });
});
