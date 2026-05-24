import { UsageError } from './errors.js';

export function parseArgs(argv) {
  const args = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];

    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }

    const eqIndex = item.indexOf('=');

    if (eqIndex > 2) {
      args[item.slice(2, eqIndex)] = item.slice(eqIndex + 1);
      continue;
    }

    const key = item.slice(2);
    const next = argv[index + 1];

    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    index += 1;
  }

  return args;
}

export function requiredString(args, key) {
  const value = args[key];

  if (typeof value !== 'string' || value.trim() === '') {
    throw new UsageError(`Missing required --${key}.`);
  }

  return value.trim();
}

export function optionalString(args, key, fallback) {
  const value = args[key];

  if (typeof value !== 'string' || value.trim() === '') {
    return fallback;
  }

  return value.trim();
}

export function optionalInt(args, key, fallback) {
  const value = args[key];

  if (typeof value !== 'string' || value.trim() === '') {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new UsageError(`--${key} must be a positive integer.`);
  }

  return parsed;
}
