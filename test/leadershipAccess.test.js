'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { ROLES } = require('../src/middleware/auth');
const {
  hasCompanyWideDataAccess,
  isLeadershipMember,
  LEADERSHIP_TEAM_NAME,
} = require('../src/utils/leadershipAccess');
const { resolveEmployeeRecordScope } = require('../src/utils/employeeRecordScope');
const { AppError } = require('../src/middleware/errorHandler');
const employeeCtrl = require('../src/controllers/employeeController');

const EMP = '11111111-1111-1111-1111-111111111111';
const CEO = '66666666-6666-6666-6666-666666666666';
const OTHER = '44444444-4444-4444-4444-444444444444';
const HR = '55555555-5555-5555-5555-555555555555';

function employee(id, managerIds = []) {
  return {
    id,
    fields: {
      Manager: managerIds,
      Name: id,
      Email: `${id}@x.test`,
      Role: 'Employee',
      Status: 'Active',
      EmploymentStatus: 'Full-time',
      PhotoUrl: null,
      AssignedShift: [],
      Team: [],
      DateOfJoining: null,
      GraceMinutes: null,
      MonthlySalary: 100,
      DateOfBirth: '1990-01-01',
      MedicalNotes: 'secret',
      CnicFrontUrl: 'http://x/cnic',
      BankName: 'Bank',
    },
  };
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

describe('hasCompanyWideDataAccess', () => {
  test('HR Admin always', () => {
    assert.equal(hasCompanyWideDataAccess({ role: ROLES.HR_ADMIN }), true);
  });
  test('Leadership flag', () => {
    assert.equal(
      hasCompanyWideDataAccess({ role: ROLES.EMPLOYEE, isLeadership: true }),
      true
    );
  });
  test('plain manager no', () => {
    assert.equal(hasCompanyWideDataAccess({ role: ROLES.MANAGER }), false);
  });
});

describe('isLeadershipMember SQL predicate', () => {
  test('returns true when query matches', async () => {
    const ok = await isLeadershipMember(CEO, {
      queryFn: async () => ({ rows: [{ '?column?': 1 }] }),
    });
    assert.equal(ok, true);
  });
  test('returns false when empty', async () => {
    const ok = await isLeadershipMember(EMP, { queryFn: async () => ({ rows: [] }) });
    assert.equal(ok, false);
  });
  test('team name constant', () => {
    assert.equal(LEADERSHIP_TEAM_NAME, 'Leadership');
  });
});

describe('resolveEmployeeRecordScope — Leadership', () => {
  test('Leadership may read any employee attendance scope', async () => {
    const id = await resolveEmployeeRecordScope(
      { id: CEO, role: ROLES.EMPLOYEE, isLeadership: true },
      OTHER,
      { getEmployee: async () => employee(OTHER) }
    );
    assert.equal(id, OTHER);
  });
});

describe('employee serialize — Leadership private fields', () => {
  test('Leadership sees medicalNotes and bank fields', () => {
    const rec = employee(OTHER);
    const out = employeeCtrl.serialize(rec, {
      id: CEO,
      role: ROLES.EMPLOYEE,
      isLeadership: true,
    });
    assert.equal(out.medicalNotes, 'secret');
    assert.equal(out.monthlySalary, 100);
    assert.equal(out.bankName, 'Bank');
    assert.equal(out.dateOfBirth, '1990-01-01');
  });

  test('plain Manager does not', () => {
    const rec = employee(OTHER, [EMP]);
    const out = employeeCtrl.serialize(rec, { id: EMP, role: ROLES.MANAGER });
    assert.equal(out.medicalNotes, undefined);
    assert.equal(out.monthlySalary, undefined);
  });
});

describe('employee getOne / list Leadership', () => {
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

  test('Leadership can open any employee profile with private fields', async () => {
    const Employee = require('../src/models/Employee');
    const orig = Employee.get;
    Employee.get = async () => employee(OTHER);
    try {
      const res = await invoke(employeeCtrl.getOne, {
        user: { id: CEO, role: ROLES.EMPLOYEE, isLeadership: true },
        params: { id: OTHER },
      });
      assert.equal(res.body.data.id, OTHER);
      assert.equal(res.body.data.medicalNotes, 'secret');
    } finally {
      Employee.get = orig;
    }
  });

  test('plain Employee cannot open colleague', async () => {
    const Employee = require('../src/models/Employee');
    const orig = Employee.get;
    Employee.get = async () => employee(OTHER);
    try {
      await expectStatus(
        () =>
          invoke(employeeCtrl.getOne, {
            user: { id: EMP, role: ROLES.EMPLOYEE, isLeadership: false },
            params: { id: OTHER },
          }),
        403
      );
    } finally {
      Employee.get = orig;
    }
  });
});
