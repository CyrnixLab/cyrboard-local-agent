import { spawn } from 'node:child_process';
import { parseArgs, optionalInt, optionalString, requiredString } from './args.js';
import { isLocalConfigIgnored, loadConfig, removeConfig, resolveRepoPath, saveConfig } from './config.js';
import { UsageError } from './errors.js';
import { acquireRunnerLock } from './process-lock.js';
import { redactSecrets } from './redact.js';
import { TrackerClient } from './tracker-client.js';
import { runOnce, startLoop } from './runner.js';
import { startSupervisor } from './supervisor.js';
import { installRuntimeVersion } from './updater.js';
import { CLIENT_VERSION } from './version.js';

export async function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0];

  if (!command || args.help === true || command === 'help') {
    printHelp();
    return;
  }

  if (command === 'connect') {
    await connect(args);
    return;
  }

  if (command === 'run-once') {
    await runFromConfig(args, true);
    return;
  }

  if (command === 'start') {
    await runFromConfig(args, false);
    return;
  }

  if (command === 'status') {
    await status(args);
    return;
  }

  if (command === '__worker') {
    await runManagedWorker(args);
    return;
  }

  if (command === '__run-once') {
    await runManagedOneShot(args);
    return;
  }

  if (command === 'disconnect') {
    await disconnect(args);
    return;
  }

  throw new UsageError(`Unknown command: ${command}`);
}

async function connect(args) {
  const serverUrl = requiredString(args, 'server').replace(/\/+$/, '');
  const projectId = optionalInt(args, 'project-id', 0);
  const setupToken = requiredString(args, 'token');
  const repoPath = resolveRepoPath(optionalString(args, 'repo', '.'));
  const agent = optionalString(args, 'agent', 'codex');
  const label = optionalString(args, 'label', `${process.platform} local agent`);
  const sandbox = optionalString(args, 'sandbox', 'workspace-write');
  const permissionMode = optionalString(args, 'permission-mode', '');
  const model = optionalString(args, 'model', '');
  const reasoning = optionalString(args, 'reasoning', '');
  const shouldStart = args.start === true;
  const intervalSeconds = optionalInt(args, 'interval', 10);

  if (projectId <= 0) {
    throw new UsageError('Missing required --project-id.');
  }

  if (!['codex', 'claude'].includes(agent)) {
    throw new UsageError('--agent must be codex or claude.');
  }

  const client = new TrackerClient(serverUrl);
  const registered = await client.register({ setupToken, projectId, label });

  if (typeof registered.rawToken !== 'string' || registered.rawToken.trim() === '') {
    throw new Error('Tracker did not return a runner token.');
  }

  await saveConfig(repoPath, {
    schemaVersion: 1,
    serverUrl,
    projectId,
    runnerId: registered.runnerId,
    runnerToken: registered.rawToken,
    label,
    agent,
    sandbox,
    permissionMode,
    model,
    reasoning,
  });

  console.log(`Local runner #${registered.runnerId} connected.`);
  console.log(`Config saved to ${repoPath}/.cyrboard/local-agent.json.`);

  if (!(await isLocalConfigIgnored(repoPath))) {
    console.warn('Warning: add .cyrboard/ to this repository .gitignore before committing.');
  }

  if (shouldStart) {
    await startSupervisor(repoPath, intervalSeconds);
  } else {
    console.log('Run `cyrnixlab-local-agent start --repo . --interval 10` to process jobs.');
  }
}

async function runFromConfig(args, once) {
  const repoPath = resolveRepoPath(optionalString(args, 'repo', '.'));
  const config = await loadConfig(repoPath);

  if (once) {
    await runOneShotWithAutoUpdate(config, repoPath);
    return;
  }

  const intervalSeconds = optionalInt(args, 'interval', 10);
  await startSupervisor(repoPath, intervalSeconds);
}

async function runManagedWorker(args) {
  const repoPath = resolveRepoPath(optionalString(args, 'repo', '.'));
  const intervalSeconds = optionalInt(args, 'interval', 10);
  const config = await loadConfig(repoPath);

  await startLoop(config, repoPath, intervalSeconds, {
    onUpdateRequired: sendUpdateRequired,
  });
}

async function runManagedOneShot(args) {
  const repoPath = resolveRepoPath(optionalString(args, 'repo', '.'));
  const result = await runOnce(await loadConfig(repoPath), repoPath);

  if (result.updateRequired) {
    throw new Error(`Local agent ${result.latestVersion} is required before a job can be claimed.`);
  }
}

async function runOneShotWithAutoUpdate(config, repoPath) {
  const releaseLock = await acquireRunnerLock(repoPath);

  try {
    const result = await runOnce(config, repoPath);

    if (!result.updateRequired) {
      return;
    }

    const binPath = await installRuntimeVersion(repoPath, result.latestVersion);
    await runChild(binPath, ['__run-once', '--repo', repoPath]);
  } finally {
    await releaseLock();
  }
}

function sendUpdateRequired(version) {
  if (typeof process.send !== 'function') {
    throw new Error('Managed local agent worker lost its supervisor IPC channel.');
  }

  return new Promise((resolvePromise, rejectPromise) => {
    process.send({ type: 'update-required', version }, (error) => {
      if (error) {
        rejectPromise(error);
        return;
      }

      resolvePromise();
    });
  });
}

function runChild(binPath, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      stdio: 'inherit',
    });

    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      rejectPromise(new Error(`Updated local agent stopped (${signal || `exit code ${code}`}).`));
    });
  });
}

async function status(args) {
  const repoPath = resolveRepoPath(optionalString(args, 'repo', '.'));
  const config = await loadConfig(repoPath);

  console.log(`Server: ${config.serverUrl}`);
  console.log(`Project ID: ${config.projectId}`);
  console.log(`Runner ID: ${config.runnerId}`);
  console.log(`Version: ${CLIENT_VERSION}`);
  console.log(`Agent: ${config.agent}`);
  if (config.model) {
    console.log(`Model: ${config.model}`);
  }
  if (config.reasoning) {
    console.log(`Reasoning: ${config.reasoning}`);
  }
  if (config.permissionMode) {
    console.log(`Permission mode: ${config.permissionMode}`);
  }
  console.log(`Config: ${repoPath}/.cyrboard/local-agent.json`);
  console.log('Status only reads local config; it does not start polling.');
  console.log('To process jobs, run: cyrnixlab-local-agent start --repo . --interval 10');
}

async function disconnect(args) {
  const repoPath = resolveRepoPath(optionalString(args, 'repo', '.'));

  await removeConfig(repoPath);
  console.log('Local config removed. Revoke the runner in Cyrboard UI as well.');
}

function printHelp() {
  console.log(`Cyrnix Lab Local Agent

Version: ${CLIENT_VERSION}

Usage:
  cyrnixlab-local-agent connect --server <url> --project-id <id> --token <setup-token> [--repo .] [--agent codex|claude] [--model <model>] [--reasoning <effort>] [--permission-mode <mode>] [--start] [--interval 10]
  cyrnixlab-local-agent run-once [--repo .]
  cyrnixlab-local-agent start [--repo .] [--interval 10]
  cyrnixlab-local-agent status [--repo .]
  cyrnixlab-local-agent disconnect [--repo .]

Agent modes:
  codex      Run codex exec locally.
  claude     Run Claude Code locally.

Reasoning efforts:
  low, medium, high, xhigh

Claude permission mode:
  Defaults to bypassPermissions for non-interactive local automation. Override with --permission-mode when needed.
`);
}

export function formatCliError(error) {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}
