import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { redactSecrets } from './redact.js';
import { verifyInputAttachments } from './attachments.js';

const DEFAULT_MAX_MERGE_CONFLICT_AGENT_RUNS = 5;

class MergeConflictNeedsAgentError extends Error {
  constructor(childBranch, message, partialResult, diagnostics = '') {
    super(message);
    this.name = 'MergeConflictNeedsAgentError';
    this.childBranch = childBranch;
    this.partialResult = partialResult;
    this.diagnostics = diagnostics;
  }
}

export async function runAgent(config, job, repoPath, inputAttachments = { directory: null, files: [] }) {
  const workspaceDir = resolve(repoPath, '.cyrboard', 'jobs');
  const promptPath = resolve(workspaceDir, `${job.id}-prompt.md`);
  const resultPath = resolve(workspaceDir, `${job.id}-result.md`);
  const executionRepoPath = await prepareExecutionRepo(config, job, repoPath);
  const prepareResult = await prepareJobGitState(config, job, executionRepoPath);
  let prompt = buildPrompt(job, inputAttachments);

  await mkdir(workspaceDir, { recursive: true, mode: 0o700 });

  const agentResults = [];
  const partialFinalizeResults = [];
  const maxMergeConflictAgentRuns = resolveMaxMergeConflictAgentRuns(config);

  for (let attempt = 1; attempt <= maxMergeConflictAgentRuns; attempt += 1) {
    await verifyInputAttachments(inputAttachments.files);
    await writeFile(promptPath, prompt, { mode: 0o600 });
    const result = await runConfiguredAgent(config, job, executionRepoPath, promptPath, resultPath, inputAttachments);
    await verifyInputAttachments(inputAttachments.files);
    agentResults.push(result);

    try {
      const finalizeResult = await finalizeExecutionRepo(config, job, executionRepoPath);
      const combinedFinalizeResult = combineFinalizeResults([...partialFinalizeResults, finalizeResult]);

      return appendGitResult(combineAgentResults(agentResults), prepareResult, combinedFinalizeResult);
    } catch (error) {
      if (!(error instanceof MergeConflictNeedsAgentError) || attempt >= maxMergeConflictAgentRuns) {
        throw error;
      }

      partialFinalizeResults.push(error.partialResult);
      prompt = [
        buildMergeConflictContinuationPrompt(job, error, attempt + 1),
        buildAttachmentPrompt(inputAttachments),
      ].filter(Boolean).join('\n\n');
    }
  }

  throw new Error(`Merge conflict was not resolved after ${maxMergeConflictAgentRuns} agent runs.`);
}

async function runConfiguredAgent(config, job, executionRepoPath, promptPath, resultPath, inputAttachments) {
  if (config.agent === 'codex') {
    return await runCodexAgent(config, job, executionRepoPath, promptPath, resultPath, inputAttachments);
  }

  if (config.agent === 'claude') {
    return await runClaudeAgent(config, job, executionRepoPath, promptPath, resultPath);
  }

  if (config.agent === 'sourcecraft') {
    return await runSourceCraftAgent(config, job, executionRepoPath, promptPath, resultPath);
  }

  if (config.agent === 'gigacode') {
    return await runGigaCodeAgent(config, job, executionRepoPath, promptPath, resultPath);
  }

  throw new Error(`Unsupported agent mode: ${config.agent}`);
}

