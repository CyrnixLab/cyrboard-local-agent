# Contributing

This repository contains the local connector that users run next to their own
source code. Keep changes small, auditable, and explicit.

## Development

```bash
npm test
npm run smoke
```

## Rules

- Do not commit tokens, environment files, or local `.cyrboard/` directories.
- Do not add telemetry or network calls beyond the configured Tracker server.
- Keep dependencies minimal. Prefer Node.js standard library when practical.
- Redact bearer tokens in errors, logs, tests, and fixtures.
- Any change that affects authentication or token storage must update
  `SECURITY.md`.
