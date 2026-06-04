# Changelog

## 0.1.7 - 2026-06-04

- Enable Codex `workspace-write` network access so local jobs can call Tracker MCP without switching to a broader sandbox.
- Redact job-scoped MCP tokens such as `cyr_mcp_job_*` from CLI output, env dumps, JSON snippets, and authorization headers.

## 0.1.6 - 2026-06-03

- Finalize isolated job branches in the runner after Codex/Claude exits: stage, validate, commit, and push the result branch.
- Create missing remote job branches and pre-merge epic child branches for final epic review jobs.
- Reject unresolved merge conflict markers before reporting a job as completed.

## 0.1.5 - 2026-06-02

- Improved missing Codex/Claude CLI diagnostics for local jobs.

## 0.1.4 - 2026-06-02

- Removed the unsafe `command` execution mode.
- Added `claude` local execution mode for Claude Code.
- Added per-runner and per-job model/reasoning selection for Codex and Claude.

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
