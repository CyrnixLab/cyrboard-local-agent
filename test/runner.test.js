import test from 'node:test';
import assert from 'node:assert/strict';
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
