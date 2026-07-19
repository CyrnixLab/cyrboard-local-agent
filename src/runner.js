import { clearInterval, setInterval } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { runAgent } from './agents.js';
import { materializeInputAttachments } from './attachments.js';
import { redactSecrets } from './redact.js';
import { TrackerClient } from './tracker-client.js';
import { CLIENT_VERSION } from './version.js';

const JOB_HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_RETRY_DELAY_SECONDS = 60;

export async function runOnce(config, repoPath, options = {}) {
  const client = options.client || new TrackerClient(config.serverUrl);
  const agentRunner = options.agentRunner || runAgent;
  const claim = await client.claim(config.runnerToken, {
    clientVersion: CLIENT_VERSION,
    protocolVersion: 2,
    capabilities: config.agent === 'codex' ? {
      input_attachments_v1: {
        fileKinds: ['image', 'pdf', 'docx', 'xlsx', 'csv'],
        maxFiles: 20,
        maxBytesPerFile: 25 * 1024 * 1024,
        maxTotalBytes: 250 * 1024 * 1024,
      },
    } : {},
  });
  const job = claim.job || null;
  const update = normalizeUpdate(claim.update);

  if (job === null) {
    if (update.updateRequired) {
      console.log(`Local agent ${update.latestVersion} is available; the idle worker will update now.`);
      return {
        claimed: false,
        updateRequired: true,
        latestVersion: update.latestVersion,
      };
    }

    console.log('No queued local_mcp jobs.');
    return { claimed: false, updateRequired: false };
  }

  console.log(`Claimed job #${job.id} (${job.jobKind}).`);
  let heartbeatTimer = null;
  let inputAttachments = { directory: null, files: [], cleanup: async () => {} };

  try {
    if (Array.isArray(job.attachments) && job.attachments.length > 0 && config.agent !== 'codex') {
      throw new Error('input_attachment_agent_unsupported');
    }

    await client.heartbeat(config.runnerToken, {
      jobId: job.id,
      progressPercent: 10,
      progressStage: 'local_agent_started',
    });
    heartbeatTimer = startJobHeartbeat(client, config.runnerToken, job.id);
    inputAttachments = await materializeInputAttachments(client, job);

    const result = await agentRunner(config, job, repoPath, inputAttachments);

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
  } finally {
    await inputAttachments.cleanup();
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
      const result = await runOnceFn(config, repoPath);
      consecutiveFailures = 0;

      if (result?.updateRequired) {
        if (typeof options.onUpdateRequired !== 'function') {
          throw new Error('Automatic update requires the local agent supervisor.');
        }

        await options.onUpdateRequired(result.latestVersion);
        return {
          reason: 'update_required',
          latestVersion: result.latestVersion,
        };
      }
    } catch (error) {
      consecutiveFailures += 1;
      const message = error instanceof Error ? error.message : String(error);

      logger.warn(redactSecrets(`Local agent iteration failed: ${message}`));
    }

    const retryDelaySeconds = retryDelay(intervalSeconds, consecutiveFailures);
    await delayFn(retryDelaySeconds * 1000);
  }
}

function normalizeUpdate(update) {
  if (!update || typeof update !== 'object') {
    return { updateRequired: false, latestVersion: null };
  }

  const latestVersion = typeof update.latestVersion === 'string' ? update.latestVersion.trim() : '';

  return {
    updateRequired: update.updateRequired === true && latestVersion !== '' && latestVersion !== CLIENT_VERSION,
    latestVersion: latestVersion || null,
  };
}

function retryDelay(intervalSeconds, consecutiveFailures) {
  if (consecutiveFailures <= 0) {
    return intervalSeconds;
  }

  return Math.min(MAX_RETRY_DELAY_SECONDS, intervalSeconds * 2 ** Math.min(consecutiveFailures - 1, 4));
}
