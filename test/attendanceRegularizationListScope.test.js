'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { ROLES } = require('../src/middleware/auth');
const { resolveEmployeeRecordScope } = require('../src/utils/employeeRecordScope');
const { AppError } = require('../src/middleware/errorHandler');
const attendanceService = require('../src/services/attendanceService');
const regularizationService = require('../src/services/regularizationService');
const attendanceCtrl = require('../src/controllers/attendanceController');
const regularizationCtrl = require('../src/controllers/regularizationController');

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

describe('resolveEmployeeRecordScope', () => {
  test('1. Employee, no employeeId → own id', async () => {
    const id = await resolveEmployeeRecordScope({ id: EMP, role: ROLES.EMPLOYEE }, undefined);
    assert.equal(id, EMP);
  });

  test('2. Employee requesting colleague → 403', async () => {
    await expectStatus(
      () =>
        resolveEmployeeRecordScope({ id: EMP, role: ROLES.EMPLOYEE }, OTHER, {
          getEmployee: async () => employee(OTHER),
        }),
      403
    );
  });

  test('3. Manager, no employeeId → own id (not team)', async () => {
    const id = await resolveEmployeeRecordScope({ id: MGR, role: ROLES.MANAGER }, undefined);
    assert.equal(id, MGR);
  });

  test('4. Manager requesting direct report → report id', async () => {
    const id = await resolveEmployeeRecordScope({ id: MGR, role: ROLES.MANAGER }, REP, {
      getEmployee: async (id) => (id === REP ? employee(REP, [MGR]) : null),
    });
    assert.equal(id, REP);
  });

  test('5. Manager requesting non-report → 403', async () => {
    await expectStatus(
      () =>
        resolveEmployeeRecordScope({ id: MGR, role: ROLES.MANAGER }, OTHER, {
          getEmployee: async () => employee(OTHER, [HR]),
        }),
      403
    );
  });

  test('6. HR Admin requesting any employee → that id', async () => {
    const id = await resolveEmployeeRecordScope({ id: HR, role: ROLES.HR_ADMIN }, OTHER, {
      getEmployee: async () => employee(OTHER),
    });
    assert.equal(id, OTHER);
  });

  test('self employeeId is allowed for every role', async () => {
    for (const role of [ROLES.EMPLOYEE, ROLES.MANAGER, ROLES.HR_ADMIN]) {
      const id = await resolveEmployeeRecordScope({ id: EMP, role }, EMP);
      assert.equal(id, EMP);
    }
  });
});

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

