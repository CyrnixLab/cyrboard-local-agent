import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { finalizeExecutionRepo, prepareExecutionRepo, prepareJobGitState, runAgent } from '../src/agents.js';

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

test('prepareJobGitState creates the remote epic branch and merges child branches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cyrboard-agent-'));
  const originPath = join(root, 'origin.git');
  const sourcePath = join(root, 'source');

  try {
    await createMainRepository(originPath, sourcePath);

    await git(['switch', '-c', 'tracker/cott-101/dev-child'], sourcePath);
    await writeFile(join(sourcePath, 'forecast.txt'), 'cloudy\n');
    await git(['add', 'forecast.txt'], sourcePath);
    await git(['commit', '-m', 'Child task change'], sourcePath);
    await git(['push', '-u', 'origin', 'tracker/cott-101/dev-child'], sourcePath);
    await git(['switch', 'main'], sourcePath);

    const job = {
      id: 124,
      jobKind: 'review',
      branchName: 'tracker/cott-100/epic-1',
      promptText: [
        'Child issues to verify:',
        '- COTT-101: tracker/cott-101/dev-child',
      ].join('\n'),
      input: { codexCloudBaseBranch: 'main', issueKey: 'COTT-100' },
    };
    const preparedPath = await prepareExecutionRepo({}, job, sourcePath);
    const result = await prepareJobGitState({}, job, preparedPath);

    assert.equal(result.remoteBranchCreated, true);
    assert.deepEqual(result.mergedBranches, ['tracker/cott-101/dev-child']);
    assert.equal(await readFile(join(preparedPath, 'forecast.txt'), 'utf8'), 'cloudy\n');
    assert.match(await gitOutput(['ls-remote', '--heads', 'origin', 'tracker/cott-100/epic-1'], preparedPath), /tracker\/cott-100\/epic-1/);

    const finalizeResult = await finalizeExecutionRepo({}, job, preparedPath);

    assert.equal(finalizeResult.pushed, true);
    assert.match(await gitOutput(['ls-remote', '--heads', 'origin', 'tracker/cott-100/epic-1'], preparedPath), /tracker\/cott-100\/epic-1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('finalizeExecutionRepo commits dirty worktree changes and pushes the job branch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cyrboard-agent-'));
  const originPath = join(root, 'origin.git');
  const sourcePath = join(root, 'source');
  const verifyPath = join(root, 'verify');

  try {
    await createMainRepository(originPath, sourcePath);

    const job = {
      id: 125,
      jobKind: 'dev',
      branchName: 'tracker/cott-102/dev-child',
      promptText: '',
      input: { codexCloudBaseBranch: 'main', issueKey: 'COTT-102' },
    };
    const preparedPath = await prepareExecutionRepo({}, job, sourcePath);

    await writeFile(join(preparedPath, 'weatherBot.js'), 'export const city = "Kyiv";\n');

    const result = await finalizeExecutionRepo({}, job, preparedPath);

    assert.equal(result.pushed, true);
    assert.equal(result.committed, true);
    assert.match(result.commitSha, /^[a-f0-9]{40}$/);

    await git(['clone', originPath, verifyPath], root);
    await git(['switch', 'tracker/cott-102/dev-child'], verifyPath);
    assert.equal(await readFile(join(verifyPath, 'weatherBot.js'), 'utf8'), 'export const city = "Kyiv";\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('finalizeExecutionRepo rejects unresolved conflict markers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cyrboard-agent-'));
  const originPath = join(root, 'origin.git');
  const sourcePath = join(root, 'source');

  try {
    await createMainRepository(originPath, sourcePath);

    const job = {
      id: 126,
      jobKind: 'merge_repair',
      branchName: 'tracker/cott-100/epic-1',
      promptText: '',
      input: { codexCloudBaseBranch: 'main', issueKey: 'COTT-100' },
    };
    const preparedPath = await prepareExecutionRepo({}, job, sourcePath);

    await writeFile(
      join(preparedPath, 'forecast.txt'),
      ['<<<<<<< HEAD', 'rain', '=======', 'sun', '>>>>>>> child', ''].join('\n'),
    );

    await assert.rejects(
      () => finalizeExecutionRepo({}, job, preparedPath),
      /Merge conflict markers remain/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runAgent keeps the source checkout clean and pushes fake Codex changes from the isolated clone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cyrboard-agent-'));
  const originPath = join(root, 'origin.git');
  const sourcePath = join(root, 'source');
  const verifyPath = join(root, 'verify');
  const fakeBinPath = join(root, 'bin');
  const fakeCodexPath = join(fakeBinPath, 'codex');
  const originalPath = process.env.PATH;

  try {
    await createMainRepository(originPath, sourcePath);
    await mkdir(fakeBinPath);
    await writeFile(
      fakeCodexPath,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'result_path=""',
        'while [ "$#" -gt 0 ]; do',
        '  if [ "$1" = "--output-last-message" ]; then',
        '    shift',
        '    result_path="$1"',
        '  fi',
        '  shift || true',
        'done',
        'cat >/dev/null',
        'printf "fake codex change\\n" > agent-output.txt',
        'printf "fake codex completed\\n" > "$result_path"',
        '',
      ].join('\n'),
    );
    await chmod(fakeCodexPath, 0o755);

    process.env.PATH = `${fakeBinPath}:${originalPath || ''}`;

    const result = await runAgent(
      {
        agent: 'codex',
        serverUrl: 'http://tracker.example.test',
      },
      {
        id: 127,
        projectId: 1,
        issueId: 100,
        jobKind: 'dev',
        commandId: 'test-dev',
        branchName: 'tracker/cott-103/dev-child',
        promptText: 'Create a fake Codex change.',
        input: { codexCloudBaseBranch: 'main', issueKey: 'COTT-103' },
      },
      sourcePath,
    );

    assert.match(result.resultText, /Runner pushed branch tracker\/cott-103\/dev-child/);
    assert.equal(await gitOutput(['status', '--short'], sourcePath), '');

    await git(['clone', originPath, verifyPath], root);
    await git(['switch', 'tracker/cott-103/dev-child'], verifyPath);
    assert.equal(await readFile(join(verifyPath, 'agent-output.txt'), 'utf8'), 'fake codex change\n');
  } finally {
    process.env.PATH = originalPath;
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

async function createMainRepository(originPath, sourcePath) {
  const rootPath = dirname(originPath);

  await git(['init', '--bare', originPath], rootPath);
  await git(['clone', originPath, sourcePath], rootPath);
  await git(['config', 'user.name', 'Cyrboard Test'], sourcePath);
  await git(['config', 'user.email', 'test@example.com'], sourcePath);
  await git(['switch', '-c', 'main'], sourcePath);
  await writeFile(join(sourcePath, 'city.txt'), 'main\n');
  await writeFile(join(sourcePath, '.gitignore'), '.cyrboard/\n');
  await git(['add', 'city.txt', '.gitignore'], sourcePath);
  await git(['commit', '-m', 'Initial main'], sourcePath);
  await git(['push', '-u', 'origin', 'main'], sourcePath);
}
