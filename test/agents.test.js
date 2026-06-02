import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from '../src/agents.js';

test('runAgent reports missing Codex CLI with actionable message', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cyrboard-local-agent-'));
  const originalPath = process.env.PATH;
  process.env.PATH = '/tmp/cyrboard-local-agent-missing-bin';

  try {
    await assert.rejects(
      () => runAgent(
        {
          agent: 'codex',
          serverUrl: 'https://tracker.example.com',
        },
        {
          id: 1,
          projectId: 1,
          issueId: 1,
          jobKind: 'plan',
          commandId: 'cmd-test',
          input: {},
        },
        repo,
      ),
      /Codex CLI not found/,
    );
  } finally {
    process.env.PATH = originalPath;
    await rm(repo, { recursive: true, force: true });
  }
});
