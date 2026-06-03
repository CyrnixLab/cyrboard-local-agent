import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { prepareExecutionRepo } from '../src/agents.js';

const execFileAsync = promisify(execFile);

test('prepareExecutionRepo checks out the requested remote branch in an isolated clone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cyrboard-agent-'));
  const originPath = join(root, 'origin.git');
  const sourcePath = join(root, 'source');

  try {
    await git(['init', '--bare', originPath], root);
    await git(['clone', originPath, sourcePath], root);
    await git(['config', 'user.name', 'Cyrboard Test'], sourcePath);
    await git(['config', 'user.email', 'test@example.com'], sourcePath);
    await git(['switch', '-c', 'main'], sourcePath);
    await writeFile(join(sourcePath, 'city.txt'), 'main\n');
    await git(['add', 'city.txt'], sourcePath);
    await git(['commit', '-m', 'Initial main'], sourcePath);
    await git(['push', '-u', 'origin', 'main'], sourcePath);

    await git(['switch', '-c', 'tracker/test-branch'], sourcePath);
    await writeFile(join(sourcePath, 'city.txt'), 'branch\n');
    await git(['commit', '-am', 'Branch change'], sourcePath);
    await git(['push', '-u', 'origin', 'tracker/test-branch'], sourcePath);
    await git(['switch', 'main'], sourcePath);

    const preparedPath = await prepareExecutionRepo(
      {},
      {
        id: 123,
        branchName: 'tracker/test-branch',
        input: { codexCloudBaseBranch: 'main' },
      },
      sourcePath,
    );

    assert.notEqual(preparedPath, sourcePath);
    assert.equal(await readFile(join(preparedPath, 'city.txt'), 'utf8'), 'branch\n');
    assert.equal((await gitOutput(['branch', '--show-current'], preparedPath)).trim(), 'tracker/test-branch');
    assert.equal(await readFile(join(sourcePath, 'city.txt'), 'utf8'), 'main\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function git(args, cwd) {
  await execFileAsync('git', args, { cwd });
}

async function gitOutput(args, cwd) {
  const result = await execFileAsync('git', args, { cwd });

  return result.stdout;
}