export async function prepareJobGitState(config, job, repoPath) {
  const branchName = normalizeBranchName(job.branchName);

  if (branchName === '' || config.branchIsolation === false) {
    return { mergedBranches: [], conflicts: [], remoteBranchCreated: false, requiredAncestorBranchesMerged: [], requiredAncestorBranchConflicts: [] };
  }

  const remoteBranchCreated = await ensureRemoteBranch(repoPath, branchName);
  const childBranches = parseChildBranches(job.promptText || '').filter((childBranch) => childBranch !== branchName);
  const shouldMergeRequiredAncestorBranches = job.jobKind !== 'merge_to_epic';
  const requiredAncestorBranches = shouldMergeRequiredAncestorBranches
    ? resolveRequiredAncestorBranches(job).filter((ancestorBranch) => ancestorBranch !== branchName)
    : [];
  const mergedBranches = [];
  const conflicts = [];
  const requiredAncestorBranchesMerged = [];
  const requiredAncestorBranchConflicts = [];

  for (const ancestorBranch of requiredAncestorBranches) {
    await fetchRemoteBranch(repoPath, ancestorBranch);

    if (await gitSucceeds(repoPath, ['merge-base', '--is-ancestor', `origin/${ancestorBranch}`, 'HEAD'])) {
      continue;
    }

    try {
      await runCommand('git', ['merge', '--no-edit', `origin/${ancestorBranch}`], { cwd: repoPath, silent: true });
      requiredAncestorBranchesMerged.push(ancestorBranch);
    } catch (error) {
      requiredAncestorBranchConflicts.push(ancestorBranch);
      break;
    }
  }

  if (requiredAncestorBranchConflicts.length > 0) {
    return { mergedBranches, conflicts, remoteBranchCreated, requiredAncestorBranchesMerged, requiredAncestorBranchConflicts };
  }

  for (const childBranch of childBranches) {
    await fetchRemoteBranch(repoPath, childBranch);

    try {
      await runCommand('git', ['merge', '--no-edit', `origin/${childBranch}`], { cwd: repoPath, silent: true });
      mergedBranches.push(childBranch);
    } catch (error) {
      conflicts.push(childBranch);
      break;
    }
  }

  return { mergedBranches, conflicts, remoteBranchCreated, requiredAncestorBranchesMerged, requiredAncestorBranchConflicts };
}

export async function finalizeExecutionRepo(config, job, repoPath) {
  const branchName = normalizeBranchName(job.branchName);

  if (branchName === '' || config.branchIsolation === false) {
    return { pushed: false, committed: false, commitSha: null, branchName: null, mergedBranches: [] };
  }

  await runCommand('git', ['fetch', 'origin', branchName], { cwd: repoPath, silent: true }).catch(() => {});
  const initialRemoteSha = await gitOutputOrNull(repoPath, ['rev-parse', `origin/${branchName}`]);

  const partialResult = {
    pushed: false,
    committed: false,
    commitSha: null,
    branchName,
    mergedBranches: [],
  };

  await stageAndCommitResolvedState(repoPath, job, partialResult);
  const mergeResult = await mergeUnmergedChildBranches(job, repoPath, branchName, partialResult);
  partialResult.mergedBranches.push(...mergeResult.mergedBranches);
  await stageAndCommitResolvedState(repoPath, job, partialResult);
  const commitSha = await gitOutput(repoPath, ['rev-parse', 'HEAD']);
  partialResult.commitSha = commitSha;

  if (initialRemoteSha === commitSha) {
    return partialResult;
  }

  await runCommand('git', ['push', 'origin', `HEAD:${branchName}`], { cwd: repoPath, silent: true });
  partialResult.pushed = true;

  return partialResult;
}

async function stageAndCommitResolvedState(repoPath, job, partialResult) {
  await assertNoConflictMarkers(repoPath);
  await runCommand('git', ['add', '-A'], { cwd: repoPath, silent: true });
  await assertNoUnmergedFiles(repoPath);

  if (await gitSucceeds(repoPath, ['diff', '--cached', '--quiet'])) {
    return;
  }

  await runCommand('git', ['commit', '-m', buildCommitMessage(job)], { cwd: repoPath, silent: true });
  partialResult.committed = true;
  partialResult.commitSha = await gitOutput(repoPath, ['rev-parse', 'HEAD']);
}

