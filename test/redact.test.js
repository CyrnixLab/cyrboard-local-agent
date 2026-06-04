import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../src/redact.js';

test('redactSecrets masks setup and runner tokens', () => {
  const value = redactSecrets('Bearer cyr_mcp_aaaaaaaaaaaaaaaa and cyr_runner_bbbbbbbbbbbbbbbb');

  assert.equal(value.includes('cyr_mcp_'), false);
  assert.equal(value.includes('cyr_runner_'), false);
  assert.equal(value.includes('[redacted'), true);
});

test('redactSecrets masks job-scoped MCP tokens in env and json output', () => {
  const value = redactSecrets([
    'CYRBOARD_MCP_TOKEN=cyr_mcp_job_deadbeefcafebabe',
    '{"mcpToken":"cyr_mcp_job_aaaaaaaaaaaaaaaa","runnerToken":"cyr_runner_bbbbbbbbbbbbbbbb"}',
    'Authorization: Bearer cyr_mcp_job_cccccccccccccccc',
  ].join('\n'));

  assert.equal(value.includes('cyr_mcp_job_'), false);
  assert.equal(value.includes('cyr_runner_'), false);
  assert.match(value, /CYRBOARD_MCP_TOKEN=\[redacted\]/);
  assert.match(value, /"mcpToken":"\[redacted\]"/);
  assert.match(value, /Authorization: Bearer \[redacted\]/);
});
