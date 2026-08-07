'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { ROLES } = require('../src/middleware/auth');
const teamCtrl = require('../src/controllers/teamController');
const Team = require('../src/models/Team');
const Employee = require('../src/models/Employee');

const EMP = '11111111-1111-1111-1111-111111111111';
const LEAD = '22222222-2222-2222-2222-222222222222';
const OTHER = '44444444-4444-4444-4444-444444444444';
const HR = '55555555-5555-5555-5555-555555555555';
const TEAM_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TEAM_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('canSeeTeamLiveDetail', () => {
  const teamA = { id: TEAM_A, fields: { Lead: [LEAD], Name: 'A' } };
  const teamB = { id: TEAM_B, fields: { Lead: [OTHER], Name: 'B' } };

  test('HR Admin sees live detail for any team', () => {
    assert.equal(
      teamCtrl.canSeeTeamLiveDetail({ id: HR, role: ROLES.HR_ADMIN }, teamA, null),
      true
    );
    assert.equal(
      teamCtrl.canSeeTeamLiveDetail({ id: HR, role: ROLES.HR_ADMIN }, teamB, TEAM_A),
      true
    );
  });

  test('Team lead sees live detail for their team only', () => {
    assert.equal(
      teamCtrl.canSeeTeamLiveDetail({ id: LEAD, role: ROLES.MANAGER }, teamA, null),
      true
    );
    assert.equal(
      teamCtrl.canSeeTeamLiveDetail({ id: LEAD, role: ROLES.MANAGER }, teamB, null),
      false
    );
  });

  test('Member sees live detail for own team only', () => {
    assert.equal(
      teamCtrl.canSeeTeamLiveDetail({ id: EMP, role: ROLES.EMPLOYEE }, teamA, TEAM_A),
      true
    );
    assert.equal(
      teamCtrl.canSeeTeamLiveDetail({ id: EMP, role: ROLES.EMPLOYEE }, teamB, TEAM_A),
      false
    );
  });

  test('Unrelated employee cannot see live detail', () => {
    assert.equal(
      teamCtrl.canSeeTeamLiveDetail({ id: OTHER, role: ROLES.EMPLOYEE }, teamA, TEAM_B),
      false
    );
  });
});

describe('enrichMembers live-detail redaction', () => {
  const members = [
    {
      id: EMP,
      fields: {
        Name: 'Emp',
        PhotoUrl: null,
        Role: 'Employee',
        EmploymentStatus: 'Full-time',
        DateOfJoining: '2024-01-01',
        AssignedShift: [],
      },
    },
  ];

  test('includeLiveDetail false keeps names, nulls punch and balances', async () => {
    const rows = await teamCtrl.enrichMembers(members, { includeLiveDetail: false });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, EMP);
    assert.equal(rows[0].name, 'Emp');
    assert.equal(rows[0].balances, null);
    assert.equal(rows[0].todayPunch, null);
    assert.equal(rows[0].onLeave, null);
    assert.equal(rows[0].leaveType, null);
  });
});

