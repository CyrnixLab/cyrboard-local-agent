import { redactSecrets } from './redact.js';

export class TrackerClient {
  constructor(serverUrl) {
    this.serverUrl = normalizeServerUrl(serverUrl);
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
    return this.postJson('/tracker/local-runners/complete', runnerToken, payload);
  }

  async fail(runnerToken, payload) {
    return this.postJson('/tracker/local-runners/fail', runnerToken, payload);
  }

  async postJson(path, bearerToken, payload) {
    const response = await fetch(`${this.serverUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    const data = parseJsonResponse({
      response,
      serverUrl: this.serverUrl,
      text,
    });

    if (!response.ok) {
      const message = typeof data.error === 'string' ? data.error : text;
      throw new Error(redactSecrets(`Tracker request failed: ${response.status} ${message}`));
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
    throw new Error(redactSecrets(buildNonJsonResponseMessage({
      body,
      contentType,
      response,
      serverUrl,
    })));
  }

  try {
    return JSON.parse(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new Error(redactSecrets(`Tracker returned invalid JSON: ${message}. Response preview: ${previewBody(body)}`));
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

function normalizeServerUrl(serverUrl) {
  const normalized = String(serverUrl || '').trim().replace(/\/+$/, '');

  if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
    throw new Error('--server must start with http:// or https://.');
  }

  return normalized;
}