function appendGitResult(result, prepareResult, finalizeResult) {
  const lines = [];
  const mergedBranches = [
    ...(prepareResult.mergedBranches || []),
    ...(finalizeResult.mergedBranches || []),
  ];

  if (prepareResult.remoteBranchCreated) {
    lines.push(`Remote branch created: ${finalizeResult.branchName || 'unknown'}`);
  }

  if (mergedBranches.length > 0) {
    lines.push(`Child branches merged: ${[...new Set(mergedBranches)].join(', ')}`);
  }

  if ((prepareResult.requiredAncestorBranchesMerged || []).length > 0) {
    lines.push(`Required predecessor branches merged before agent run: ${[...new Set(prepareResult.requiredAncestorBranchesMerged)].join(', ')}`);
  }

  if ((prepareResult.conflicts || []).length > 0) {
    lines.push(`Merge conflicts prepared for agent resolution: ${prepareResult.conflicts.join(', ')}`);
  }

  if ((prepareResult.requiredAncestorBranchConflicts || []).length > 0) {
    lines.push(`Required predecessor merge conflicts prepared for agent resolution: ${prepareResult.requiredAncestorBranchConflicts.join(', ')}`);
  }

  if (finalizeResult.committed) {
    lines.push(`Runner finalized commit: ${finalizeResult.commitSha}`);
  }

  if (finalizeResult.pushed) {
    lines.push(`Runner pushed branch ${finalizeResult.branchName}: ${finalizeResult.commitSha}`);
  }

  if (lines.length === 0) {
    return result;
  }

  const gitNote = ['Runner git finalization:', ...lines.map((line) => `- ${line}`)].join('\n');

  return {
    ...result,
    summary: redactSecrets(trimSummary([result.summary, gitNote].filter(Boolean).join('\n\n'))),
    resultText: redactSecrets([result.resultText, gitNote].filter(Boolean).join('\n\n')),
  };
}

function combineAgentResults(results) {
  if (results.length === 1) {
    return results[0];
  }

  const latest = results[results.length - 1];
  const resultText = results
    .map((result, index) => [`Agent run #${index + 1}:`, result.resultText || result.summary || ''].join('\n'))
    .join('\n\n');

  return {
    ...latest,
    summary: latest.summary,
    resultText: redactSecrets(resultText),
  };
}

function combineFinalizeResults(results) {
  const latest = results[results.length - 1] || {};
  const mergedBranches = [];

  for (const result of results) {
    for (const branchName of result?.mergedBranches || []) {
      if (!mergedBranches.includes(branchName)) {
        mergedBranches.push(branchName);
      }
    }
  }

  return {
    pushed: Boolean(latest.pushed),
    committed: results.some((result) => result?.committed),
    commitSha: latest.commitSha || null,
    branchName: latest.branchName || null,
    mergedBranches,
  };
}

function resolveMaxMergeConflictAgentRuns(config) {
  const value = Number(config.maxMergeConflictAgentRuns ?? config.mergeConflictAgentRuns ?? DEFAULT_MAX_MERGE_CONFLICT_AGENT_RUNS);

  if (!Number.isFinite(value) || value < 1) {
    return DEFAULT_MAX_MERGE_CONFLICT_AGENT_RUNS;
  }

  return Math.floor(value);
}

function normalizeBranchName(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePromptBranchName(value) {
  return normalizeBranchName(value).replace(/[.,;:)\]}]+$/g, '');
}

async function ensureRemoteBranch(repoPath, branchName) {
  if (await gitSucceeds(repoPath, ['ls-remote', '--exit-code', '--heads', 'origin', branchName])) {
    return false;
  }

  await runCommand('git', ['push', 'origin', `HEAD:${branchName}`], { cwd: repoPath, silent: true });

  return true;
}

async function fetchRemoteBranch(repoPath, branchName) {
  await runCommand('git', ['fetch', 'origin', `${branchName}:refs/remotes/origin/${branchName}`], { cwd: repoPath, silent: true });
}

export function resolveRequiredAncestorBranches(job) {
  const branches = new Set();
  const value = job?.input?.requiredAncestorBranches;

  if (!Array.isArray(value)) {
    return [];
  }

  for (const branchNameValue of value) {
    const branchName = normalizePromptBranchName(branchNameValue);

    if (branchName !== '') {
      branches.add(branchName);
    }
  }

  return [...branches];
}

