import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runProcess } from './process.js';

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

  if (config.agent === 'command') {
    return runCommandAgent(config, job, repoPath, promptPath, resultPath);
  }

  throw new Error(`Unsupported agent mode: ${config.agent}`);
}

function buildPrompt(job) {
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
  ].join('\n');
}

async function runCodexAgent(config, job, repoPath, promptPath, resultPath) {
  const args = [
    'exec',
    '--cd',
    repoPath,
    '--skip-git-repo-check',
    '--sandbox',
    config.sandbox || 'workspace-write',
    '--output-last-message',
    resultPath,
    '-',
  ];
  const env = buildJobEnv(config, job, promptPath, resultPath);
  const prompt = await import('node:fs/promises').then((fs) => fs.readFile(promptPath, 'utf8'));
  const result = await runWithInput('codex', args, prompt, { cwd: repoPath, env });

  return {
    summary: trimSummary(result.stdout || result.stderr || `Codex completed job #${job.id}.`),
    resultPath,
  };
}

async function runCommandAgent(config, job, repoPath, promptPath, resultPath) {
  if (!config.command) {
    throw new Error('Command agent requires --command.');
  }

  const env = buildJobEnv(config, job, promptPath, resultPath);
  const result = await runProcess(config.command, [], {
    cwd: repoPath,
    env,
    shell: true,
  });

  return {
    summary: trimSummary(result.stdout || `Command agent completed job #${job.id}.`),
    resultPath,
  };
}

function buildJobEnv(config, job, promptPath, resultPath) {
  return {
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
    child.on('error', reject);
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
