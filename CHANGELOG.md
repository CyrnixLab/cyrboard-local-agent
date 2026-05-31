# Changelog

## 0.1.3 - 2026-05-31

- Added `connect --start` to register a runner and immediately enter the polling loop.
- Kept the polling loop alive after temporary claim/network failures and per-job execution failures.
- Improved `status` output with the local config path and explicit start instructions.

## 0.1.2 - 2026-05-31

- Keep sending job heartbeats while a local runner executes a claimed job.
- Prevent long-running local jobs from looking disconnected while the command is still working.

## 0.1.0 - 2026-05-24

- Initial public MVP for Tracker `Local Agent / MCP` jobs.
- Added `connect`, `run-once`, `start`, `status`, and `disconnect` commands.
- Added `codex` and `command` local execution modes.
- Stores runner token in `.cyrboard/local-agent.json` with `0600` permissions.
- Does not store one-time setup tokens.
