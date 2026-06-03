import { clearInterval, setInterval } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { runAgent } from './agents.js';
import { redactSecrets } from './redact.js';
import { TrackerClient } from './tracker-client.js';

const JOB_HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_RETRY_DELAY_SECONDS = 60;

export async function runOnce(config, repoPath, options = {}) {
  const client = options.client || new TrackerClient(config.serverUrl);
  const agentRunner = options.agentRunner || runAgent;
  const claim = await client.claim(config.runnerToken);
  const job = claim.job || null;

  if (job === null) {
    console.log('No queued local_mcp jobs.');
    return { claimed: false };
  }

  console.log(`Claimed job #${job.id} (${job.jobKind}).`);
  let heartbeatTimer = null;

  try {
    await client.heartbeat(config.runnerToken, {
      jobId: job.id,
      progressPercent: 10,
      progressStage: 'local_agent_started',
    });
    heartbeatTimer = startJobHeartbeat(client, config.runnerToken, job.id);

    const result = await agentRunner(config, job, repoPath);

    heartbeatTimer = stopJobHeartbeat(heartbeatTimer);
    await client.heartbeat(config.runnerToken, {
      jobId: job.id,
      progressPercent: 90,
      progressStage: 'local_agent_reporting',
    });
    await client.complete(config.runnerToken, {
      jobId: job.id,
      resultSummary: redactSecrets(result.summary),
      resultText: redactSecrets(result.resultText || result.summary),
    });

    console.log(`Completed job #${job.id}.`);
    return { claimed: true, jobId: job.id };
  } catch (error) {
    stopJobHeartbeat(heartbeatTimer);
    const message = error instanceof Error ? error.message : String(error);

    try {
      await client.fail(config.runnerToken, {
        jobId: job.id,
        errorMessage: redactSecrets(message),
      });
    } catch (failError) {
      const failMessage = failError instanceof Error ? failError.message : String(failError);
      console.warn(redactSecrets(`Failed to report job #${job.id} failure: ${failMessage}`));
    }

    throw error;
  }
}

function startJobHeartbeat(client, runnerToken, jobId) {
  const timer = setInterval(() => {
    client.heartbeat(runnerToken, {
      jobId,
      progressStage: 'local_agent_running',
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(redactSecrets(`Heartbeat failed for job #${jobId}: ${message}`));
    });
  }, JOB_HEARTBEAT_INTERVAL_MS);

  timer.unref?.();

  return timer;
}

function stopJobHeartbeat(timer) {
  if (timer !== null) {
    clearInterval(timer);
  }

  return null;
}

export async function startLoop(config, repoPath, intervalSeconds, options = {}) {
  const logger = options.logger || console;
  const runOnceFn = options.runOnce || runOnce;
  const delayFn = options.delay || delay;
  const maxIterations = Number.isSafeInteger(options.maxIterations) ? options.maxIterations : Number.POSITIVE_INFINITY;
  let iteration = 0;
  let consecutiveFailures = 0;

  logger.log(`Local agent started. Poll interval: ${intervalSeconds}s.`);
  logger.log('Keep this terminal open to process Cyrboard local_mcp jobs.');

  while (iteration < maxIterations) {
    iteration += 1;

    try {
      await runOnceFn(config, repoPath);
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      const message = error instanceof Error ? error.message : String(error);

      logger.warn(redactSecrets(`Local agent iteration failed: ${message}`));
    }

    const retryDelaySeconds = retryDelay(intervalSeconds, consecutiveFailures);
    await delayFn(retryDelaySeconds * 1000);
  }
}

function retryDelay(intervalSeconds, consecutiveFailures) {
  if (consecutiveFailures <= 0) {
    return intervalSeconds;
  }

  return Math.min(MAX_RETRY_DELAY_SECONDS, intervalSeconds * 2 ** Math.min(consecutiveFailures - 1, 4));
}
