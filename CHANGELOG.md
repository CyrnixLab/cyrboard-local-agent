# Changelog

## 0.3.1 - 2026-07-20

- Publish a patch release used to verify the idle automatic update flow from
  `0.3.0` to the next exact version returned by Tracker.

## 0.3.0 - 2026-07-20

- Report the package version on every claim and consume Tracker's required
  `latestVersion` without claiming a job on an outdated worker.
- Run polling under a repository-scoped supervisor that updates only while idle
  and prevents duplicate runner processes with a local lock.
- Install exact official npm releases atomically under `.cyrboard/runtime/`,
  disable lifecycle scripts, validate package identity, and retry failures with
  backoff before restarting the worker.
- Show the running package version in `status`; document the one-time manual
  bootstrap required for versions older than `0.3.0`.

## 0.2.0 - 2026-07-19

- Advertise the versioned `input_attachments_v1` capability for Codex runners while keeping Claude disabled until its dedicated smoke test.
- Download job-scoped PNG, JPEG, PDF, DOCX, XLSX and CSV inputs from same-origin Tracker URLs into private temporary storage.
- Fail closed on unsupported metadata, HTTP/download errors, size or SHA-256 mismatch, and mutation during any Codex or merge-conflict continuation run.
- Pass images through `codex exec --image`, expose verified documents through `--add-dir`, and always remove local copies after success or failure.

## 0.1.14 - 2026-06-30

- Normalize Tracker branch names parsed from prompts and required predecessor input so trailing sentence punctuation does not break `git fetch`/merge operations.
- Add regression coverage for epic child branch lines ending with punctuation.

## 0.1.13 - 2026-06-22

- Merge Tracker-provided required predecessor branches into a task branch before the local AI agent starts work.
- Verify merge-to-epic jobs do not merge a child branch that is missing required predecessor branches.

## 0.1.12 - 2026-06-21

- Retry transient Tracker API failures in the local runner client: network errors, `408`, `429`, and `5xx` gateway/backend responses.
- Use a longer retry budget for terminal job reports (`complete`/`fail`) so deploy-time `502 Bad Gateway` responses do not lose the final job status.
- Keep permanent authorization/setup errors fail-fast.

## 0.1.11 - 2026-06-21

- Resolve local runner base branches from project/job config, `origin/HEAD`, upstream, or existing remote branches instead of falling back to hardcoded `main`.
- Report a clear setup error when the remote repository has no branch that can be used as the job base branch.

## 0.1.10 - 2026-06-08

- Strengthen epic merge-repair continuation prompts with an explicit clean merge-state contract.
- Include `git status --porcelain`, unmerged files, and staged files in unresolved merge diagnostics.
- Cover Tracker-provided Codex model/reasoning overrides in tests.

## 0.1.9 - 2026-06-05

- Make Claude Code local automation non-interactive by default with `bypassPermissions`.
- Add `connect --permission-mode` and show the saved permission mode in `status`.
- Keep job-scoped model overrides tied to the matching local agent so Claude runners do not receive Codex model values.

## 0.1.8 - 2026-06-04

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