function parseChildBranches(promptText) {
  const branches = new Set();

  for (const line of String(promptText || '').split(/\r?\n/)) {
    const match = line.match(/^\s*-\s+[^:]+:\s+(tracker\/[^\s]+)\s*$/);

    if (match) {
      const branchName = normalizePromptBranchName(match[1]);

      if (branchName !== '') {
        branches.add(branchName);
      }
    }
  }

  return [...branches];
}

async function assertRemoteBranchContainsRequiredAncestors(job, repoPath, targetBranch) {
  const requiredAncestorBranches = resolveRequiredAncestorBranches(job).filter((ancestorBranch) => ancestorBranch !== targetBranch);
  const missingBranches = [];

  for (const ancestorBranch of requiredAncestorBranches) {
    await fetchRemoteBranch(repoPath, ancestorBranch);

    if (await gitSucceeds(repoPath, ['merge-base', '--is-ancestor', `origin/${ancestorBranch}`, `origin/${targetBranch}`])) {
      continue;
    }

    missingBranches.push(ancestorBranch);
  }

  if (missingBranches.length > 0) {
    throw new Error([
      `Child branch ${targetBranch} is missing required predecessor branches: ${missingBranches.join(', ')}.`,
      'Retry the child task so the runner can merge predecessor branches into the task branch before implementation, then run merge-to-epic again.',
    ].join(' '));
  }
}

async function mergeUnmergedChildBranches(job, repoPath, branchName, partialResult) {
  const childBranches = parseChildBranches(job.promptText || '').filter((childBranch) => childBranch !== branchName);
  const mergedBranches = [];

  for (const childBranch of childBranches) {
    await fetchRemoteBranch(repoPath, childBranch);
    await assertRemoteBranchContainsRequiredAncestors(job, repoPath, childBranch);

    if (await gitSucceeds(repoPath, ['merge-base', '--is-ancestor', `origin/${childBranch}`, 'HEAD'])) {
      continue;
    }

    try {
      await runCommand('git', ['merge', '--no-edit', `origin/${childBranch}`], { cwd: repoPath, silent: true });
      mergedBranches.push(childBranch);
      partialResult.mergedBranches.push(childBranch);
      partialResult.committed = true;
      partialResult.commitSha = await gitOutput(repoPath, ['rev-parse', 'HEAD']);
    } catch (error) {
      const diagnostics = await buildMergeConflictDiagnostics(repoPath);
      throw new MergeConflictNeedsAgentError(
        childBranch,
        [
          `Merge conflict remains unresolved for child branch ${childBranch}. ${error.message}`,
          diagnostics,
        ].filter(Boolean).join('\n\n'),
        { ...partialResult, mergedBranches: [...partialResult.mergedBranches] },
        diagnostics,
      );
    }
  }

  return { mergedBranches };
}

async function assertNoConflictMarkers(repoPath) {
  const changedFiles = await listChangedWorkingTreeFiles(repoPath);
  const conflictFiles = [];
  const conflictBlockPattern = /^<<<<<<<[^\n]*\n[\s\S]*?^=======$[\s\S]*?^>>>>>>>[^\n]*$/m;

  for (const file of changedFiles) {
    const content = await readFile(resolve(repoPath, file), 'utf8').catch(() => '');

    if (conflictBlockPattern.test(content)) {
      conflictFiles.push(file);
    }
  }

  if (conflictFiles.length > 0) {
    throw new Error(`Merge conflict markers remain in files:\n${conflictFiles.join('\n')}`);
  }
}

async function assertNoUnmergedFiles(repoPath) {
  const unmergedFiles = await gitOutput(repoPath, ['diff', '--name-only', '--diff-filter=U']);

  if (unmergedFiles !== '') {
    throw new Error(`Merge conflict remains unresolved in files:\n${unmergedFiles}`);
  }
}

