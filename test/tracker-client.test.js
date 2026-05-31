import test from 'node:test';
import assert from 'node:assert/strict';
import { TrackerClient } from '../src/tracker-client.js';

test('TrackerClient explains non-JSON responses from production http URL', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('<!DOCTYPE html><html><body>Moved</body></html>', {
    status: 405,
    statusText: 'Method Not Allowed',
    headers: {
      'content-type': 'text/html; charset=UTF-8',
    },
  });

  try {
    const client = new TrackerClient('http://cyrboard.cyrnix.dev');

    await assert.rejects(
      () => client.register({
        label: 'test runner',
        projectId: 1,
        setupToken: 'cyr_mcp_1234567890abcdef',
      }),
      (error) => {
        assert.match(error.message, /Tracker returned non-JSON response/);
        assert.match(error.message, /https:\/\//);
        assert.doesNotMatch(error.message, /cyr_mcp_1234567890abcdef/);

        return true;
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('TrackerClient parses successful JSON responses', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ runnerId: 42 });

  try {
    const client = new TrackerClient('http://localhost:8182');
    const response = await client.register({
      label: 'test runner',
      projectId: 1,
      setupToken: 'cyr_mcp_1234567890abcdef',
    });

    assert.deepEqual(response, { runnerId: 42 });
  } finally {
    globalThis.fetch = previousFetch;
  }
});
