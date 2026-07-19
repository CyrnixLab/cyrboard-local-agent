import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireRunnerLock } from '../src/process-lock.js';

test('runner lock rejects a second process for the same repository', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cyrboard-agent-lock-'));
  const release = await acquireRunnerLock(repo);

  await assert.rejects(() => acquireRunnerLock(repo), /already running/);
  await release();

  const releaseAgain = await acquireRunnerLock(repo);
  await releaseAgain();
});

test('runner lock replaces stale lock metadata', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cyrboard-agent-lock-'));
  const directory = join(repo, '.cyrboard');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'local-agent.lock'), '{"pid":999999999}\n');

  const release = await acquireRunnerLock(repo);
  await release();
});

