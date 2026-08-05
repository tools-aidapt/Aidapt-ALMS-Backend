'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { ROLES } = require('../src/middleware/auth');
const {
  schemas,
  serialize,
} = require('../src/controllers/employeeController');
const {
  isValidIban,
  normalizeIban,
  applyProfileBodyToFields,
  PRIVATE_FIELD_KEYS,
} = require('../src/utils/employeeProfileFields');

const EMP = '11111111-1111-1111-1111-111111111111';
const MGR = '22222222-2222-2222-2222-222222222222';
const OTHER = '44444444-4444-4444-4444-444444444444';
const HR = '55555555-5555-5555-5555-555555555555';

function fullProfileFields() {
  return {
    Name: 'Ada',
    Email: 'ada@example.com',
    Role: 'Employee',
    Manager: [MGR],
    AssignedShift: [],
    Team: [],
    DateOfJoining: '2020-01-01',
    Status: 'Active',
    EmploymentStatus: 'Full-time',
    GraceMinutes: null,
    MonthlySalary: 100000,
    DateOfBirth: '1990-05-15',
    MedicalNotes: 'none',
    CnicFrontUrl: '/api/uploads/front',
    CnicBackUrl: '/api/uploads/back',
    BankName: 'HBL',
    BankAccountNo: '123',
    BankAccountHolderName: 'Ada Lovelace',
    Iban: 'PK36SCBL0000001123456702',
    PhoneNo: '+92 3001234567',
    EmergencyPhoneNo: '+92 3009999999',
    Address: 'Karachi',
    CurrentAddress: 'Karachi',
    PermanentAddress: 'Lahore',
    EmergencyContacts: [
      { name: 'Bob', relationship: 'spouse', phone: '+92 3009999999' },
    ],
    Education: [{ qualification: 'BS', institution: 'NUST', year: 2012 }],
    Experience: [
      {
        company: 'Aidapt',
        title: 'Engineer',
        fromDate: '2020-01-01',
        toDate: null,
        summary: 'ALMS',
      },
    ],
  };
}

function employeeRec(overrides = {}) {
  return {
    id: EMP,
    fields: { ...fullProfileFields(), ...overrides },
    createdTime: '2020-01-01T00:00:00.000Z',
  };
}

describe('employee profile serialize field visibility', () => {
  test('self reads every private profile field with defaults materialised', () => {
    const data = serialize(employeeRec(), { id: EMP, role: ROLES.EMPLOYEE });
    for (const key of [
      'dateOfBirth',
      'medicalNotes',
      'cnicFrontUrl',
      'cnicBackUrl',
      'bankName',
      'bankAccountNo',
      'bankAccountHolderName',
      'iban',
      'monthlySalary',
      'phoneNo',
      'emergencyPhoneNo',
      'address',
      'currentAddress',
      'permanentAddress',
      'emergencyContacts',
      'education',
      'experience',
    ]) {
      assert.ok(Object.prototype.hasOwnProperty.call(data, key), `missing ${key}`);
    }
    assert.equal(data.dateOfBirth, '1990-05-15');
    assert.equal(data.medicalNotes, 'none');
    assert.equal(data.iban, 'PK36SCBL0000001123456702');
    assert.equal(data.experience[0].toDate, null);
    assert.deepEqual(data.emergencyContacts[0].phone, '+92 3009999999');
  });

  test('HR Admin reads private fields for any employee', () => {
    const data = serialize(employeeRec(), { id: HR, role: ROLES.HR_ADMIN });
    assert.equal(data.dateOfBirth, '1990-05-15');
    assert.equal(data.medicalNotes, 'none');
    assert.equal(data.bankAccountHolderName, 'Ada Lovelace');
    assert.equal(data.monthlySalary, 100000);
  });

  test('Manager reading a direct report does not get sensitive keys', () => {
    const data = serialize(employeeRec(), { id: MGR, role: ROLES.MANAGER });
    for (const key of [
      'dateOfBirth',
      'medicalNotes',
      'cnicFrontUrl',
      'cnicBackUrl',
      'bankName',
      'bankAccountNo',
      'bankAccountHolderName',
      'iban',
      'monthlySalary',
    ]) {
      assert.equal(Object.prototype.hasOwnProperty.call(data, key), false, key);
    }
    assert.equal(data.name, 'Ada');
    assert.equal(data.role, 'Employee');
  });

  test('empty private fields serialise as null / "" / [] for self', () => {
    const data = serialize(
      employeeRec({
        DateOfBirth: null,
        MedicalNotes: null,
        CnicFrontUrl: null,
        CnicBackUrl: null,
        BankName: null,
        BankAccountNo: null,
        BankAccountHolderName: null,
        Iban: null,
        MonthlySalary: null,
        PhoneNo: null,
        EmergencyPhoneNo: null,
        Address: null,
        CurrentAddress: null,
        PermanentAddress: null,
        EmergencyContacts: [],
        Education: [],
        Experience: [],
      }),
      { id: EMP, role: ROLES.EMPLOYEE }
    );
    assert.equal(data.dateOfBirth, null);
    assert.equal(data.medicalNotes, '');
    assert.equal(data.cnicFrontUrl, null);
    assert.deepEqual(data.emergencyContacts, []);
    assert.deepEqual(data.education, []);
    assert.deepEqual(data.experience, []);
  });
});

