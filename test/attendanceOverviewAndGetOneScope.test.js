'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { ROLES } = require('../src/middleware/auth');
const { AppError } = require('../src/middleware/errorHandler');
const attendanceService = require('../src/services/attendanceService');
const attendanceCtrl = require('../src/controllers/attendanceController');

const EMP = '11111111-1111-1111-1111-111111111111';
const MGR = '22222222-2222-2222-2222-222222222222';
const REP = '33333333-3333-3333-3333-333333333333';
const OTHER = '44444444-4444-4444-4444-444444444444';
const HR = '55555555-5555-5555-5555-555555555555';

function employee(id, managerIds = []) {
  return { id, fields: { Manager: managerIds, Name: id } };
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

describe('GET /api/attendance/overview scoping', () => {
  let origOverview;
  let lastArgs;

  beforeEach(() => {
    origOverview = attendanceService.overview;
    lastArgs = null;
    attendanceService.overview = async (args) => {
      lastArgs = args;
      return {
        employeeId: args.employeeId,
        days: [{ date: '2026-07-01', status: 'Present' }],
      };
    };
  });

  afterEach(() => {
    attendanceService.overview = origOverview;
  });

  test('Employee, no employeeId → own overview only', async () => {
    const res = await invoke(attendanceCtrl.overview, {
      user: { id: EMP, role: ROLES.EMPLOYEE },
      query: { from: '2026-07-01', to: '2026-07-31' },
    });
    assert.equal(lastArgs.employeeId, EMP);
    assert.equal(res.body.data.employeeId, EMP);
  });

  test('Employee requesting colleague → 403', async () => {
    await expectStatus(
      () =>
        invoke(attendanceCtrl.overview, {
          user: { id: EMP, role: ROLES.EMPLOYEE },
          query: { employeeId: OTHER },
        }),
      403
    );
  });

  test('Manager, no employeeId → own overview (not team)', async () => {
    const res = await invoke(attendanceCtrl.overview, {
      user: { id: MGR, role: ROLES.MANAGER },
      query: {},
    });
    assert.equal(lastArgs.employeeId, MGR);
  });

  test('Manager requesting direct report → that report', async () => {
    const Employee = require('../src/models/Employee');
    const origGet = Employee.get;
    Employee.get = async (id) => (id === REP ? employee(REP, [MGR]) : null);
    try {
      const res = await invoke(attendanceCtrl.overview, {
        user: { id: MGR, role: ROLES.MANAGER },
        query: { employeeId: REP },
      });
      assert.equal(lastArgs.employeeId, REP);
      assert.equal(res.body.data.employeeId, REP);
    } finally {
      Employee.get = origGet;
    }
  });

  test('Manager requesting non-report → 403', async () => {
    const Employee = require('../src/models/Employee');
    const origGet = Employee.get;
    Employee.get = async () => employee(OTHER, [HR]);
    try {
      await expectStatus(
        () =>
          invoke(attendanceCtrl.overview, {
            user: { id: MGR, role: ROLES.MANAGER },
            query: { employeeId: OTHER },
          }),
        403
      );
    } finally {
      Employee.get = origGet;
    }
  });

  test('HR Admin may request any employee', async () => {
    const Employee = require('../src/models/Employee');
    const origGet = Employee.get;
    Employee.get = async () => employee(OTHER);
    try {
      const res = await invoke(attendanceCtrl.overview, {
        user: { id: HR, role: ROLES.HR_ADMIN },
        query: { employeeId: OTHER },
      });
      assert.equal(lastArgs.employeeId, OTHER);
    } finally {
      Employee.get = origGet;
    }
  });
});

describe('GET /api/attendance/:id relationship check', () => {
  let origGetById;

  beforeEach(() => {
    origGetById = attendanceService.getById;
  });

  afterEach(() => {
    attendanceService.getById = origGetById;
  });

  test('Employee may read own punch', async () => {
    attendanceService.getById = async () => ({
      id: 'punch-1',
      employee: [EMP],
      employeeId: EMP,
      date: '2026-07-15',
    });
    const res = await invoke(attendanceCtrl.getOne, {
      user: { id: EMP, role: ROLES.EMPLOYEE },
      params: { id: 'punch-1' },
    });
    assert.equal(res.body.data.employeeId, EMP);
  });

  test('Employee reading another employee punch → 403', async () => {
    attendanceService.getById = async () => ({
      id: 'punch-2',
      employee: [OTHER],
      employeeId: OTHER,
    });
    await expectStatus(
      () =>
        invoke(attendanceCtrl.getOne, {
          user: { id: EMP, role: ROLES.EMPLOYEE },
          params: { id: 'punch-2' },
        }),
      403
    );
  });

  test('Manager may read direct report punch', async () => {
    const Employee = require('../src/models/Employee');
    const origGet = Employee.get;
    Employee.get = async (id) => (id === REP ? employee(REP, [MGR]) : null);
    attendanceService.getById = async () => ({
      id: 'punch-3',
      employee: [REP],
      employeeId: REP,
    });
    try {
      const res = await invoke(attendanceCtrl.getOne, {
        user: { id: MGR, role: ROLES.MANAGER },
        params: { id: 'punch-3' },
      });
      assert.equal(res.body.data.employeeId, REP);
    } finally {
      Employee.get = origGet;
    }
  });

  test('Manager reading non-report punch → 403', async () => {
    const Employee = require('../src/models/Employee');
    const origGet = Employee.get;
    Employee.get = async () => employee(OTHER, [HR]);
    attendanceService.getById = async () => ({
      id: 'punch-4',
      employee: [OTHER],
      employeeId: OTHER,
    });
    try {
      await expectStatus(
        () =>
          invoke(attendanceCtrl.getOne, {
            user: { id: MGR, role: ROLES.MANAGER },
            params: { id: 'punch-4' },
          }),
        403
      );
    } finally {
      Employee.get = origGet;
    }
  });

  test('HR Admin may read any punch', async () => {
    const Employee = require('../src/models/Employee');
    const origGet = Employee.get;
    Employee.get = async () => employee(OTHER);
    attendanceService.getById = async () => ({
      id: 'punch-5',
      employee: [OTHER],
      employeeId: OTHER,
    });
    try {
      const res = await invoke(attendanceCtrl.getOne, {
        user: { id: HR, role: ROLES.HR_ADMIN },
        params: { id: 'punch-5' },
      });
      assert.equal(res.body.data.employeeId, OTHER);
    } finally {
      Employee.get = origGet;
    }
  });
});
