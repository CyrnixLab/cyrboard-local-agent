#!/usr/bin/env node

import { formatCliError, main } from '../src/cli.js';

main(process.argv.slice(2)).catch((error) => {
  console.error(formatCliError(error));
  process.exitCode = 1;
});
