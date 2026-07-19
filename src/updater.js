import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PACKAGE_NAME } from './version.js';

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

export async function installRuntimeVersion(repoPath, version, options = {}) {
  assertSafeVersion(version);

  const runtimeRoot = resolve(repoPath, '.cyrboard', 'runtime');
  const targetDirectory = resolve(runtimeRoot, version);
  const existingBin = await validRuntimeBinOrNull(targetDirectory, version);

  if (existingBin !== null) {
    return existingBin;
  }

  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const temporaryDirectory = await mkdtemp(join(runtimeRoot, `.install-${version}-`));
  const commandRunner = options.commandRunner || runCommand;

  try {
    await commandRunner(npmExecutable(), [
      'install',
      '--prefix', temporaryDirectory,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--omit=dev',
      '--save-exact',
      `${PACKAGE_NAME}@${version}`,
    ], {
      cwd: repoPath,
      logger: options.logger || console,
    });

    const installedBin = await validateRuntime(temporaryDirectory, version);
    await rename(temporaryDirectory, targetDirectory);

    return installedBin.replace(temporaryDirectory, targetDirectory);
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

export function assertSafeVersion(version) {
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    throw new Error('Tracker returned an invalid local agent version.');
  }
}

async function validRuntimeBinOrNull(directory, version) {
  try {
    return await validateRuntime(directory, version);
  } catch {
    return null;
  }
}

async function validateRuntime(directory, version) {
  const packageDirectory = resolve(directory, 'node_modules', '@cyrnixlab', 'cyrboard-local-agent');
  const metadata = JSON.parse(await readFile(resolve(packageDirectory, 'package.json'), 'utf8'));

  if (metadata.name !== PACKAGE_NAME || metadata.version !== version) {
    throw new Error('Installed local agent package identity does not match the requested release.');
  }

  const binPath = resolve(packageDirectory, 'bin', 'cyrboard-local-agent.js');
  await access(binPath);

  return binPath;
}

function npmExecutable() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runCommand(command, args, { cwd, logger }) {
  logger.log(`Installing ${PACKAGE_NAME}@${args.at(-1).split('@').at(-1)}...`);

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: false,
    });

    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      rejectPromise(new Error(`npm install failed (${signal || `exit code ${code}`}).`));
    });
  });
}