async function buildMergeConflictDiagnostics(repoPath) {
  const status = await gitOutputOrNull(repoPath, ['status', '--porcelain']);
  const unmergedFiles = await gitOutputOrNull(repoPath, ['diff', '--name-only', '--diff-filter=U']);
  const stagedFiles = await gitOutputOrNull(repoPath, ['diff', '--cached', '--name-only']);
  const parts = ['Runner git diagnostics:'];

  parts.push('git status --porcelain:');
  parts.push(status && status.trim() !== '' ? status : '(clean)');
  parts.push('git diff --name-only --diff-filter=U:');
  parts.push(unmergedFiles && unmergedFiles.trim() !== '' ? unmergedFiles : '(none)');
  parts.push('git diff --cached --name-only:');
  parts.push(stagedFiles && stagedFiles.trim() !== '' ? stagedFiles : '(none)');

  return parts.join('\n');
}

async function listChangedWorkingTreeFiles(repoPath) {
  const files = new Set();
  const output = await gitOutput(repoPath, ['status', '--porcelain']);

  for (const line of output.split('\n')) {
    const file = line.slice(3).trim();

    if (file !== '' && !file.includes(' -> ')) {
      files.add(file);
    }
  }

  for (const file of (await gitOutput(repoPath, ['diff', '--cached', '--name-only', '--diff-filter=ACMRT']))
    .split('\n')
    .map((file) => file.trim())
    .filter((file) => file !== '')) {
    files.add(file);
  }

  return [...files];
}

function buildMergeConflictContinuationPrompt(job, error, attempt) {
  return [
    `# Cyrboard Tracker Job #${job.id} merge conflict continuation #${attempt}`,
    '',
    `The previous agent run completed, but the runner hit another merge conflict while merging child branch: ${error.childBranch}.`,
    '',
    'Current worktree state:',
    '- The runner has already checked out the job branch.',
    '- Some child branches may already be merged and committed.',
    '- Conflict markers may be present in the current files.',
    '- Current diagnostics from the failed merge:',
    '',
    '```text',
    error.diagnostics || 'No git diagnostics captured.',
    '```',
    '',
    'Resolve the current conflict in the working tree.',
    'Preserve the behavior from all completed child branches listed in the original job prompt.',
    'Before final answer, make sure the worktree is ready for runner finalization:',
    '- no conflict markers remain in files;',
    '- `git status --porcelain` has no unresolved entries such as UU, AA, DD, AU, UD, DU, or UA;',
    '- after the runner stages changes, `git diff --name-only --diff-filter=U` must be empty.',
    'Run the relevant checks only after the merge state is resolved.',
    'Do not report checks as passed if unresolved merge files remain.',
    'Do not run `git add`, `git commit`, or `git push`; the runner will stage, commit, continue merging remaining child branches, and push after the CLI exits.',
    '',
    'If the conflict is not safely resolvable, the first line of your final answer must be exactly:',
    'MERGE_CONFLICT_UNRESOLVED',
    '',
    'Original job prompt:',
    '',
    job.promptText || '',
  ].join('\n');
}

function formatMcpEndpointForPrompt(job) {
  const endpoint = String(job.mcp?.endpoint || '').trim();

  if (endpoint === '') {
    return '-';
  }

  if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
    return endpoint;
  }

  return `${endpoint} (resolved full URL is available in CYRBOARD_MCP_ENDPOINT)`;
}

function buildCommitMessage(job) {
  const issueKey = typeof job.input?.issueKey === 'string' ? job.input.issueKey.trim() : '';
  const jobKind = typeof job.jobKind === 'string' && job.jobKind.trim() !== '' ? job.jobKind.trim() : 'job';

  if (issueKey !== '') {
    return `Cyrboard ${jobKind} ${issueKey} job ${job.id}`;
  }

  return `Cyrboard ${jobKind} job ${job.id}`;
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

  const baseBranch = await resolveBaseBranch(config, job, repoPath);
  await runCommand('git', ['fetch', 'origin', baseBranch], { cwd: worktreePath, silent: true });
  await runCommand('git', ['switch', '-c', branchName, `origin/${baseBranch}`], { cwd: worktreePath, silent: true });

  return worktreePath;
}

