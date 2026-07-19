import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { materializeInputAttachments, verifyInputAttachments } from '../src/attachments.js';

test('materializes, verifies and cleans up an input attachment', async () => {
  const bytes = Buffer.from('city,temp\nKyiv,24\n');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const client = {
    async download(path, token) {
      assert.equal(path, '/tracker/local-runners/jobs/42/input-attachments/file-1');
      assert.equal(token, 'cyr_mcp_job_test');

      return new Response(bytes);
    },
  };
  const materialized = await materializeInputAttachments(client, {
    id: 42,
    inputAttachmentsVersion: 1,
    mcp: { token: 'cyr_mcp_job_test' },
    attachments: [{
      id: 'file-1',
      filename: '../weather.csv',
      fileKind: 'csv',
      mediaType: 'text/csv',
      sizeBytes: bytes.length,
      sha256,
      downloadUrl: '/tracker/local-runners/jobs/42/input-attachments/file-1',
    }],
  });

  assert.equal(await readFile(materialized.files[0].path, 'utf8'), bytes.toString());
  await verifyInputAttachments(materialized.files);
  await writeFile(materialized.files[0].path, 'changed');
  await assert.rejects(() => verifyInputAttachments(materialized.files), /input_attachment_mutated/);
  const directory = materialized.directory;
  await materialized.cleanup();
  await assert.rejects(() => readFile(directory));
});
