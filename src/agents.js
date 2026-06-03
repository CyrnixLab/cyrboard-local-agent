import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { redactSecrets } from './redact.js';

export async function runAgent(config, job, repoPath) {
  const workspaceDir = resolve(repoPath, '.cyrboard', 'jobs');
  const promptPath = resolve(workspaceDir, `${job.id}-prompt.md`);
  const resultPath = resolve(workspaceDir, `${job.id}-result.md`);
  const executionRepoPath = await prepareExecutionRepo(config, job, repoPath);
  const prompt = buildPrompt(job);

  await mkdir(workspaceDir, { recursive: true, mode: 0o700 });
  await writeFile(promptPath, prompt, { mode: 0o600 });

  if (config.agent === 'codex') {
    return runCodexAgent(config, job, executionRepoPath, promptPath, resultPath);
  }

  if (config.agent === 'claude') {
    return runClaudeAgent(config, job, executionRepoPath, promptPath, resultPath);
  }

  throw new Error(`Unsupported agent mode: ${config.agent}`);
}

export async function prepareExecutionRepo(config, job, repoPath) {
  const branchName = typeof job.branchName === 'string' ? job.branchName.trim() : '';

  if (branchName === '' || config.branchIsolation === false) {
    return repoPath;
  }

  const remoteUrl = await gitOutput(repoPath, ['remote', 'get-url', 'origin']);
  const worktreePath = resolve(repoPath, '.cyrboard', 'worktrees', String(job.id));

  await rm(worktreePath, { recursive: true, force: true });
  await mkdir(dirname(worktreePath), { recursive: true, mode: 0o700 });
  await runCommand('git', ['clone', '--no-tags', remoteUrl, worktreePath], { cwd: repoPath, silent: true });
  await copyGitIdentity(repoPath, worktreePath);

  if (await gitSucceeds(worktreePath, ['ls-remote', '--exit-code', '--heads', 'origin', branchName])) {
    await runCommand('git', ['fetch', 'origin', `${branchName}:refs/remotes/origin/${branchName}`], { cwd: worktreePath, silent: true });
    await runCommand('git', ['switch', '-c', branchName, `origin/${branchName}`], { cwd: worktreePath, silent: true });

    return worktreePath;
  }

  const baseBranch = resolveBaseBranch(config, job);
  await runCommand('git', ['fetch', 'origin', baseBranch], { cwd: worktreePath, silent: true });
  await runCommand('git', ['switch', '-c', branchName, `origin/${baseBranch}`], { cwd: worktreePath, silent: true });

  return worktreePath;
}

function buildPrompt(job) {
  const mcpLines = [];

  if (job.mcp?.endpoint && job.mcp?.token) {
    mcpLines.push(
      '## Tracker MCP',
      '',
      `Endpoint: ${job.mcp.endpoint}`,
      `Scopes: ${(job.mcp.scopes || []).join(', ') || '-'}`,
      `Token env: CYRBOARD_MCP_TOKEN`,
      '',
      'Use Tracker MCP when you need to read the tracker state or propose/apply tracker changes for this job.',
      'Call it as JSON-RPC over HTTP POST with `Authorization: Bearer $CYRBOARD_MCP_TOKEN`.',
      'Do not print the token in logs, comments, artifacts, or commits.',
      '',
    );
  }

  return [
    `# Cyrboard Tracker Job #${job.id}`,
    '',
    `Project ID: ${job.projectId}`,
    `Issue ID: ${job.issueId}`,
    `Job kind: ${job.jobKind}`,
    `Command ID: ${job.commandId}`,
    `Branch: ${job.branchName || '-'}`,
    '',
    '## Prompt',
    '',
    job.promptText || '',
    '',
    '## Input',
    '',
    '```json',
    JSON.stringify(job.input || {}, null, 2),
    '```',
    '',
    ...mcpLines,
  ].join('\n');
}

