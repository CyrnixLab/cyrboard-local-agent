import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const LOCK_FILE = 'local-agent.lock';

export async function acquireRunnerLock(repoPath) {
  const directory = resolve(repoPath, '.cyrboard');
  const path = resolve(directory, LOCK_FILE);

  await mkdir(directory, { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);

      let released = false;

      return async () => {
        if (released) {
          return;
        }

        released = true;
        await handle.close();
        await rm(path, { force: true });
      };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        throw error;
      }

      const ownerPid = await readLockPid(path);

      if (ownerPid !== null && isProcessAlive(ownerPid)) {
        throw new Error(`Local agent is already running for this repository (PID ${ownerPid}).`);
      }

      await rm(path, { force: true });
    }
  }

  throw new Error('Could not acquire the local agent process lock.');
}

async function readLockPid(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));

    return Number.isSafeInteger(value?.pid) && value.pid > 0 ? value.pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

