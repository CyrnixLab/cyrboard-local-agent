import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRequiredAncestorBranches } from '../src/agents.js';
import { runOnce, startLoop } from '../src/runner.js';

test('startLoop keeps polling after an iteration failure', async () => {
  const calls = [];
  const warnings = [];
  let attempts = 0;

  await startLoop({ serverUrl: 'http://localhost:8182' }, '/repo', 10, {
    maxIterations: 2,
    delay: async (milliseconds) => {
      calls.push(['delay', milliseconds]);
    },
    logger: {
      log: () => {},
      warn: (message) => warnings.push(message),
    },
    runOnce: async () => {
      attempts += 1;

      if (attempts === 1) {
        throw new Error('temporary network timeout');
      }

      calls.push(['run', attempts]);
    },
  });

  assert.equal(attempts, 2);
  assert.deepEqual(calls, [
    ['delay', 10000],
    ['run', 2],
    ['delay', 10000],
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /temporary network timeout/);
});

test('runOnce reports job failure and rethrows original error', async () => {
  const failedPayloads = [];
  const client = {
    async claim() {
      return {
        job: {
          id: 19,
          jobKind: 'plan',
        },
      };
    },
    async heartbeat() {},
    async fail(_runnerToken, payload) {
      failedPayloads.push(payload);
    },
  };

  await assert.rejects(
    () => runOnce(
      {
        serverUrl: 'http://localhost:8182',
        runnerToken: 'cyr_runner_test',
      },
      '/repo',
      {
        client,
        agentRunner: async () => {
          throw new Error('codex exited with code 1');
        },
      },
    ),
    /codex exited with code 1/,
  );

  assert.deepEqual(failedPayloads, [
    {
      jobId: 19,
      errorMessage: 'codex exited with code 1',
    },
  ]);
});

test('runOnce reports full result text separately from summary', async () => {
  const completedPayloads = [];
  const client = {
    async claim() {
      return {
        job: {
          id: 20,
          jobKind: 'plan',
        },
      };
    },
    async heartbeat() {},
    async complete(_runnerToken, payload) {
      completedPayloads.push(payload);
    },
  };

  await runOnce(
    {
      serverUrl: 'http://localhost:8182',
      runnerToken: 'cyr_runner_test',
    },
    '/repo',
    {
      client,
      agentRunner: async () => ({
        summary: 'short summary',
        resultText: 'full result text with trackerMcp JSON',
      }),
    },
  );

  assert.deepEqual(completedPayloads, [
    {
      jobId: 20,
      resultSummary: 'short summary',
      resultText: 'full result text with trackerMcp JSON',
    },
  ]);
});

test('runOnce advertises attachment capability only for Codex', async () => {
  const claims = [];
  const client = {
    async claim(_token, profile) {
      claims.push(profile);
      return { job: null };
    },
  };

  await runOnce({ agent: 'codex', runnerToken: 'token' }, '/repo', { client });
  await runOnce({ agent: 'claude', runnerToken: 'token' }, '/repo', { client });

  assert.equal(claims[0].clientVersion, '0.3.0');
  assert.equal(claims[0].protocolVersion, 2);
  assert.ok(claims[0].capabilities.input_attachments_v1);
  assert.deepEqual(claims[1].capabilities, {});
});

test('runOnce requests an automatic update only while no job is claimed', async () => {
  const result = await runOnce({ agent: 'codex', runnerToken: 'token' }, '/repo', {
    client: {
      async claim() {
        return {
          job: null,
          update: {
            latestVersion: '0.3.1',
            updateRequired: true,
          },
        };
      },
    },
  });

  assert.deepEqual(result, {
    claimed: false,
    updateRequired: true,
    latestVersion: '0.3.1',
  });
});

test('startLoop stops polling and hands an idle update to the supervisor', async () => {
  const updates = [];
  let calls = 0;

  const result = await startLoop({}, '/repo', 10, {
    maxIterations: 2,
    logger: { log: () => {}, warn: () => {} },
    runOnce: async () => {
      calls += 1;
      return {
        claimed: false,
        updateRequired: true,
        latestVersion: '0.3.1',
      };
    },
    onUpdateRequired: async (version) => updates.push(version),
  });

  assert.equal(calls, 1);
  assert.deepEqual(updates, ['0.3.1']);
  assert.deepEqual(result, {
    reason: 'update_required',
    latestVersion: '0.3.1',
  });
});

test('runOnce fails closed when a non-Codex runner receives attachments', async () => {
  const failures = [];
  const client = {
    async claim() {
      return { job: { id: 23, jobKind: 'plan', attachments: [{ id: 'file-1' }] } };
    },
    async fail(_token, payload) {
      failures.push(payload);
    },
  };

  await assert.rejects(
    () => runOnce({ agent: 'claude', runnerToken: 'token' }, '/repo', { client }),
    /input_attachment_agent_unsupported/,
  );
  assert.deepEqual(failures, [{ jobId: 23, errorMessage: 'input_attachment_agent_unsupported' }]);
});

test('runOnce redacts secrets before reporting completion', async () => {
  const completedPayloads = [];
  const client = {
    async claim() {
      return {
        job: {
          id: 21,
          jobKind: 'review',
        },
      };
    },
    async heartbeat() {},
    async complete(_runnerToken, payload) {
      completedPayloads.push(payload);
    },
  };

  await runOnce(
    {
      serverUrl: 'http://localhost:8182',
      runnerToken: 'cyr_runner_test',
    },
    '/repo',
    {
      client,
      agentRunner: async () => ({
        summary: 'summary cyr_mcp_deadbeef',
        resultText: 'Authorization: Bearer cyr_mcp_deadbeef',
      }),
    },
  );

  assert.deepEqual(completedPayloads, [
    {
      jobId: 21,
      resultSummary: 'summary [redacted-token]',
      resultText: 'Authorization: Bearer [redacted]',
    },
  ]);
});

test('runOnce redacts secrets before reporting failure', async () => {
  const failedPayloads = [];
  const client = {
    async claim() {
      return {
        job: {
          id: 22,
          jobKind: 'test',
        },
      };
    },
    async heartbeat() {},
    async fail(_runnerToken, payload) {
      failedPayloads.push(payload);
    },
  };

  await assert.rejects(
    () => runOnce(
      {
        serverUrl: 'http://localhost:8182',
        runnerToken: 'cyr_runner_test',
      },
      '/repo',
      {
        client,
        agentRunner: async () => {
          throw new Error('failed with cyr_mcp_deadbeef');
        },
      },
    ),
    /failed with cyr_mcp_deadbeef/,
  );

  assert.deepEqual(failedPayloads, [
    {
      jobId: 22,
      errorMessage: 'failed with [redacted-token]',
    },
  ]);
});

test('resolveRequiredAncestorBranches normalizes tracker job input', () => {
  assert.deepEqual(
    resolveRequiredAncestorBranches({
      input: {
        requiredAncestorBranches: [
          ' tracker/po-3/dev-1 ',
          '',
          'tracker/po-3/dev-1',
          'tracker/po-4/dev-2',
          42,
          null,
        ],
      },
    }),
    ['tracker/po-3/dev-1', 'tracker/po-4/dev-2'],
  );

  assert.deepEqual(resolveRequiredAncestorBranches({ input: {} }), []);
});