async function runCodexAgent(config, job, repoPath, promptPath, resultPath) {
  const command = 'codex';
  const args = [
    'exec',
    '--cd',
    repoPath,
    '--skip-git-repo-check',
    '--sandbox',
    config.sandbox || 'workspace-write',
    '--output-last-message',
    resultPath,
  ];

  const model = resolveModel(config, job);
  const reasoning = resolveReasoning(config, job);

  if (model) {
    args.push('--model', model);
  }

  if (reasoning) {
    args.push('-c', `model_reasoning_effort="${reasoning}"`);
  }

  args.push('-');

  const env = buildJobEnv(config, job, promptPath, resultPath);
  const prompt = await import('node:fs/promises').then((fs) => fs.readFile(promptPath, 'utf8'));
  const result = await runWithInput(command, args, prompt, { cwd: repoPath, env });
  const resultText = redactSecrets(await readResultText(resultPath, result.stdout || result.stderr || ''));

  return {
    summary: redactSecrets(trimSummary(result.stdout || result.stderr || `Codex completed job #${job.id}.`)),
    resultText,
    resultPath,
  };
}

async function runClaudeAgent(config, job, repoPath, promptPath, resultPath) {
  const command = 'claude';
  const args = [
    '--print',
    '--output-format',
    'text',
    '--permission-mode',
    config.permissionMode || 'acceptEdits',
    '--add-dir',
    repoPath,
  ];

  const model = resolveModel(config, job);
  const reasoning = resolveReasoning(config, job);

  if (model) {
    args.push('--model', model);
  }

  if (reasoning) {
    args.push('--effort', reasoning);
  }

  const env = buildJobEnv(config, job, promptPath, resultPath);
  const prompt = await import('node:fs/promises').then((fs) => fs.readFile(promptPath, 'utf8'));
  const result = await runWithInput(command, args, prompt, { cwd: repoPath, env });

  await import('node:fs/promises').then((fs) => fs.writeFile(resultPath, result.stdout || '', { mode: 0o600 }));
  const resultText = redactSecrets(await readResultText(resultPath, result.stdout || result.stderr || ''));

  return {
    summary: redactSecrets(trimSummary(result.stdout || result.stderr || `Claude completed job #${job.id}.`)),
    resultText,
    resultPath,
  };
}

async function readResultText(resultPath, fallback) {
  try {
    const content = await readFile(resultPath, 'utf8');
    const normalized = String(content || '').trim();

    if (normalized !== '') {
      return normalized;
    }
  } catch {
    // Fall back to captured stdout/stderr when the CLI did not write the result file.
  }

  return String(fallback || '').trim();
}

function resolveBaseBranch(config, job) {
  const fromJob = job.input?.codexCloudBaseBranch;
  const fromConfig = config.baseBranch;
  const value = typeof fromJob === 'string' && fromJob.trim() !== '' ? fromJob : fromConfig;

  return typeof value === 'string' && value.trim() !== '' ? value.trim() : 'main';
}

async function copyGitIdentity(sourceRepoPath, targetRepoPath) {
  const userName = await gitOutputOrNull(sourceRepoPath, ['config', '--get', 'user.name']);
  const userEmail = await gitOutputOrNull(sourceRepoPath, ['config', '--get', 'user.email']);

  if (userName !== null) {
    await runCommand('git', ['config', 'user.name', userName], { cwd: targetRepoPath, silent: true });
  }

  if (userEmail !== null) {
    await runCommand('git', ['config', 'user.email', userEmail], { cwd: targetRepoPath, silent: true });
  }
}

async function gitSucceeds(repoPath, args) {
  try {
    await runCommand('git', args, { cwd: repoPath, silent: true });

    return true;
  } catch {
    return false;
  }
}

async function gitOutputOrNull(repoPath, args) {
  try {
    return await gitOutput(repoPath, args);
  } catch {
    return null;
  }
}

async function gitOutput(repoPath, args) {
  const result = await runCommand('git', args, { cwd: repoPath, silent: true });

  return String(result.stdout || '').trim();
}

