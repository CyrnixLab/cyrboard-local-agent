import { mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';

const CONFIG_DIR = '.cyrboard';
const CONFIG_FILE = 'local-agent.json';

export function resolveRepoPath(repo) {
  return resolve(process.cwd(), repo || '.');
}

export function configPath(repoPath) {
  return resolve(repoPath, CONFIG_DIR, CONFIG_FILE);
}

export async function saveConfig(repoPath, config) {
  const dir = resolve(repoPath, CONFIG_DIR);
  const path = configPath(repoPath);
  const body = `${JSON.stringify(config, null, 2)}\n`;

  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(path, body, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function loadConfig(repoPath) {
  const raw = await readFile(configPath(repoPath), 'utf8');
  const parsed = JSON.parse(raw);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Local agent config is invalid.');
  }

  if (parsed.agent === 'command') {
    throw new Error('Command agent mode is no longer supported. Reconnect this runner with --agent codex, --agent claude, or --agent sourcecraft.');
  }

  return parsed;
}

export async function removeConfig(repoPath) {
  await rm(configPath(repoPath), { force: true });
}

export async function isLocalConfigIgnored(repoPath) {
  try {
    const gitignore = await readFile(resolve(repoPath, '.gitignore'), 'utf8');
    const entries = gitignore
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));

    return entries.includes(CONFIG_DIR) || entries.includes(`${CONFIG_DIR}/`) || entries.includes(`${CONFIG_DIR}/**`);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}
