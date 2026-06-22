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