describe('employee profile validation (updateSelf / update)', () => {
  test('accepts a full valid self-service body', () => {
    const body = {
      name: 'Ada',
      dateOfBirth: '1990-05-15',
      currentAddress: 'Karachi',
      permanentAddress: 'Lahore',
      address: 'Karachi',
      phoneNo: '+92 3001234567',
      emergencyPhoneNo: '+92 3009999999',
      emergencyContacts: [
        { name: 'Bob', relationship: 'spouse', phone: '+92 3009999999' },
        { name: 'Eve', relationship: 'parent', phone: '+92 3008888888' },
      ],
      education: [{ qualification: 'BS', institution: 'NUST', year: 2012 }],
      experience: [
        {
          company: 'Aidapt',
          title: 'Engineer',
          fromDate: '2020-01-01',
          toDate: null,
          summary: 'ALMS',
        },
      ],
      medicalNotes: '',
      cnicFrontUrl: 'https://example/front',
      cnicBackUrl: null,
      bankName: 'HBL',
      bankAccountNo: '123',
      bankAccountHolderName: 'Ada',
      iban: 'pk36 scbl 0000 0011 2345 6702',
    };
    const parsed = schemas.updateSelf.safeParse(body);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.iban, 'PK36SCBL0000001123456702');
  });

  test('rejects more than 2 emergency contacts', () => {
    const parsed = schemas.updateSelf.safeParse({
      emergencyContacts: [
        { name: 'A', relationship: 'x', phone: '+92 3001111111' },
        { name: 'B', relationship: 'y', phone: '+92 3002222222' },
        { name: 'C', relationship: 'z', phone: '+92 3003333333' },
      ],
    });
    assert.equal(parsed.success, false);
  });

  test('rejects future dateOfBirth', () => {
    const future = new Date();
    future.setUTCFullYear(future.getUTCFullYear() + 1);
    const parsed = schemas.updateSelf.safeParse({
      dateOfBirth: future.toISOString().slice(0, 10),
    });
    assert.equal(parsed.success, false);
  });

  test('rejects dateOfBirth implying age under 14', () => {
    const recent = new Date();
    recent.setUTCFullYear(recent.getUTCFullYear() - 10);
    const parsed = schemas.updateSelf.safeParse({
      dateOfBirth: recent.toISOString().slice(0, 10),
    });
    assert.equal(parsed.success, false);
  });

  test('rejects experience toDate before fromDate', () => {
    const parsed = schemas.updateSelf.safeParse({
      experience: [
        {
          company: 'X',
          title: 'Y',
          fromDate: '2020-06-01',
          toDate: '2019-01-01',
          summary: '',
        },
      ],
    });
    assert.equal(parsed.success, false);
  });

  test('rejects education year out of range', () => {
    const parsed = schemas.updateSelf.safeParse({
      education: [{ qualification: 'BS', institution: 'X', year: 1900 }],
    });
    assert.equal(parsed.success, false);
  });

  test('HR update schema accepts profile + org fields together', () => {
    const parsed = schemas.update.safeParse({
      role: 'Manager',
      monthlySalary: 120000,
      dateOfBirth: '1985-01-01',
      medicalNotes: 'n/a',
    });
    assert.equal(parsed.success, true);
  });

  test('create schema accepts optional profile extras', () => {
    const parsed = schemas.create.safeParse({
      name: 'New',
      email: 'new@example.com',
      password: 'password1',
      dateOfBirth: '1995-03-03',
      phoneNo: '+92 3001111111',
    });
    assert.equal(parsed.success, true);
  });
});

