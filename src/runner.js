import { setTimeout as delay } from 'node:timers/promises';
import { runAgent } from './agents.js';
import { TrackerClient } from './tracker-client.js';

export async function runOnce(config, repoPath) {
  const client = new TrackerClient(config.serverUrl);
  const claim = await client.claim(config.runnerToken);
  const job = claim.job || null;

  if (job === null) {
    console.log('No queued local_mcp jobs.');
    return { claimed: false };
  }

  console.log(`Claimed job #${job.id} (${job.jobKind}).`);

  try {
    await client.heartbeat(config.runnerToken, {
      jobId: job.id,
      progressPercent: 10,
      progressStage: 'local_agent_started',
    });

    const result = await runAgent(config, job, repoPath);

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
    const message = error instanceof Error ? error.message : String(error);

    await client.fail(config.runnerToken, {
      jobId: job.id,
      errorMessage: message,
    });

    throw error;
  }
}

export async function startLoop(config, repoPath, intervalSeconds) {
  console.log(`Local agent started. Poll interval: ${intervalSeconds}s.`);

  while (true) {
    await runOnce(config, repoPath);
    await delay(intervalSeconds * 1000);
  }
}
