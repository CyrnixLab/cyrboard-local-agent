import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { acquireRunnerLock } from './process-lock.js';
import { redactSecrets } from './redact.js';
import { installRuntimeVersion } from './updater.js';

const CURRENT_BIN_PATH = fileURLToPath(new URL('../bin/cyrboard-local-agent.js', import.meta.url));
const MAX_RESTART_DELAY_SECONDS = 60;

export async function startSupervisor(repoPath, intervalSeconds, options = {}) {
  const logger = options.logger || console;
  const releaseLock = await acquireRunnerLock(repoPath);
  const workerRunner = options.workerRunner || runWorkerProcess;
  const installer = options.installer || installRuntimeVersion;
  const delayFn = options.delay || delay;
  const maxCycles = Number.isSafeInteger(options.maxCycles) ? options.maxCycles : Number.POSITIVE_INFINITY;
  let runtimeBinPath = options.initialBinPath || CURRENT_BIN_PATH;
  let consecutiveFailures = 0;

  logger.log('Local agent supervisor started. Automatic updates are enabled.');

  try {
    for (let cycle = 0; cycle < maxCycles; cycle += 1) {
      const worker = await workerRunner(runtimeBinPath, repoPath, intervalSeconds);

      if (worker.stopped) {
        return;
      }

      if (worker.updateVersion) {
        try {
          logger.log(`Local agent ${worker.updateVersion} is required. Updating while idle...`);
          runtimeBinPath = await installer(repoPath, worker.updateVersion, { logger });
          consecutiveFailures = 0;
          logger.log(`Local agent updated to ${worker.updateVersion}. Restarting worker.`);
          continue;
        } catch (error) {
          consecutiveFailures += 1;
          logger.warn(redactSecrets(`Automatic update failed: ${error instanceof Error ? error.message : String(error)}`));
        }
      } else {
        consecutiveFailures += 1;
        logger.warn(`Local agent worker stopped unexpectedly (${worker.signal || `exit code ${worker.exitCode}`}).`);
      }

      await delayFn(restartDelaySeconds(consecutiveFailures) * 1000);
    }
  } finally {
    await releaseLock();
  }
}

function runWorkerProcess(binPath, repoPath, intervalSeconds) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [
      binPath,
      '__worker',
      '--repo',
      repoPath,
      '--interval',
      String(intervalSeconds),
    ], {
      cwd: repoPath,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    });
    let updateVersion = null;
    let stopped = false;

    const forwardSignal = (signal) => {
      stopped = true;
      child.kill(signal);
    };
    const forwardSigint = () => forwardSignal('SIGINT');
    const forwardSigterm = () => forwardSignal('SIGTERM');

    process.once('SIGINT', forwardSigint);
    process.once('SIGTERM', forwardSigterm);

    child.on('message', (message) => {
      if (message?.type === 'update-required' && typeof message.version === 'string') {
        updateVersion = message.version;
      }
    });
    child.once('error', rejectPromise);
    child.once('exit', (exitCode, signal) => {
      process.removeListener('SIGINT', forwardSigint);
      process.removeListener('SIGTERM', forwardSigterm);
      resolvePromise({
        updateVersion,
        exitCode,
        signal,
        stopped,
      });
    });
  });
}

function restartDelaySeconds(consecutiveFailures) {
  return Math.min(MAX_RESTART_DELAY_SECONDS, 5 * 2 ** Math.min(consecutiveFailures - 1, 4));
}

