import { parseArgs, optionalInt, optionalString, requiredString } from './args.js';
import { isLocalConfigIgnored, loadConfig, removeConfig, resolveRepoPath, saveConfig } from './config.js';
import { UsageError } from './errors.js';
import { redactSecrets } from './redact.js';
import { TrackerClient } from './tracker-client.js';
import { runOnce, startLoop } from './runner.js';

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
  const command = optionalString(args, 'command', '');
  const sandbox = optionalString(args, 'sandbox', 'workspace-write');

  if (projectId <= 0) {
    throw new UsageError('Missing required --project-id.');
  }

  if (!['codex', 'command'].includes(agent)) {
    throw new UsageError('--agent must be codex or command.');
  }

  if (agent === 'command' && command === '') {
    throw new UsageError('--command is required for command agent mode.');
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
    command,
    sandbox,
  });

  console.log(`Local runner #${registered.runnerId} connected.`);
  console.log(`Config saved to ${repoPath}/.cyrboard/local-agent.json.`);

  if (!(await isLocalConfigIgnored(repoPath))) {
    console.warn('Warning: add .cyrboard/ to this repository .gitignore before committing.');
  }
}

async function runFromConfig(args, once) {
  const repoPath = resolveRepoPath(optionalString(args, 'repo', '.'));
  const config = await loadConfig(repoPath);

  if (once) {
    await runOnce(config, repoPath);
    return;
  }

  const intervalSeconds = optionalInt(args, 'interval', 10);
  await startLoop(config, repoPath, intervalSeconds);
}

async function status(args) {
  const repoPath = resolveRepoPath(optionalString(args, 'repo', '.'));
  const config = await loadConfig(repoPath);

  console.log(`Server: ${config.serverUrl}`);
  console.log(`Project ID: ${config.projectId}`);
  console.log(`Runner ID: ${config.runnerId}`);
  console.log(`Agent: ${config.agent}`);
}

async function disconnect(args) {
  const repoPath = resolveRepoPath(optionalString(args, 'repo', '.'));

  await removeConfig(repoPath);
  console.log('Local config removed. Revoke the runner in Cyrboard UI as well.');
}

function printHelp() {
  console.log(`Cyrnix Lab Local Agent

Usage:
  cyrnixlab-local-agent connect --server <url> --project-id <id> --token <setup-token> [--repo .] [--agent codex]
  cyrnixlab-local-agent run-once [--repo .]
  cyrnixlab-local-agent start [--repo .] [--interval 10]
  cyrnixlab-local-agent status [--repo .]
  cyrnixlab-local-agent disconnect [--repo .]

Agent modes:
  codex      Run codex exec locally.
  command    Run an explicit shell command, intended for controlled smoke tests.
`);
}

export function formatCliError(error) {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}
