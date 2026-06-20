import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { buildClaudeArgs, buildCodexArgs, finalizeExecutionRepo, prepareExecutionRepo, prepareJobGitState, runAgent } from '../src/agents.js';

const execFileAsync = promisify(execFile);

test('buildCodexArgs enables workspace-write network access for Tracker MCP', () => {
  const args = buildCodexArgs(
    {
      sandbox: 'workspace-write',
      model: 'gpt-5.5',
      reasoning: 'xhigh',
    },
    { input: {} },
    '/repo',
    '/repo/.cyrboard/jobs/1-result.md',
  );

  assert.deepEqual(args.slice(0, 8), [
    'exec',
    '--cd',
    '/repo',
    '--skip-git-repo-check',
    '--sandbox',
    'workspace-write',
    '--output-last-message',
    '/repo/.cyrboard/jobs/1-result.md',
  ]);
  assert.ok(args.includes('sandbox_workspace_write.network_access=true'));
  assert.deepEqual(args.slice(-5), ['--model', 'gpt-5.5', '-c', 'model_reasoning_effort="xhigh"', '-']);
});

test('buildCodexArgs uses job-scoped model and reasoning from Tracker claim payload', () => {
  const args = buildCodexArgs(
    {
      agent: 'codex',
      sandbox: 'workspace-write',
      model: 'gpt-5-mini',
      reasoning: 'low',
    },
    {
      input: {
        aiAgentCode: 'codex',
        modelCode: 'gpt-5.5',
        reasoningEffort: 'medium',
      },
    },
    '/repo',
    '/repo/.cyrboard/jobs/1-result.md',
  );

  assert.deepEqual(args.slice(-5), ['--model', 'gpt-5.5', '-c', 'model_reasoning_effort="medium"', '-']);
});

test('buildCodexArgs does not force network config for non workspace-write sandbox', () => {
  const args = buildCodexArgs(
    { sandbox: 'danger-full-access' },
    { input: {} },
    '/repo',
    '/repo/.cyrboard/jobs/1-result.md',
  );

  assert.equal(args.includes('sandbox_workspace_write.network_access=true'), false);
});

test('buildClaudeArgs uses local model when job agent does not match runner agent', () => {
  const args = buildClaudeArgs(
    {
      agent: 'claude',
      model: 'claude-sonnet-4-5',
      reasoning: 'xhigh',
    },
    {
      input: {
        aiAgentCode: 'codex',
        modelCode: 'gpt-5.5',
        reasoningEffort: 'medium',
      },
    },
    '/repo',
  );

  assert.equal(args.includes('gpt-5.5'), false);
  assert.deepEqual(args.slice(0, 7), [
    '--print',
    '--output-format',
    'text',
    '--permission-mode',
    'bypassPermissions',
    '--add-dir',
    '/repo',
  ]);
  assert.deepEqual(args.slice(-4), ['--model', 'claude-sonnet-4-5', '--effort', 'xhigh']);
});

test('buildClaudeArgs keeps matching job model override', () => {
  const args = buildClaudeArgs(
    {
      agent: 'claude',
      model: 'claude-sonnet-4-5',
      reasoning: 'high',
    },
    {
      input: {
        aiAgentCode: 'claude',
        modelCode: 'claude-opus-4-1',
        reasoningEffort: 'xhigh',
      },
    },
    '/repo',
  );

  assert.deepEqual(args.slice(-4), ['--model', 'claude-opus-4-1', '--effort', 'xhigh']);
});

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

