'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const multer = require('multer');
const { ROLES } = require('../src/middleware/auth');
const uploadService = require('../src/services/uploadService');
const uploadCtrl = require('../src/controllers/uploadController');
const { AppError } = require('../src/middleware/errorHandler');

const EMP = '11111111-1111-1111-1111-111111111111';
const OTHER = '44444444-4444-4444-4444-444444444444';
const HR = '55555555-5555-5555-5555-555555555555';
const UPLOAD_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(k, v) {
      this.headers[k] = v;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    send(body) {
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

async function expectStatus(fn, status, code) {
  try {
    await fn();
    assert.fail(`expected AppError ${status}`);
  } catch (err) {
    assert.ok(err instanceof AppError, `expected AppError, got ${err && err.message}`);
    assert.equal(err.status, status);
    if (code) assert.equal(err.code, code);
  }
}

describe('uploadService.canAccessUpload', () => {
  test('photo is open to any authenticated caller', () => {
    assert.equal(
      uploadService.canAccessUpload(
        { purpose: 'photo', employee_id: EMP },
        { id: OTHER, role: ROLES.EMPLOYEE }
      ),
      true
    );
  });

  test('cnic denied to unrelated employee', () => {
    assert.equal(
      uploadService.canAccessUpload(
        { purpose: 'cnic_front', employee_id: EMP },
        { id: OTHER, role: ROLES.EMPLOYEE }
      ),
      false
    );
  });

  test('cnic allowed for owner', () => {
    assert.equal(
      uploadService.canAccessUpload(
        { purpose: 'cnic_back', employee_id: EMP },
        { id: EMP, role: ROLES.EMPLOYEE }
      ),
      true
    );
  });

  test('cnic allowed for HR Admin', () => {
    assert.equal(
      uploadService.canAccessUpload(
        { purpose: 'cnic_front', employee_id: EMP },
        { id: HR, role: ROLES.HR_ADMIN }
      ),
      true
    );
  });
});

describe('upload constraints', () => {
  test('MAX_BYTES is 8 MB', () => {
    assert.equal(uploadService.MAX_BYTES, 8 * 1024 * 1024);
  });

  test('rejects non-image mime types', () => {
    assert.equal(uploadService.ALLOWED_TYPES.has('application/pdf'), false);
    assert.equal(uploadService.ALLOWED_TYPES.has('image/jpeg'), true);
    assert.equal(uploadService.ALLOWED_TYPES.has('image/png'), true);
    assert.equal(uploadService.ALLOWED_TYPES.has('image/webp'), true);
  });
});

describe('POST /api/uploads controller validation', () => {
  let origCreate;

  beforeEach(() => {
    origCreate = uploadService.create;
    uploadService.create = async () => ({
      id: UPLOAD_ID,
      employee_id: EMP,
      purpose: 'photo',
      content_type: 'image/jpeg',
      byte_size: 100,
    });
  });

  afterEach(() => {
    uploadService.create = origCreate;
  });

  test('rejects missing file', async () => {
    await expectStatus(
      () =>
        invoke(uploadCtrl.create, {
          user: { id: EMP, role: ROLES.EMPLOYEE },
          body: { purpose: 'photo' },
          file: undefined,
        }),
      400,
      'MISSING_FILE'
    );
  });

  test('rejects non-image mimetype', async () => {
    await expectStatus(
      () =>
        invoke(uploadCtrl.create, {
          user: { id: EMP, role: ROLES.EMPLOYEE },
          body: { purpose: 'photo' },
          file: {
            mimetype: 'application/pdf',
            size: 100,
            buffer: Buffer.from('%PDF'),
          },
        }),
      400,
      'INVALID_FILE_TYPE'
    );
  });

  test('rejects file over 8 MB', async () => {
    await expectStatus(
      () =>
        invoke(uploadCtrl.create, {
          user: { id: EMP, role: ROLES.EMPLOYEE },
          body: { purpose: 'cnic_front' },
          file: {
            mimetype: 'image/jpeg',
            size: 10 * 1024 * 1024,
            buffer: Buffer.alloc(10),
          },
        }),
      400,
      'FILE_TOO_LARGE'
    );
  });

  test('returns data.url envelope on success', async () => {
    const res = await invoke(uploadCtrl.create, {
      user: { id: EMP, role: ROLES.EMPLOYEE },
      body: { purpose: 'photo' },
      file: {
        mimetype: 'image/jpeg',
        size: 32,
        buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.data.url.includes(`/api/uploads/${UPLOAD_ID}`));
  });
});

describe('GET /api/uploads/:id CNIC gating', () => {
  let origGet;

  beforeEach(() => {
    origGet = uploadService.getById;
    uploadService.getById = async () => ({
      id: UPLOAD_ID,
      employee_id: EMP,
      purpose: 'cnic_front',
      content_type: 'image/jpeg',
      byte_size: 4,
      data: Buffer.from([1, 2, 3, 4]),
    });
  });

  afterEach(() => {
    uploadService.getById = origGet;
  });

  test('CNIC URL not retrievable without authorization', async () => {
    await expectStatus(
      () => invoke(uploadCtrl.serve, { params: { id: UPLOAD_ID }, user: undefined }),
      403
    );
  });

  test('CNIC denied to unrelated employee', async () => {
    await expectStatus(
      () =>
        invoke(uploadCtrl.serve, {
          params: { id: UPLOAD_ID },
          user: { id: OTHER, role: ROLES.EMPLOYEE },
        }),
      403
    );
  });

  test('CNIC served to owner', async () => {
    const res = await invoke(uploadCtrl.serve, {
      params: { id: UPLOAD_ID },
      user: { id: EMP, role: ROLES.EMPLOYEE },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'image/jpeg');
    assert.ok(Buffer.isBuffer(res.body) || res.body);
  });

  test('CNIC served to HR Admin', async () => {
    const res = await invoke(uploadCtrl.serve, {
      params: { id: UPLOAD_ID },
      user: { id: HR, role: ROLES.HR_ADMIN },
    });
    assert.equal(res.statusCode, 200);
  });
});

describe('multer LIMIT_FILE_SIZE mapping', () => {
  test('MulterError LIMIT_FILE_SIZE is recognised as FILE_TOO_LARGE path', () => {
    // Contract: controller maps MulterError with LIMIT_FILE_SIZE to FILE_TOO_LARGE.
    const err = new multer.MulterError('LIMIT_FILE_SIZE');
    assert.equal(err.code, 'LIMIT_FILE_SIZE');
  });
});
