'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { resolveContentType, contentDisposition } = require('../src/utils/fileType');

test('octet-stream jpeg is served as an image from the filename', () => {
  const type = resolveContentType({
    upstreamType: 'application/octet-stream',
    name: 'receipt.jpg',
  });
  assert.equal(type, 'image/jpeg');
  assert.equal(contentDisposition(type, 'receipt.jpg'), 'inline; filename="receipt.jpg"');
});

test('octet-stream png is detected from file bytes when the name has no extension', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const type = resolveContentType({
    upstreamType: 'application/octet-stream',
    name: 'attachment',
    bytes: png,
  });
  assert.equal(type, 'image/png');
  assert.match(contentDisposition(type, 'attachment'), /^inline;/);
});

test('a real image content type is kept', () => {
  assert.equal(
    resolveContentType({ upstreamType: 'image/webp; charset=binary', name: 'a.bin' }),
    'image/webp'
  );
});

test('non-image files stay attachments', () => {
  const type = resolveContentType({
    upstreamType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    name: 'sheet.xlsx',
  });
  assert.match(contentDisposition(type, 'sheet.xlsx'), /^attachment;/);
});

test('a ClickUp sign-in page is recognised as HTML, not a file', () => {
  const { isHtmlResponse } = require('../src/utils/fileType');
  assert.equal(isHtmlResponse('text/html; charset=utf-8', Buffer.from('<!doctype html><html>')), true);
  assert.equal(isHtmlResponse('application/octet-stream', Buffer.from('  <!DOCTYPE html>')), true);
  assert.equal(isHtmlResponse('image/png', Buffer.from('<html><body>')), true);
  assert.equal(isHtmlResponse('image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47])), false);
  assert.equal(isHtmlResponse('application/pdf', Buffer.from('%PDF-1.7')), false);
});