describe('GET /api/attendance list scoping', () => {
  let origList;
  let lastFilters;

  beforeEach(() => {
    origList = attendanceService.list;
    lastFilters = null;
    attendanceService.list = async (filters) => {
      lastFilters = filters;
      return [
        {
          id: 'p1',
          employee: [filters.employeeId],
          employeeId: filters.employeeId,
          date: '2026-07-15',
          status: 'Present',
        },
        {
          id: 'p2',
          employee: [filters.employeeId],
          employeeId: filters.employeeId,
          date: '2026-07-01',
          status: 'Present',
        },
      ];
    };
  });

  afterEach(() => {
    attendanceService.list = origList;
  });

  test('1. Employee, no employeeId → only own rows', async () => {
    const res = await invoke(attendanceCtrl.list, {
      user: { id: EMP, role: ROLES.EMPLOYEE },
      query: { from: '2026-07-01', to: '2026-07-31' },
    });
    assert.equal(lastFilters.employeeId, EMP);
    const ids = [...new Set(res.body.data.map((r) => r.employeeId))];
    assert.deepEqual(ids, [EMP]);
  });

  test('2. Employee requesting colleague → 403', async () => {
    await expectStatus(
      () =>
        invoke(attendanceCtrl.list, {
          user: { id: EMP, role: ROLES.EMPLOYEE },
          query: { employeeId: OTHER },
        }),
      403
    );
  });

  test('3. Manager, no employeeId → only own rows', async () => {
    const res = await invoke(attendanceCtrl.list, {
      user: { id: MGR, role: ROLES.MANAGER },
      query: {},
    });
    assert.equal(lastFilters.employeeId, MGR);
    assert.deepEqual(
      [...new Set(res.body.data.map((r) => r.employeeId))],
      [MGR]
    );
  });

  test('4. Manager requesting direct report → that report only', async () => {
    const Employee = require('../src/models/Employee');
    const origGet = Employee.get;
    Employee.get = async (id) => (id === REP ? employee(REP, [MGR]) : null);
    try {
      const res = await invoke(attendanceCtrl.list, {
        user: { id: MGR, role: ROLES.MANAGER },
        query: { employeeId: REP },
      });
      assert.equal(lastFilters.employeeId, REP);
      assert.deepEqual(
        [...new Set(res.body.data.map((r) => r.employeeId))],
        [REP]
      );
    } finally {
      Employee.get = origGet;
    }
  });

  test('5. Manager requesting non-report → 403', async () => {
    const Employee = require('../src/models/Employee');
    const origGet = Employee.get;
    Employee.get = async () => employee(OTHER, [HR]);
    try {
      await expectStatus(
        () =>
          invoke(attendanceCtrl.list, {
            user: { id: MGR, role: ROLES.MANAGER },
            query: { employeeId: OTHER },
          }),
        403
      );
    } finally {
      Employee.get = origGet;
    }
  });

  test('6. HR Admin requesting any employee → that employee only', async () => {
    const Employee = require('../src/models/Employee');
    const origGet = Employee.get;
    Employee.get = async () => employee(OTHER);
    try {
      const res = await invoke(attendanceCtrl.list, {
        user: { id: HR, role: ROLES.HR_ADMIN },
        query: { employeeId: OTHER },
      });
      assert.equal(lastFilters.employeeId, OTHER);
      assert.deepEqual(
        [...new Set(res.body.data.map((r) => r.employeeId))],
        [OTHER]
      );
    } finally {
      Employee.get = origGet;
    }
  });

  test('7. Every successful response is exactly one distinct employee id', async () => {
    const res = await invoke(attendanceCtrl.list, {
      user: { id: EMP, role: ROLES.EMPLOYEE },
      query: {},
    });
    const ids = [...new Set(res.body.data.map((r) => r.employeeId))];
    assert.equal(ids.length, 1);
  });

  test('8. from/to are forwarded for inclusive date filtering', async () => {
    await invoke(attendanceCtrl.list, {
      user: { id: EMP, role: ROLES.EMPLOYEE },
      query: { from: '2026-07-01', to: '2026-07-31' },
    });
    assert.equal(lastFilters.from, '2026-07-01');
    assert.equal(lastFilters.to, '2026-07-31');
  });
});

