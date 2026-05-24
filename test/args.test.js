import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, optionalInt, requiredString } from '../src/args.js';

test('parseArgs supports flags and values', () => {
  const args = parseArgs(['connect', '--server', 'http://localhost:8182', '--project-id=1', '--verbose']);

  assert.deepEqual(args._, ['connect']);
  assert.equal(requiredString(args, 'server'), 'http://localhost:8182');
  assert.equal(optionalInt(args, 'project-id', 0), 1);
  assert.equal(args.verbose, true);
});
