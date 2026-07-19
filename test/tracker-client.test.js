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

test('TrackerClient sends attachment protocol metadata in claim', async () => {
  const previousFetch = globalThis.fetch;
  let requestBody = null;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);

    return Response.json({ job: null });
  };

  try {
    const client = new TrackerClient('http://localhost:8182');
    await client.claim('cyr_runner_test', {
      clientVersion: '0.2.0',
      protocolVersion: 2,
      capabilities: { input_attachments_v1: {} },
    });

    assert.deepEqual(requestBody, {
      clientVersion: '0.2.0',
      protocolVersion: 2,
      capabilities: { input_attachments_v1: {} },
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('TrackerClient rejects cross-origin attachment URL', async () => {
  const client = new TrackerClient('https://cyrboard.example');

  await assert.rejects(
    () => client.download('https://attacker.example/file', 'cyr_mcp_job_test'),
    /input_attachment_cross_origin_url/,
  );
});

test('TrackerClient retries transient gateway responses', async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  const delays = [];

  globalThis.fetch = async () => {
    calls += 1;

    if (calls === 1) {
      return new Response('<html><body>Bad Gateway</body></html>', {
        status: 502,
        statusText: 'Bad Gateway',
        headers: {
          'content-type': 'text/html; charset=utf-8',
        },
      });
    }

    return Response.json({ job: null });
  };

  try {
    const client = new TrackerClient('https://cyrboard.cyrnix.dev', {
      delay: async (milliseconds) => {
        delays.push(milliseconds);
      },
      retryOptions: {
        attempts: 2,
        initialDelayMs: 25,
        maxDelayMs: 25,
      },
    });
    const response = await client.claim('cyr_runner_1234567890abcdef');

    assert.deepEqual(response, { job: null });
    assert.equal(calls, 2);
    assert.deepEqual(delays, [25]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('TrackerClient uses extended retries for terminal callbacks', async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  const delays = [];

  globalThis.fetch = async () => {
    calls += 1;

    if (calls < 4) {
      return Response.json({ error: 'temporary maintenance' }, {
        status: 503,
        statusText: 'Service Unavailable',
      });
    }

    return Response.json({ ok: true });
  };

  try {
    const client = new TrackerClient('https://cyrboard.cyrnix.dev', {
      delay: async (milliseconds) => {
        delays.push(milliseconds);
      },
      retryOptions: {
        attempts: 1,
        initialDelayMs: 10,
        maxDelayMs: 10,
      },
      terminalRetryOptions: {
        attempts: 4,
        initialDelayMs: 10,
        maxDelayMs: 40,
      },
    });
    const response = await client.complete('cyr_runner_1234567890abcdef', {
      jobId: 143,
      resultSummary: 'done',
      resultText: 'done',
    });

    assert.deepEqual(response, { ok: true });
    assert.equal(calls, 4);
    assert.deepEqual(delays, [10, 20, 40]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('TrackerClient does not retry permanent authorization failures', async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;

    return Response.json({ error: 'Forbidden' }, {
      status: 403,
      statusText: 'Forbidden',
    });
  };

  try {
    const client = new TrackerClient('https://cyrboard.cyrnix.dev', {
      retryOptions: {
        attempts: 3,
        initialDelayMs: 1,
        maxDelayMs: 1,
      },
    });

    await assert.rejects(
      () => client.heartbeat('cyr_runner_1234567890abcdef', {
        jobId: 143,
      }),
      /Tracker request failed: 403 Forbidden/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