describe('applyProfileBodyToFields sync rules', () => {
  test('address and currentAddress stay aligned', () => {
    const fields = {};
    applyProfileBodyToFields({ currentAddress: 'Street 1' }, fields);
    assert.equal(fields.CurrentAddress, 'Street 1');
    assert.equal(fields.Address, 'Street 1');

    const fields2 = {};
    applyProfileBodyToFields({ address: 'Legacy only' }, fields2);
    assert.equal(fields2.CurrentAddress, 'Legacy only');
    assert.equal(fields2.Address, 'Legacy only');
  });

  test('emergencyContacts[0].phone updates emergencyPhoneNo', () => {
    const fields = {};
    applyProfileBodyToFields(
      {
        emergencyContacts: [
          { name: 'Bob', relationship: 'spouse', phone: '+92 3009999999' },
        ],
      },
      fields
    );
    assert.equal(fields.EmergencyPhoneNo, '+92 3009999999');
  });

  test('experience toDate null is preserved (currently employed)', () => {
    const fields = {};
    applyProfileBodyToFields(
      {
        experience: [
          {
            company: 'Aidapt',
            title: 'Eng',
            fromDate: '2020-01-01',
            toDate: null,
            summary: '',
          },
        ],
      },
      fields
    );
    assert.equal(fields.Experience[0].toDate, null);
  });
});

describe('IBAN helpers', () => {
  test('normalises spaces and case', () => {
    assert.equal(normalizeIban('pk36 scbl 0000 0011 2345 6702'), 'PK36SCBL0000001123456702');
  });

  test('validates known good IBAN checksum', () => {
    // GB82WEST12345698765432 is a common sample IBAN
    assert.equal(isValidIban('GB82WEST12345698765432'), true);
  });

  test('rejects bad checksum', () => {
    assert.equal(isValidIban('GB82WEST12345698765433'), false);
  });
});

describe('getOne access matrix (contract)', () => {
  // Controllers throw AppError for third parties; Manager of report may view
  // public serialize only. Documented by PRIVATE_FIELD_KEYS export.
  test('PRIVATE_FIELD_KEYS includes medicalNotes and bank set', () => {
    for (const key of [
      'dateOfBirth',
      'medicalNotes',
      'cnicFrontUrl',
      'cnicBackUrl',
      'bankName',
      'bankAccountNo',
      'bankAccountHolderName',
      'iban',
      'monthlySalary',
    ]) {
      assert.ok(PRIVATE_FIELD_KEYS.includes(key), key);
    }
  });

  test('unrelated employee cannot see private keys via serialize', () => {
    const data = serialize(employeeRec(), { id: OTHER, role: ROLES.EMPLOYEE });
    assert.equal(Object.prototype.hasOwnProperty.call(data, 'medicalNotes'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(data, 'dateOfBirth'), false);
  });
});
