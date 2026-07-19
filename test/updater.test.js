import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSafeVersion, installRuntimeVersion } from '../src/updater.js';

test('installer stages and validates an exact local agent version', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cyrboard-agent-update-'));
  const commands = [];
  const binPath = await installRuntimeVersion(repo, '0.3.1', {
    logger: { log: () => {} },
    commandRunner: async (command, args) => {
      commands.push([command, args]);
      const prefix = args[args.indexOf('--prefix') + 1];
      const packageDirectory = join(prefix, 'node_modules', '@cyrnixlab', 'cyrboard-local-agent');
      await mkdir(join(packageDirectory, 'bin'), { recursive: true });
      await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
        name: '@cyrnixlab/cyrboard-local-agent',
        version: '0.3.1',
      }));
      await writeFile(join(packageDirectory, 'bin', 'cyrboard-local-agent.js'), '#!/usr/bin/env node\n');
    },
  });

  assert.match(binPath, /\.cyrboard\/runtime\/0\.3\.1\/node_modules/);
  assert.equal(commands.length, 1);
  assert.equal(commands[0][1].at(-1), '@cyrnixlab/cyrboard-local-agent@0.3.1');

  const cachedBinPath = await installRuntimeVersion(repo, '0.3.1', {
    commandRunner: async () => {
      throw new Error('cached runtime should be reused');
    },
  });
  assert.equal(cachedBinPath, binPath);
});

test('installer rejects unsafe or non-semantic versions before invoking npm', () => {
  assert.throws(() => assertSafeVersion('latest'), /invalid/);
  assert.throws(() => assertSafeVersion('0.3.1; touch owned'), /invalid/);
  assert.doesNotThrow(() => assertSafeVersion('0.3.1'));
});

