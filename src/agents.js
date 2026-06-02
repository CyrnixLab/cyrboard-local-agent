import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function runAgent(config, job, repoPath) {
  const workspaceDir = resolve(repoPath, '.cyrboard', 'jobs');
  const promptPath = resolve(workspaceDir, `${job.id}-prompt.md`);
  const resultPath = resolve(workspaceDir, `${job.id}-result.md`);
  const prompt = buildPrompt(job);

  await mkdir(workspaceDir, { recursive: true, mode: 0o700 });
  await writeFile(promptPath, prompt, { mode: 0o600 });

  if (config.agent === 'codex') {
    return runCodexAgent(config, job, repoPath, promptPath, resultPath);
  }

  if (config.agent === 'claude') {
    return runClaudeAgent(config, job, repoPath, promptPath, resultPath);
  }

  throw new Error(`Unsupported agent mode: ${config.agent}`);
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

  return {
    summary: trimSummary(result.stdout || result.stderr || `Codex completed job #${job.id}.`),
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

  return {
    summary: trimSummary(result.stdout || result.stderr || `Claude completed job #${job.id}.`),
    resultPath,
  };
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
      stdout += chunk.toString();
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
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

function formatMissingCommandMessage(command) {
  if (command === 'codex') {
    return 'Codex CLI not found. Install Codex CLI and make sure `codex` is available in PATH for the terminal that runs cyrboard-local-agent.';
  }

  if (command === 'claude') {
    return 'Claude Code CLI not found. Install Claude Code and make sure `claude` is available in PATH for the terminal that runs cyrboard-local-agent.';
  }

  return `${command} command not found. Make sure it is installed and available in PATH.`;
}
