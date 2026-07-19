import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

const MAX_FILES = 20;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 250 * 1024 * 1024;
const SUPPORTED_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'text/plain',
]);

export async function materializeInputAttachments(client, job) {
  const descriptors = Array.isArray(job.attachments) ? job.attachments : [];

  if (descriptors.length === 0) {
    return { directory: null, files: [], cleanup: async () => {} };
  }

  validateContract(job, descriptors);
  const directory = await mkdtemp(join(tmpdir(), `cyrboard-job-${job.id}-`));
  await chmod(directory, 0o700);
  const files = [];

  try {
    for (let index = 0; index < descriptors.length; index += 1) {
      const descriptor = descriptors[index];
      const safeName = sanitizeFilename(descriptor.filename, index);
      const path = join(directory, `${String(index + 1).padStart(2, '0')}-${safeName}`);
      const response = await client.download(descriptor.downloadUrl, job.mcp?.token || '');
      const hash = createHash('sha256');
      let bytes = 0;
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;

          if (bytes > descriptor.sizeBytes || bytes > MAX_FILE_BYTES) {
            callback(new Error('input_attachment_size_mismatch'));
            return;
          }

          hash.update(chunk);
          callback(null, chunk);
        },
      });

      await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(path, { mode: 0o600, flags: 'wx' }));

      if (bytes !== descriptor.sizeBytes) {
        throw new Error('input_attachment_size_mismatch');
      }

      if (hash.digest('hex') !== descriptor.sha256.toLowerCase()) {
        throw new Error('input_attachment_checksum_mismatch');
      }

      files.push({ ...descriptor, path });
    }

    await verifyInputAttachments(files);

    return {
      directory,
      files,
      cleanup: async () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyInputAttachments(files) {
  for (const file of files) {
    const details = await stat(file.path).catch(() => null);

    if (details === null || !details.isFile() || details.size !== file.sizeBytes) {
      throw new Error('input_attachment_mutated');
    }

    const handle = await open(file.path, 'r');
    const hash = createHash('sha256');

    try {
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        hash.update(chunk);
      }
    } finally {
      await handle.close();
    }

    if (hash.digest('hex') !== file.sha256.toLowerCase()) {
      throw new Error('input_attachment_mutated');
    }
  }
}

function validateContract(job, descriptors) {
  if (job.inputAttachmentsVersion !== 1 || !job.mcp?.token) {
    throw new Error('input_attachment_protocol_unsupported');
  }

  if (descriptors.length > MAX_FILES) {
    throw new Error('input_attachment_limit_exceeded');
  }

  let totalBytes = 0;

  for (const descriptor of descriptors) {
    if (!SUPPORTED_MEDIA_TYPES.has(descriptor.mediaType)) {
      throw new Error('input_attachment_type_unsupported');
    }

    if (!Number.isSafeInteger(descriptor.sizeBytes) || descriptor.sizeBytes <= 0 || descriptor.sizeBytes > MAX_FILE_BYTES) {
      throw new Error('input_attachment_limit_exceeded');
    }

    if (!/^[a-f0-9]{64}$/i.test(String(descriptor.sha256 || '')) || typeof descriptor.downloadUrl !== 'string') {
      throw new Error('input_attachment_invalid_metadata');
    }

    totalBytes += descriptor.sizeBytes;
  }

  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new Error('input_attachment_limit_exceeded');
  }
}

function sanitizeFilename(value, index) {
  const normalized = basename(String(value || '')).replace(/[^\p{L}\p{N}._ -]+/gu, '_').trim();

  return (normalized || `attachment-${index + 1}`).slice(0, 180);
}
