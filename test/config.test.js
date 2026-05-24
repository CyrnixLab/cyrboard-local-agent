import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isLocalConfigIgnored, loadConfig, saveConfig } from '../src/config.js';

test('saveConfig writes reloadable private config', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cyrboard-agent-'));
  const config = {
    schemaVersion: 1,
    serverUrl: 'http://localhost:8182',
    projectId: 1,
    runnerId: 2,
    runnerToken: 'cyr_runner_test',
    agent: 'command',
  };

  await saveConfig(repo, config);

  assert.deepEqual(await loadConfig(repo), config);
  assert.equal((await stat(join(repo, '.cyrboard', 'local-agent.json'))).mode & 0o777, 0o600);
});

test('isLocalConfigIgnored detects .cyrboard gitignore entry', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cyrboard-agent-'));

  assert.equal(await isLocalConfigIgnored(repo), false);

  await saveConfig(repo, { schemaVersion: 1 });
  await import('node:fs/promises').then((fs) => fs.writeFile(join(repo, '.gitignore'), '.cyrboard/\n'));

  assert.equal(await isLocalConfigIgnored(repo), true);
});
