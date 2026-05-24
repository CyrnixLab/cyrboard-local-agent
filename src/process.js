import { spawn } from 'node:child_process';

export async function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell || false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });
    child.on('error', reject);
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
  });
}
