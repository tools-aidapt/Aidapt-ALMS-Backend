'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const AttendancePunch = require('../src/models/AttendancePunch');
const Employee = require('../src/models/Employee');
const OfficeConfig = require('../src/models/OfficeConfig');
const remoteWorkService = require('../src/services/remoteWorkService');
const strikeService = require('../src/services/strikeService');
const attendanceService = require('../src/services/attendanceService');
const { AppError } = require('../src/middleware/errorHandler');

const EMP = '11111111-1111-1111-1111-111111111111';
const originals = [];

function remember(obj, key) {
  originals.push({ obj, key, value: obj[key] });
}

function restoreAll() {
  for (const slot of originals) slot.obj[slot.key] = slot.value;
  originals.length = 0;
}

beforeEach(() => {
  remember(AttendancePunch, 'findForEmployeeOnDate');
  remember(AttendancePunch, 'create');
  remember(AttendancePunch, 'update');
  remember(Employee, 'get');
  remember(OfficeConfig, 'getSingleton');
  remember(remoteWorkService, 'isApprovedForDate');
  remember(strikeService, 'recomputeForEmployeeMonth');

  AttendancePunch.findForEmployeeOnDate = async () => null;
  AttendancePunch.create = async (fields) => ({ id: 'punch-1', fields });
  AttendancePunch.update = async (id, fields) => ({ id, fields });
  Employee.get = async (id) => ({
    id,
    fields: { Name: 'Employee', AssignedShift: [], GraceMinutes: null },
  });
  OfficeConfig.getSingleton = async () => ({
    id: 'office-1',
    fields: { Latitude: 24.86, Longitude: 67.01, RadiusMeters: 100 },
  });
  remoteWorkService.isApprovedForDate = async () => false;
  strikeService.recomputeForEmployeeMonth = async () => {};
});

afterEach(() => {
  restoreAll();
});

test('remote check-in without an approved request is rejected and stores nothing', async () => {
  let writes = 0;
  AttendancePunch.create = async () => {
    writes += 1;
    return { id: 'punch-1', fields: {} };
  };
  AttendancePunch.update = async () => {
    writes += 1;
    return { id: 'punch-1', fields: {} };
  };

  await assert.rejects(
    () => attendanceService.checkIn(EMP, { lat: 31.52, lng: 74.35, accuracy: 10 }),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.status, 409);
      assert.equal(err.code, 'REMOTE_NOT_APPROVED');
      assert.match(err.message, /cannot check in remotely until your remote work request is approved/i);
      return true;
    }
  );
  assert.equal(writes, 0);
});

test('approved remote check-in is stored as Present', async () => {
  remoteWorkService.isApprovedForDate = async () => true;
  let stored = null;
  AttendancePunch.create = async (fields) => {
    stored = fields;
    return { id: 'punch-1', fields };
  };

  const punch = await attendanceService.checkIn(EMP, { lat: 31.52, lng: 74.35, accuracy: 10 });
  assert.equal(stored.Mode, 'Remote In');
  assert.equal(stored.Status, 'Present');
  assert.equal(punch.mode, 'Remote In');
  assert.equal(punch.status, 'Present');
  assert.equal(punch.remoteApproved, true);
});

test('office check-in does not require a remote request', async () => {
  let asked = 0;
  remoteWorkService.isApprovedForDate = async () => {
    asked += 1;
    return false;
  };
  let stored = null;
  AttendancePunch.create = async (fields) => {
    stored = fields;
    return { id: 'punch-1', fields };
  };

  const punch = await attendanceService.checkIn(EMP, { lat: 24.86, lng: 67.01, accuracy: 5 });
  assert.equal(asked, 0);
  assert.equal(stored.Mode, 'Office');
  assert.equal(stored.Status, 'Present');
  assert.equal(punch.remoteApproved, null);
});
