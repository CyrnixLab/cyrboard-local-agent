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
    const data = text.trim() !== '' ? JSON.parse(text) : {};

    if (!response.ok) {
      const message = typeof data.error === 'string' ? data.error : text;
      throw new Error(redactSecrets(`Tracker request failed: ${response.status} ${message}`));
    }

    return data;
  }
}

function normalizeServerUrl(serverUrl) {
  const normalized = String(serverUrl || '').trim().replace(/\/+$/, '');

  if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
    throw new Error('--server must start with http:// or https://.');
  }

  return normalized;
}
