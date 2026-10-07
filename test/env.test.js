import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSecret, decodeEnvBytes, parseEnvText, readSettings } from '../lib/env.js';

const TEXT = '# my keys\nNVIDIA_API_KEY="nvapi-abc123"\nexport AI_MODEL=meta/llama-3.3-70b-instruct # default\nPORT=3001\n';

test('reads .env saved as plain text, with a byte-order mark, or as UTF-16', () => {
  const expected = parseEnvText(TEXT);
  assert.equal(expected.NVIDIA_API_KEY, 'nvapi-abc123');
  assert.equal(expected.AI_MODEL, 'meta/llama-3.3-70b-instruct');

  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(TEXT, 'utf8')]);
  const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(TEXT.replace(/\n/g, '\r\n'), 'utf16le')]);
  const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(TEXT, 'utf16le').swap16()]);
  const utf16NoBom = Buffer.from(TEXT, 'utf16le');
  for (const bytes of [withBom, utf16le, utf16be, utf16NoBom]) {
    assert.deepEqual(parseEnvText(decodeEnvBytes(bytes)), expected);
  }
});

test('cleans keys pasted with quotes, spaces, "Bearer" or invisible characters', () => {
  assert.equal(cleanSecret('  "nvapi-abc123"  '), 'nvapi-abc123');
  assert.equal(cleanSecret('​nvapi-abc 123﻿'), 'nvapi-abc123');
  assert.equal(cleanSecret('Bearer nvapi-abc123'), 'nvapi-abc123');
  assert.equal(cleanSecret(undefined), '');
});

test('settings have safe defaults', () => {
  const settings = readSettings({});
  assert.equal(settings.nvidiaKey, '');
  assert.equal(settings.model, 'meta/llama-3.3-70b-instruct');
  assert.equal(settings.claimCheck, true);
  assert.equal(settings.port, 3000);
  assert.equal(readSettings({ CLAIM_CHECK: 'off', PORT: 'abc' }).claimCheck, false);
  assert.equal(readSettings({ PORT: 'abc' }).port, 3000);
});
