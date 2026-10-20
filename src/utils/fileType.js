'use strict';

const BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  heic: 'image/heic',
  heif: 'image/heif',
};

function baseType(value) {
  return String(value || '').split(';')[0].trim().toLowerCase();
}

function isGenericType(value) {
  const type = baseType(value);
  return (
    !type ||
    type === 'application/octet-stream' ||
    type === 'binary/octet-stream' ||
    type === 'application/force-download' ||
    type === 'application/x-download'
  );
}

function extensionOf(name, extension) {
  const explicit = String(extension || '').replace(/^\./, '').trim().toLowerCase();
  if (explicit) return explicit;
  const base = String(name || '').split(/[?#]/)[0].split(/[/\\]/).pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** Identify an image or PDF from the first bytes. */
function sniffContentType(bytes) {
  if (!bytes || bytes.length < 4) return null;
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (buf.length >= 5 && buf.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

/**
 * Type to send so a browser can render the file.
 * A real image/pdf type from the source wins. A generic type (ClickUp often
 * sends application/octet-stream) is replaced from the filename, then from bytes.
 */
function resolveContentType({ upstreamType, name, extension, bytes } = {}) {
  const upstream = baseType(upstreamType);
  if (!isGenericType(upstream) && (upstream.startsWith('image/') || upstream === 'application/pdf')) {
    return upstream;
  }
  const fromName = BY_EXT[extensionOf(name, extension)];
  if (fromName) return fromName;
  const sniffed = sniffContentType(bytes);
  if (sniffed) return sniffed;
  if (!isGenericType(upstream)) return upstream;
  return 'application/octet-stream';
}

/**
 * True when a "file" is really a web page. ClickUp answers an attachment URL it
 * won't serve (unsigned, expired token) with its sign-in page and a 200, so the
 * status alone can't be trusted.
 */
function isHtmlResponse(upstreamType, bytes) {
  if (baseType(upstreamType) === 'text/html') return true;
  if (!bytes || !bytes.length) return false;
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const start = buf.toString('utf8', 0, Math.min(buf.length, 64)).replace(/^﻿/, '').trimStart().toLowerCase();
  return start.startsWith('<!doctype html') || start.startsWith('<html');
}

function isInlineType(contentType) {
  const type = baseType(contentType);
  return type.startsWith('image/') || type === 'application/pdf';
}

function safeFilename(name) {
  const cleaned = String(name || 'file').replace(/[\r\n"]/g, '').trim();
  return cleaned || 'file';
}

/** inline for images and PDFs so the browser shows them; attachment otherwise. */
function contentDisposition(contentType, filename) {
  const kind = isInlineType(contentType) ? 'inline' : 'attachment';
  return `${kind}; filename="${safeFilename(filename)}"`;
}

module.exports = {
  resolveContentType,
  sniffContentType,
  isHtmlResponse,
  isInlineType,
  contentDisposition,
  safeFilename,
};
