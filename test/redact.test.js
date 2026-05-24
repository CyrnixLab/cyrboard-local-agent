import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../src/redact.js';

test('redactSecrets masks setup and runner tokens', () => {
  const value = redactSecrets('Bearer cyr_mcp_aaaaaaaaaaaaaaaa and cyr_runner_bbbbbbbbbbbbbbbb');

  assert.equal(value.includes('cyr_mcp_'), false);
  assert.equal(value.includes('cyr_runner_'), false);
  assert.equal(value.includes('[redacted'), true);
});