function resolveModel(config, job) {
  const fromJob = job.input?.modelCode;
  const fromConfig = config.model;
  const value = typeof fromJob === 'string' && fromJob.trim() !== '' ? fromJob : fromConfig;

  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function resolveReasoning(config, job) {
  const fromJob = job.input?.reasoningEffort;
  const fromConfig = config.reasoning;
  const value = typeof fromJob === 'string' && fromJob.trim() !== '' ? fromJob : fromConfig;

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();

  return ['low', 'medium', 'high', 'xhigh'].includes(normalized) ? normalized : null;
}

function buildJobEnv(config, job, promptPath, resultPath) {
  const env = {
    ...process.env,
    CYRBOARD_SERVER: config.serverUrl,
    CYRBOARD_PROJECT_ID: String(job.projectId),
    CYRBOARD_ISSUE_ID: String(job.issueId),
    CYRBOARD_JOB_ID: String(job.id),
    CYRBOARD_JOB_KIND: String(job.jobKind || ''),
    CYRBOARD_BRANCH_NAME: String(job.branchName || ''),
    CYRBOARD_JOB_PROMPT_PATH: promptPath,
    CYRBOARD_JOB_RESULT_PATH: resultPath,
  };

  if (job.mcp?.endpoint && job.mcp?.token) {
    env.CYRBOARD_MCP_ENDPOINT = resolveMcpEndpoint(config.serverUrl, job.mcp.endpoint);
    env.CYRBOARD_MCP_TOKEN = String(job.mcp.token);
    env.CYRBOARD_MCP_TOKEN_ID = String(job.mcp.tokenId || '');
    env.CYRBOARD_MCP_SCOPES = (job.mcp.scopes || []).join(',');
    env.CYRBOARD_MCP_EXPIRES_AFTER_LAST_HEARTBEAT_SECONDS = String(job.mcp.expiresAfterLastHeartbeatSeconds || '');
  }

  return env;
}

function resolveMcpEndpoint(serverUrl, endpoint) {
  const normalizedEndpoint = String(endpoint || '').trim();

  if (normalizedEndpoint.startsWith('http://') || normalizedEndpoint.startsWith('https://')) {
    return normalizedEndpoint;
  }

  return new URL(normalizedEndpoint || '/tracker/mcp', `${String(serverUrl).replace(/\/+$/, '')}/`).toString();
}

function trimSummary(value) {
  const normalized = String(value || '').trim();

  if (normalized.length <= 2000) {
    return normalized;
  }

  return `${normalized.slice(0, 1997)}...`;
}

async function runWithInput(command, args, input, options = {}) {
  const { spawn } = await import('node:child_process');

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const value = chunk.toString();
      stdout += value;
      process.stdout.write(redactSecrets(value));
    });
    child.stderr.on('data', (chunk) => {
      const value = chunk.toString();
      stderr += value;
      process.stderr.write(redactSecrets(value));
    });
    child.on('error', (error) => {
      if (error?.code === 'ENOENT') {
        reject(new Error(formatMissingCommandMessage(command)));
        return;
      }

      reject(error);
    });
    child.on('close', (code) => {
      const result = { code: code ?? 0, stdout, stderr };

      if (result.code === 0) {
        resolve(result);
        return;
      }

      const error = new Error(`${command} exited with code ${result.code}.`);
      error.result = result;
      reject(error);
    });
    child.stdin.end(input);
  });
}

async function runCommand(command, args, options = {}) {
  const { spawn } = await import('node:child_process');

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const value = chunk.toString();
      stdout += value;

      if (!options.silent) {
        process.stdout.write(redactSecrets(value));
      }
    });
    child.stderr.on('data', (chunk) => {
      const value = chunk.toString();
      stderr += value;

      if (!options.silent) {
        process.stderr.write(redactSecrets(value));
      }
    });
    child.on('error', (error) => {
      if (error?.code === 'ENOENT') {
        reject(new Error(formatMissingCommandMessage(command)));
        return;
      }

      reject(error);
    });
    child.on('close', (code) => {
      const result = { code: code ?? 0, stdout, stderr };

      if (result.code === 0) {
        resolve(result);
        return;
      }

      const error = new Error(redactSecrets(`${command} ${args.join(' ')} exited with code ${result.code}: ${stderr || stdout}`));
      error.result = result;
      reject(error);
    });
  });
}

function formatMissingCommandMessage(command) {
  if (command === 'codex') {
    return 'Codex CLI not found. Install Codex CLI and make sure `codex` is available in PATH for the terminal that runs cyrboard-local-agent.';
  }

  if (command === 'claude') {
    return 'Claude Code CLI not found. Install Claude Code and make sure `claude` is available in PATH for the terminal that runs cyrboard-local-agent.';
  }

  return `${command} command not found. Make sure it is installed and available in PATH.`;
}