test('prepareExecutionRepo infers a non-main default branch from the local repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cyrboard-agent-'));
  const originPath = join(root, 'origin.git');
  const sourcePath = join(root, 'source');

  try {
    await createRepositoryWithBaseBranch(originPath, sourcePath, 'master');

    const preparedPath = await prepareExecutionRepo(
      {},
      {
        id: 130,
        branchName: 'tracker/po-1/plan-test',
        input: {},
      },
      sourcePath,
    );

    assert.notEqual(preparedPath, sourcePath);
    assert.equal(await readFile(join(preparedPath, 'city.txt'), 'utf8'), 'master\n');
    assert.equal((await gitOutput(['branch', '--show-current'], preparedPath)).trim(), 'tracker/po-1/plan-test');
    assert.equal(await gitOutput(['rev-parse', '--verify', 'origin/master'], preparedPath), await gitOutput(['rev-parse', 'HEAD'], preparedPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prepareExecutionRepo reports a clear error when no base branch can be inferred', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cyrboard-agent-'));
  const originPath = join(root, 'origin.git');
  const sourcePath = join(root, 'source');

  try {
    await git(['init', '--bare', originPath], root);
    await git(['clone', originPath, sourcePath], root);

    await assert.rejects(
      () => prepareExecutionRepo(
        {},
        {
          id: 131,
          branchName: 'tracker/po-1/plan-empty',
          input: {},
        },
        sourcePath,
      ),
      /Cannot resolve base branch for this local runner job/,
    );
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

test('finalizeExecutionRepo reports git diagnostics when child branch merge remains unresolved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cyrboard-agent-'));
  const originPath = join(root, 'origin.git');
  const sourcePath = join(root, 'source');

  try {
    await createMainRepository(originPath, sourcePath);

    await git(['switch', '-c', 'tracker/cott-120/epic-1'], sourcePath);
    await writeFile(join(sourcePath, 'city.txt'), 'main\nepic\n');
    await git(['commit', '-am', 'Epic change'], sourcePath);
    await git(['push', '-u', 'origin', 'tracker/cott-120/epic-1'], sourcePath);

    await git(['switch', 'main'], sourcePath);
    await git(['switch', '-c', 'tracker/cott-121/dev-child'], sourcePath);
    await writeFile(join(sourcePath, 'city.txt'), 'main\nchild\n');
    await git(['commit', '-am', 'Child change'], sourcePath);
    await git(['push', '-u', 'origin', 'tracker/cott-121/dev-child'], sourcePath);
    await git(['switch', 'main'], sourcePath);

    const job = {
      id: 129,
      jobKind: 'merge_repair',
      branchName: 'tracker/cott-120/epic-1',
      promptText: [
        'Child branches to finish merging:',
        '- COTT-121: tracker/cott-121/dev-child',
      ].join('\n'),
      input: { codexCloudBaseBranch: 'main', issueKey: 'COTT-120' },
    };
    const preparedPath = await prepareExecutionRepo({}, job, sourcePath);

    await assert.rejects(
      () => finalizeExecutionRepo({}, job, preparedPath),
      (error) => {
        assert.match(error.message, /Merge conflict remains unresolved for child branch tracker\/cott-121\/dev-child/);
        assert.match(error.message, /Runner git diagnostics:/);
        assert.match(error.message, /git status --porcelain:/);
        assert.match(error.message, /UU city\.txt/);
        assert.match(error.message, /git diff --name-only --diff-filter=U:/);
        assert.match(error.message, /city\.txt/);

        return true;
      },
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

test('runAgent continues agent runs for sequential epic merge conflicts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cyrboard-agent-'));
  const originPath = join(root, 'origin.git');
  const sourcePath = join(root, 'source');
  const verifyPath = join(root, 'verify');
  const fakeBinPath = join(root, 'bin');
  const fakeCodexPath = join(fakeBinPath, 'codex');
  const counterPath = join(root, 'codex-count');
  const originalPath = process.env.PATH;

  try {
    await createMainRepository(originPath, sourcePath);

    await git(['switch', '-c', 'tracker/cott-201/alpha'], sourcePath);
    await writeFile(join(sourcePath, 'city.txt'), 'main\nalpha\n');
    await git(['commit', '-am', 'Alpha child'], sourcePath);
    await git(['push', '-u', 'origin', 'tracker/cott-201/alpha'], sourcePath);

    await git(['switch', 'main'], sourcePath);
    await git(['switch', '-c', 'tracker/cott-202/beta'], sourcePath);
    await writeFile(join(sourcePath, 'city.txt'), 'main\nbeta\n');
    await git(['commit', '-am', 'Beta child'], sourcePath);
    await git(['push', '-u', 'origin', 'tracker/cott-202/beta'], sourcePath);

    await git(['switch', 'main'], sourcePath);
    await git(['switch', '-c', 'tracker/cott-203/gamma'], sourcePath);
    await writeFile(join(sourcePath, 'city.txt'), 'main\ngamma\n');
    await git(['commit', '-am', 'Gamma child'], sourcePath);
    await git(['push', '-u', 'origin', 'tracker/cott-203/gamma'], sourcePath);
    await git(['switch', 'main'], sourcePath);

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
        `count_file='${counterPath}'`,
        'count=0',
        'if [ -f "$count_file" ]; then count="$(cat "$count_file")"; fi',
        'count=$((count + 1))',
        'printf "%s" "$count" > "$count_file"',
        'if [ "$count" = "1" ]; then',
        '  printf "main\\nalpha\\nbeta\\n" > city.txt',
        'else',
        '  printf "main\\nalpha\\nbeta\\ngamma\\n" > city.txt',
        'fi',
        'printf "resolved merge run %s\\n" "$count" > "$result_path"',
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
        id: 128,
        projectId: 1,
        issueId: 200,
        jobKind: 'review',
        commandId: 'test-epic-review',
        branchName: 'tracker/cott-200/epic-1',
        promptText: [
          'Child issues to verify:',
          '- COTT-201: tracker/cott-201/alpha',
          '- COTT-202: tracker/cott-202/beta',
          '- COTT-203: tracker/cott-203/gamma',
        ].join('\n'),
        input: { codexCloudBaseBranch: 'main', issueKey: 'COTT-200' },
      },
      sourcePath,
    );

    assert.match(result.resultText, /Agent run #1:/);
    assert.match(result.resultText, /Agent run #2:/);
    assert.match(result.resultText, /Runner pushed branch tracker\/cott-200\/epic-1/);
    assert.equal(await readFile(counterPath, 'utf8'), '2');

    await git(['clone', originPath, verifyPath], root);
    await git(['switch', 'tracker/cott-200/epic-1'], verifyPath);
    assert.equal(await readFile(join(verifyPath, 'city.txt'), 'utf8'), 'main\nalpha\nbeta\ngamma\n');
    await git(['fetch', 'origin'], verifyPath);
    await git(['merge-base', '--is-ancestor', 'origin/tracker/cott-201/alpha', 'HEAD'], verifyPath);
    await git(['merge-base', '--is-ancestor', 'origin/tracker/cott-202/beta', 'HEAD'], verifyPath);
    await git(['merge-base', '--is-ancestor', 'origin/tracker/cott-203/gamma', 'HEAD'], verifyPath);
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
  await createRepositoryWithBaseBranch(originPath, sourcePath, 'main');
}

async function createRepositoryWithBaseBranch(originPath, sourcePath, baseBranch) {
  const rootPath = dirname(originPath);

  await git(['init', '--bare', originPath], rootPath);
  await git(['clone', originPath, sourcePath], rootPath);
  await git(['config', 'user.name', 'Cyrboard Test'], sourcePath);
  await git(['config', 'user.email', 'test@example.com'], sourcePath);
  await git(['switch', '-c', baseBranch], sourcePath);
  await writeFile(join(sourcePath, 'city.txt'), `${baseBranch}\n`);
  await writeFile(join(sourcePath, '.gitignore'), '.cyrboard/\n');
  await git(['add', 'city.txt', '.gitignore'], sourcePath);
  await git(['commit', '-m', `Initial ${baseBranch}`], sourcePath);
  await git(['push', '-u', 'origin', baseBranch], sourcePath);
}
