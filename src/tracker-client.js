import { redactSecrets } from './redact.js';
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_RETRY_OPTIONS = {
  attempts: 4,
  initialDelayMs: 1_000,
  maxDelayMs: 8_000,
};

const TERMINAL_RETRY_OPTIONS = {
  attempts: 10,
  initialDelayMs: 1_000,
  maxDelayMs: 15_000,
};

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

export class TrackerClient {
  constructor(serverUrl, options = {}) {
    this.serverUrl = normalizeServerUrl(serverUrl);
    this.delay = options.delay || delay;
    this.retryOptions = {
      ...DEFAULT_RETRY_OPTIONS,
      ...(options.retryOptions || {}),
    };
    this.terminalRetryOptions = {
      ...TERMINAL_RETRY_OPTIONS,
      ...(options.terminalRetryOptions || {}),
    };
  }

  async register({ setupToken, projectId, label }) {
    return this.postJson('/tracker/local-runners/register', setupToken, {
      projectId,
      label,
    });
  }

  async claim(runnerToken) {
    return this.postJson('/tracker/local-runners/claim', runnerToken, {});
  }

  async heartbeat(runnerToken, payload) {
    return this.postJson('/tracker/local-runners/heartbeat', runnerToken, payload);
  }

  async complete(runnerToken, payload) {
    return this.postJson('/tracker/local-runners/complete', runnerToken, payload, {
      retryOptions: this.terminalRetryOptions,
    });
  }

  async fail(runnerToken, payload) {
    return this.postJson('/tracker/local-runners/fail', runnerToken, payload, {
      retryOptions: this.terminalRetryOptions,
    });
  }

  async postJson(path, bearerToken, payload, options = {}) {
    const retryOptions = normalizeRetryOptions(options.retryOptions || this.retryOptions);
    let lastError = null;

    for (let attempt = 1; attempt <= retryOptions.attempts; attempt += 1) {
      try {
        return await this.sendJsonRequest(path, bearerToken, payload);
      } catch (error) {
        lastError = error;

        if (!isRetryableTrackerError(error) || attempt >= retryOptions.attempts) {
          throw error;
        }

        await this.delay(retryDelayMs(retryOptions, attempt));
      }
    }

    throw lastError;
  }

  async sendJsonRequest(path, bearerToken, payload) {
    let response;

    try {
      response = await fetch(`${this.serverUrl}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      throw new TrackerRequestError(redactSecrets(`Tracker request failed before response: ${message}`), {
        retryable: true,
      });
    }

    const text = await response.text();
    const data = parseJsonResponse({
      response,
      serverUrl: this.serverUrl,
      text,
    });

    if (!response.ok) {
      const message = typeof data.error === 'string' ? data.error : text;

      throw new TrackerRequestError(redactSecrets(`Tracker request failed: ${response.status} ${message}`), {
        retryable: RETRYABLE_STATUS_CODES.has(response.status),
      });
    }

    return data;
  }
}

function parseJsonResponse({ response, serverUrl, text }) {
  const body = text.trim();

  if (body === '') {
    return {};
  }

  const contentType = response.headers.get('content-type') || '';

  if (!contentType.toLowerCase().includes('application/json')) {
    throw new TrackerRequestError(redactSecrets(buildNonJsonResponseMessage({
      body,
      contentType,
      response,
      serverUrl,
    })), {
      retryable: RETRYABLE_STATUS_CODES.has(response.status),
    });
  }

  try {
    return JSON.parse(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new TrackerRequestError(redactSecrets(`Tracker returned invalid JSON: ${message}. Response preview: ${previewBody(body)}`), {
      retryable: RETRYABLE_STATUS_CODES.has(response.status),
    });
  }
}

function buildNonJsonResponseMessage({ body, contentType, response, serverUrl }) {
  const parts = [
    `Tracker returned non-JSON response: HTTP ${response.status} ${response.statusText}`.trim(),
  ];

  if (contentType !== '') {
    parts.push(`Content-Type: ${contentType}.`);
  }

  if (serverUrl.startsWith('http://') && !isLocalServerUrl(serverUrl)) {
    parts.push('Production servers usually require https://. Check --server URL and regenerate the connect command in Cyrboard.');
  }

  parts.push(`Response preview: ${previewBody(body)}`);

  return parts.join(' ');
}

function isLocalServerUrl(serverUrl) {
  try {
    const url = new URL(serverUrl);

    return ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

function previewBody(body) {
  return body.replace(/\s+/g, ' ').slice(0, 180);
}

function normalizeRetryOptions(options) {
  return {
    attempts: Math.max(1, Number(options.attempts) || 1),
    initialDelayMs: Math.max(0, Number(options.initialDelayMs) || 0),
    maxDelayMs: Math.max(0, Number(options.maxDelayMs) || 0),
  };
}

function retryDelayMs(options, attempt) {
  const delayMs = options.initialDelayMs * 2 ** Math.max(0, attempt - 1);

  return Math.min(options.maxDelayMs, delayMs);
}

function isRetryableTrackerError(error) {
  return error instanceof TrackerRequestError && error.retryable;
}

class TrackerRequestError extends Error {
  constructor(message, { retryable }) {
    super(message);
    this.name = 'TrackerRequestError';
    this.retryable = retryable;
  }
}

function normalizeServerUrl(serverUrl) {
  const normalized = String(serverUrl || '').trim().replace(/\/+$/, '');

  if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
    throw new Error('--server must start with http:// or https://.');
  }

  return normalized;
}