describe('GET /api/teams live detail scoping', () => {
  let origList;
  let origFindMembers;
  let origGet;
  let origListTeamIds;

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

  beforeEach(() => {
    origList = Team.list;
    origFindMembers = Team.findMembers;
    origGet = Employee.get;
    origListTeamIds = Employee.listTeamIds;

    Team.list = async () => [
      { id: TEAM_A, fields: { Name: 'Alpha', Lead: [LEAD], CreatedAt: null }, createdTime: null },
      { id: TEAM_B, fields: { Name: 'Beta', Lead: [OTHER], CreatedAt: null }, createdTime: null },
    ];

    Team.findMembers = async (teamId) => [
      {
        id: teamId === TEAM_A ? EMP : OTHER,
        fields: {
          Name: teamId === TEAM_A ? 'Alpha Member' : 'Beta Member',
          PhotoUrl: null,
          Role: 'Employee',
          EmploymentStatus: 'Full-time',
          DateOfJoining: null,
          AssignedShift: [],
        },
      },
    ];
  });

  afterEach(() => {
    Team.list = origList;
    Team.findMembers = origFindMembers;
    Employee.get = origGet;
    Employee.listTeamIds = origListTeamIds;
  });

  test('member of Team A gets live keys on A and redacted on B', async () => {
    Employee.listTeamIds = async (id) => (id === EMP ? [TEAM_A] : []);

    const LeaveBalance = require('../src/models/LeaveBalance');
    const AttendancePunch = require('../src/models/AttendancePunch');
    const db = require('../src/config/db');
    const origBal = LeaveBalance.selectWhere;
    const origPunch = AttendancePunch.forEmployeesOnDate;
    const origDbQuery = db.query;
    LeaveBalance.selectWhere = async () => [];
    AttendancePunch.forEmployeesOnDate = async () => [];
    db.query = async () => ({ rows: [] });

    try {
      const res = await invoke(teamCtrl.list, {
        user: { id: EMP, role: ROLES.EMPLOYEE },
      });
      assert.equal(res.body.data.length, 2);
      const alpha = res.body.data.find((t) => t.id === TEAM_A);
      const beta = res.body.data.find((t) => t.id === TEAM_B);
      assert.ok(alpha && beta);
      // Live detail present on own team
      assert.deepEqual(alpha.members[0].balances, { annual: 0, sick: 0, casual: 0 });
      assert.equal(typeof alpha.members[0].todayPunch, 'object');
      assert.notEqual(alpha.members[0].todayPunch, null);
      assert.equal(alpha.members[0].onLeave, false);
      // Org chart only on other team
      assert.equal(beta.members[0].name, 'Beta Member');
      assert.equal(beta.members[0].balances, null);
      assert.equal(beta.members[0].todayPunch, null);
      assert.equal(beta.members[0].onLeave, null);
    } finally {
      LeaveBalance.selectWhere = origBal;
      AttendancePunch.forEmployeesOnDate = origPunch;
      db.query = origDbQuery;
    }
  });

  test('HR Admin gets live detail on every team', async () => {
    Employee.listTeamIds = async () => [];
    const LeaveBalance = require('../src/models/LeaveBalance');
    const AttendancePunch = require('../src/models/AttendancePunch');
    const db = require('../src/config/db');
    const origBal = LeaveBalance.selectWhere;
    const origPunch = AttendancePunch.forEmployeesOnDate;
    const origDbQuery = db.query;
    LeaveBalance.selectWhere = async () => [];
    AttendancePunch.forEmployeesOnDate = async () => [];
    db.query = async () => ({ rows: [] });
    try {
      const res = await invoke(teamCtrl.list, {
        user: { id: HR, role: ROLES.HR_ADMIN },
      });
      for (const team of res.body.data) {
        assert.ok(team.members[0].balances, `expected balances on ${team.id}`);
        assert.ok(team.members[0].todayPunch, `expected todayPunch on ${team.id}`);
      }
    } finally {
      LeaveBalance.selectWhere = origBal;
      AttendancePunch.forEmployeesOnDate = origPunch;
      db.query = origDbQuery;
    }
  });

  test('team lead gets live detail only for led team', async () => {
    // Lead of A is LEAD; membership is B — can see A as lead and B as member.
    Employee.listTeamIds = async () => [TEAM_B];
    const LeaveBalance = require('../src/models/LeaveBalance');
    const AttendancePunch = require('../src/models/AttendancePunch');
    const db = require('../src/config/db');
    const origBal = LeaveBalance.selectWhere;
    const origPunch = AttendancePunch.forEmployeesOnDate;
    const origDbQuery = db.query;
    LeaveBalance.selectWhere = async () => [];
    AttendancePunch.forEmployeesOnDate = async () => [];
    db.query = async () => ({ rows: [] });
    try {
      const res = await invoke(teamCtrl.list, {
        user: { id: LEAD, role: ROLES.MANAGER },
      });
      const alpha = res.body.data.find((t) => t.id === TEAM_A);
      const beta = res.body.data.find((t) => t.id === TEAM_B);
      assert.ok(alpha.members[0].balances);
      assert.ok(beta.members[0].balances);
    } finally {
      LeaveBalance.selectWhere = origBal;
      AttendancePunch.forEmployeesOnDate = origPunch;
      db.query = origDbQuery;
    }
  });

  test('member of multiple teams sees live detail on each', async () => {
    Employee.listTeamIds = async (id) => (id === EMP ? [TEAM_A, TEAM_B] : []);
    const LeaveBalance = require('../src/models/LeaveBalance');
    const AttendancePunch = require('../src/models/AttendancePunch');
    const db = require('../src/config/db');
    const origBal = LeaveBalance.selectWhere;
    const origPunch = AttendancePunch.forEmployeesOnDate;
    const origDbQuery = db.query;
    LeaveBalance.selectWhere = async () => [];
    AttendancePunch.forEmployeesOnDate = async () => [];
    db.query = async () => ({ rows: [] });
    try {
      const res = await invoke(teamCtrl.list, {
        user: { id: EMP, role: ROLES.EMPLOYEE },
      });
      for (const team of res.body.data) {
        assert.ok(team.members[0].balances, `expected live detail on ${team.id}`);
      }
    } finally {
      LeaveBalance.selectWhere = origBal;
      AttendancePunch.forEmployeesOnDate = origPunch;
      db.query = origDbQuery;
    }
  });
});
