import { clearInterval, setInterval } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { runAgent } from './agents.js';
import { TrackerClient } from './tracker-client.js';

const JOB_HEARTBEAT_INTERVAL_MS = 30_000;

export async function runOnce(config, repoPath) {
  const client = new TrackerClient(config.serverUrl);
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

    const result = await runAgent(config, job, repoPath);

    heartbeatTimer = stopJobHeartbeat(heartbeatTimer);
    await client.heartbeat(config.runnerToken, {
      jobId: job.id,
      progressPercent: 90,
      progressStage: 'local_agent_reporting',
    });
    await client.complete(config.runnerToken, {
      jobId: job.id,
      resultSummary: result.summary,
    });

    console.log(`Completed job #${job.id}.`);
    return { claimed: true, jobId: job.id };
  } catch (error) {
    stopJobHeartbeat(heartbeatTimer);
    const message = error instanceof Error ? error.message : String(error);

    await client.fail(config.runnerToken, {
      jobId: job.id,
      errorMessage: message,
    });

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
      console.warn(`Heartbeat failed for job #${jobId}: ${message}`);
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

export async function startLoop(config, repoPath, intervalSeconds) {
  console.log(`Local agent started. Poll interval: ${intervalSeconds}s.`);

  while (true) {
    await runOnce(config, repoPath);
    await delay(intervalSeconds * 1000);
  }
}