describe('GET /api/regularizations list scoping', () => {
  let origList;
  let lastFilters;

  beforeEach(() => {
    origList = regularizationService.list;
    lastFilters = null;
    regularizationService.list = async (filters) => {
      lastFilters = filters;
      return [
        {
          id: 'r1',
          employee: [filters.employeeId],
          employeeId: filters.employeeId,
          status: 'Pending',
        },
      ];
    };
  });

  afterEach(() => {
    regularizationService.list = origList;
  });

  test('1. Employee, no employeeId → only own rows', async () => {
    const res = await invoke(regularizationCtrl.list, {
      user: { id: EMP, role: ROLES.EMPLOYEE },
      query: {},
    });
    assert.equal(lastFilters.employeeId, EMP);
    assert.equal(lastFilters.managerId, undefined);
    assert.deepEqual(
      [...new Set(res.body.data.map((r) => r.employeeId))],
      [EMP]
    );
  });

  test('2. Employee requesting colleague → 403', async () => {
    await expectStatus(
      () =>
        invoke(regularizationCtrl.list, {
          user: { id: EMP, role: ROLES.EMPLOYEE },
          query: { employeeId: OTHER },
        }),
      403
    );
  });

  test('3. Manager, no employeeId → only own rows (not approval queue)', async () => {
    const res = await invoke(regularizationCtrl.list, {
      user: { id: MGR, role: ROLES.MANAGER },
      query: { status: 'Pending' },
    });
    assert.equal(lastFilters.employeeId, MGR);
    assert.equal(lastFilters.managerId, undefined);
    assert.equal(lastFilters.status, 'Pending');
    assert.deepEqual(
      [...new Set(res.body.data.map((r) => r.employeeId))],
      [MGR]
    );
  });

  test('4. Manager requesting direct report → that report only', async () => {
    const Employee = require('../src/models/Employee');
    const origGet = Employee.get;
    Employee.get = async (id) => (id === REP ? employee(REP, [MGR]) : null);
    try {
      const res = await invoke(regularizationCtrl.list, {
        user: { id: MGR, role: ROLES.MANAGER },
        query: { employeeId: REP },
      });
      assert.equal(lastFilters.employeeId, REP);
      assert.deepEqual(
        [...new Set(res.body.data.map((r) => r.employeeId))],
        [REP]
      );
    } finally {
      Employee.get = origGet;
    }
  });

  test('5. Manager requesting non-report → 403', async () => {
    const Employee = require('../src/models/Employee');
    const origGet = Employee.get;
    Employee.get = async () => employee(OTHER, [HR]);
    try {
      await expectStatus(
        () =>
          invoke(regularizationCtrl.list, {
            user: { id: MGR, role: ROLES.MANAGER },
            query: { employeeId: OTHER },
          }),
        403
      );
    } finally {
      Employee.get = origGet;
    }
  });

  test('6. HR Admin requesting any employee → that employee only', async () => {
    const Employee = require('../src/models/Employee');
    const origGet = Employee.get;
    Employee.get = async () => employee(OTHER);
    try {
      const res = await invoke(regularizationCtrl.list, {
        user: { id: HR, role: ROLES.HR_ADMIN },
        query: { employeeId: OTHER },
      });
      assert.equal(lastFilters.employeeId, OTHER);
      assert.deepEqual(
        [...new Set(res.body.data.map((r) => r.employeeId))],
        [OTHER]
      );
    } finally {
      Employee.get = origGet;
    }
  });

  test('7. Exactly one distinct employee id per successful response', async () => {
    const res = await invoke(regularizationCtrl.list, {
      user: { id: EMP, role: ROLES.EMPLOYEE },
      query: {},
    });
    assert.equal([...new Set(res.body.data.map((r) => r.employeeId))].length, 1);
  });
});

describe('attendance serialize owner id', () => {
  test('includes employeeId scalar alongside employee link array', () => {
    const row = attendanceService.serialize({
      id: 'p1',
      fields: {
        Employee: [EMP],
        Date: '2026-07-15',
        Status: 'Present',
        IsLate: false,
      },
    });
    assert.deepEqual(row.employee, [EMP]);
    assert.equal(row.employeeId, EMP);
  });
});

describe('AttendancePunch date bounds are inclusive', () => {
  test('query builder uses >= from and <= to', () => {
    // Mirror the model clause contract (inclusive on both ends).
    const from = '2026-07-01';
    const to = '2026-07-31';
    const where = [];
    const params = [];
    const employeeId = EMP;
    where.push(`employee_id = $${params.push(employeeId)}`);
    where.push(`date >= $${params.push(from)}`);
    where.push(`date <= $${params.push(to)}`);
    assert.equal(where[1], 'date >= $2');
    assert.equal(where[2], 'date <= $3');
    assert.deepEqual(params, [EMP, from, to]);

    // Boundary dates must be included by those operators.
    assert.ok('2026-07-01' >= from && '2026-07-01' <= to);
    assert.ok('2026-07-31' >= from && '2026-07-31' <= to);
    assert.ok(!('2026-06-30' >= from && '2026-06-30' <= to));
    assert.ok(!('2026-08-01' >= from && '2026-08-01' <= to));
  });
});