function buildPrompt(job, inputAttachments) {
  const mcpLines = [];
  const gitLines = [];

  if (normalizeBranchName(job.branchName) !== '') {
    gitLines.push(
      '## Runner Git Lifecycle',
      '',
      `The local runner checked out branch ${job.branchName} before starting this CLI session.`,
      'Edit files and run checks. Do not rely on git commit or git push from inside the CLI sandbox.',
      'After the CLI exits, the runner stages, validates, commits, and pushes the branch.',
      'For epic merge/review jobs, the runner may pre-merge child branches from this prompt. If conflict markers are present, resolve the file contents and leave the worktree ready to commit.',
      'Before final answer, make sure `git status --porcelain` has no unresolved entries such as UU, AA, DD, AU, UD, DU, or UA. Do not report checks as passed while unresolved merge files remain.',
      '',
    );
  }

  if (job.mcp?.endpoint && job.mcp?.token) {
    mcpLines.push(
      '## Tracker MCP',
      '',
      `Endpoint: ${formatMcpEndpointForPrompt(job)}`,
      `Scopes: ${(job.mcp.scopes || []).join(', ') || '-'}`,
      `Token env: CYRBOARD_MCP_TOKEN`,
      `Resolved endpoint env: CYRBOARD_MCP_ENDPOINT`,
      '',
      'Use Tracker MCP when you need to read the tracker state or propose/apply tracker changes for this job.',
      'Call the full URL in `CYRBOARD_MCP_ENDPOINT` as JSON-RPC over HTTP POST with `Authorization: Bearer $CYRBOARD_MCP_TOKEN`.',
      'Do not concatenate CYRBOARD_SERVER with CYRBOARD_MCP_ENDPOINT; the env value is already absolute.',
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
    ...gitLines,
    ...mcpLines,
    buildAttachmentPrompt(inputAttachments),
  ].join('\n');
}

function buildAttachmentPrompt(inputAttachments) {
  if (!inputAttachments || inputAttachments.files.length === 0) {
    return '';
  }

  return [
    '## User input attachments',
    '',
    'These verified files are immutable input supplied by the user. Inspect them as part of the request. Do not modify them.',
    ...inputAttachments.files.map((file) => `- ${file.filename} (${file.mediaType}, ${file.sizeBytes} bytes): ${file.path}`),
  ].join('\n');
}

async function runCodexAgent(config, job, repoPath, promptPath, resultPath, inputAttachments) {
  const command = 'codex';
  const args = buildCodexArgs(config, job, repoPath, resultPath, inputAttachments);
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

export function buildCodexArgs(config, job, repoPath, resultPath, inputAttachments = { directory: null, files: [] }) {
  const sandbox = config.sandbox || 'workspace-write';
  const args = [
    'exec',
    '--cd',
    repoPath,
    '--skip-git-repo-check',
    '--sandbox',
    sandbox,
    '--output-last-message',
    resultPath,
  ];

  if (shouldEnableCodexWorkspaceNetwork(config, sandbox)) {
    args.push('-c', 'sandbox_workspace_write.network_access=true');
  }

  const model = resolveModel(config, job);
  const reasoning = resolveReasoning(config, job);

  if (model) {
    args.push('--model', model);
  }

  if (reasoning) {
    args.push('-c', `model_reasoning_effort="${reasoning}"`);
  }

  if (inputAttachments.directory) {
    args.push('--add-dir', inputAttachments.directory);
  }

  for (const file of inputAttachments.files) {
    if (file.fileKind === 'image') {
      args.push('--image', file.path);
    }
  }

  args.push('-');

  return args;
}

function shouldEnableCodexWorkspaceNetwork(config, sandbox) {
  if (config.codexNetworkAccess === false || config.networkAccess === false) {
    return false;
  }

  return String(sandbox || '').trim() === 'workspace-write';
}

async function runClaudeAgent(config, job, repoPath, promptPath, resultPath) {
  const command = 'claude';
  const args = buildClaudeArgs(config, job, repoPath);
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

export function buildClaudeArgs(config, job, repoPath) {
  const args = [
    '--print',
    '--output-format',
    'text',
    '--permission-mode',
    config.permissionMode || 'bypassPermissions',
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

  return args;
}

async function runSourceCraftAgent(config, job, repoPath, promptPath, resultPath) {
  const command = 'src';
  const env = buildJobEnv(config, job, promptPath, resultPath);
  const prompt = await readFile(promptPath, 'utf8');
  const result = await runWithInput(command, buildSourceCraftArgs(config, job, prompt), '', {
    cwd: repoPath,
    env,
    quietStdout: true,
  });
  const finalText = parseSourceCraftJsonOutput(result.stdout);

  await writeFile(resultPath, finalText, { mode: 0o600 });
  const resultText = redactSecrets(finalText);

  return {
    summary: redactSecrets(trimSummary(finalText)),
    resultText,
    resultPath,
  };
}

export function buildSourceCraftArgs(config, job, prompt) {
  const normalizedPrompt = String(prompt || '').trim();

  if (normalizedPrompt === '') {
    throw new Error('SourceCraft prompt is empty.');
  }

  const args = ['code'];
  const model = resolveModel(config, job);

  if (model && ['ds', 'ds-alt', 'legacy'].includes(model)) {
    args.push('--model', model);
  }

  args.push(
    '--',
    'run',
    '--format',
    'json',
    '--dangerously-skip-permissions',
    normalizedPrompt,
  );

  return args;
}

export function parseSourceCraftJsonOutput(output) {
  const textByMessageId = new Map();
  const stoppedMessageIds = [];

  for (const rawLine of String(output || '').split(/\r?\n/)) {
    const jsonStart = rawLine.indexOf('{');

    if (jsonStart < 0) {
      continue;
    }

    let event;

    try {
      event = JSON.parse(rawLine.slice(jsonStart).trim());
    } catch {
      continue;
    }

    const part = event?.part;
    const messageId = typeof part?.messageID === 'string'
      ? part.messageID
      : (typeof part?.messageId === 'string' ? part.messageId : null);

    if (messageId === null) {
      continue;
    }

    if (event?.type === 'text' && part?.type === 'text' && typeof part.text === 'string') {
      const text = part.text.trim();

      if (text !== '') {
        const messageParts = textByMessageId.get(messageId) || [];
        messageParts.push(text);
        textByMessageId.set(messageId, messageParts);
      }
    }

    if (event?.type === 'step_finish' && part?.reason === 'stop') {
      stoppedMessageIds.push(messageId);
    }
  }

  for (const messageId of stoppedMessageIds.reverse()) {
    const finalText = (textByMessageId.get(messageId) || []).join('\n\n').trim();

    if (finalText !== '') {
      return finalText;
    }
  }

  throw new Error('SourceCraft did not return a final text response.');
}

async function runGigaCodeAgent(config, job, repoPath, promptPath, resultPath) {
  const command = 'gigacode';
  const env = buildJobEnv(config, job, promptPath, resultPath);
  const prompt = await readFile(promptPath, 'utf8');
  const result = await runWithInput(command, buildGigaCodeArgs(config, job, prompt), '', {
    cwd: repoPath,
    env,
  });
  const finalText = String(result.stdout || result.stderr || '').trim();

  if (finalText === '') {
    throw new Error('GigaCode did not return a final text response.');
  }

  await writeFile(resultPath, finalText, { mode: 0o600 });
  const resultText = redactSecrets(finalText);

  return {
    summary: redactSecrets(trimSummary(finalText)),
    resultText,
    resultPath,
  };
}

export function buildGigaCodeArgs(config, job, prompt) {
  const normalizedPrompt = String(prompt || '').trim();

  if (normalizedPrompt === '') {
    throw new Error('GigaCode prompt is empty.');
  }

  const args = [
    '--approval-mode=auto-edit',
    '--allowed-tools=run_shell_command',
  ];
  const model = resolveModel(config, job);

  if (model && model !== 'default') {
    args.push('--model', model);
  }

  args.push('-p', normalizedPrompt);

  return args;
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

async function resolveBaseBranch(config, job, repoPath) {
  const fromJob = job.input?.codexCloudBaseBranch;
  const fromConfig = config.baseBranch;
  const value = normalizeBaseBranchName(
    typeof fromJob === 'string' && fromJob.trim() !== '' ? fromJob : fromConfig,
  );

  if (value !== '') {
    return value;
  }

  const candidates = [];
  const originHead = await gitOutputOrNull(repoPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const upstreamBranch = await gitOutputOrNull(repoPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const currentBranch = await gitOutputOrNull(repoPath, ['branch', '--show-current']);

  addBaseBranchCandidate(candidates, originHead);
  addBaseBranchCandidate(candidates, upstreamBranch);
  addBaseBranchCandidate(candidates, currentBranch);

  for (const fallbackBranch of ['master', 'main', 'develop', 'dev', 'trunk']) {
    addBaseBranchCandidate(candidates, fallbackBranch);
  }

  for (const branchName of candidates) {
    if (await remoteBranchExists(repoPath, branchName)) {
      return branchName;
    }
  }

  throw new Error([
    'Cannot resolve base branch for this local runner job.',
    'Set the project base branch in AI executor settings, configure origin/HEAD,',
    'checkout a local branch that tracks origin, or create a default branch in the remote repository.',
  ].join(' '));
}

function addBaseBranchCandidate(candidates, value) {
  const branchName = normalizeBaseBranchName(value);

  if (branchName !== '' && !candidates.includes(branchName)) {
    candidates.push(branchName);
  }
}

function normalizeBaseBranchName(value) {
  if (typeof value !== 'string') {
    return '';
  }

  const normalized = value.trim()
    .replace(/^refs\/remotes\/origin\//, '')
    .replace(/^refs\/heads\//, '')
    .replace(/^origin\//, '');

  return normalized === 'HEAD' ? '' : normalized;
}

async function remoteBranchExists(repoPath, branchName) {
  return branchName !== ''
    && await gitSucceeds(repoPath, ['ls-remote', '--exit-code', '--heads', 'origin', branchName]);
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
  const value = shouldUseJobScopedModel(config, job) && typeof fromJob === 'string' && fromJob.trim() !== ''
    ? fromJob
    : fromConfig;

  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function shouldUseJobScopedModel(config, job) {
  const configuredAgent = typeof config.agent === 'string' ? config.agent.trim() : '';
  const jobAgent = typeof job.input?.aiAgentCode === 'string' ? job.input.aiAgentCode.trim() : '';

  return configuredAgent === '' || jobAgent === '' || configuredAgent === jobAgent;
}

function resolveReasoning(config, job) {
  const fromJob = job.input?.reasoningEffort;
  const fromConfig = config.reasoning;
  const value = shouldUseJobScopedModel(config, job) && typeof fromJob === 'string' && fromJob.trim() !== ''
    ? fromJob
    : fromConfig;

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

      if (options.quietStdout !== true) {
        process.stdout.write(redactSecrets(value));
      }
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

  if (command === 'src') {
    return 'SourceCraft CLI not found. Install SourceCraft CLI and make sure `src` is available in PATH for the terminal that runs cyrboard-local-agent.';
  }

  if (command === 'gigacode') {
    return 'GigaCode CLI not found. Install the corporate GigaCode CLI provided by Sber and make sure `gigacode` is available in PATH for the terminal that runs cyrboard-local-agent.';
  }

  return `${command} command not found. Make sure it is installed and available in PATH.`;
}
