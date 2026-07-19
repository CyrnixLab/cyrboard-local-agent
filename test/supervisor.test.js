import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSupervisor } from '../src/supervisor.js';

test('supervisor installs an idle update and starts the updated worker', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cyrboard-agent-supervisor-'));
  const workerBins = [];
  const installed = [];

  await startSupervisor(repo, 10, {
    initialBinPath: '/package/0.3.0/bin.js',
    maxCycles: 2,
    logger: { log: () => {}, warn: () => {} },
    workerRunner: async (binPath) => {
      workerBins.push(binPath);

      return workerBins.length === 1
        ? { updateVersion: '0.3.1', exitCode: 0, signal: null, stopped: false }
        : { updateVersion: null, exitCode: 0, signal: null, stopped: true };
    },
    installer: async (_repoPath, version) => {
      installed.push(version);
      return `/runtime/${version}/bin.js`;
    },
  });

  assert.deepEqual(installed, ['0.3.1']);
  assert.deepEqual(workerBins, [
    '/package/0.3.0/bin.js',
    '/runtime/0.3.1/bin.js',
  ]);
});
