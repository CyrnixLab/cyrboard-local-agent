import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const PACKAGE_NAME = '@cyrnixlab/cyrboard-local-agent';
export const CLIENT_VERSION = String(packageJson.version || '0.0.0');

