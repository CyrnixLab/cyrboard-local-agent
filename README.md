# Cyrnix Lab Local Agent

Local runner connector for Cyrnix/Cyrboard Tracker `Local Agent / MCP` jobs.

The connector runs on a developer machine, inside a project repository. It never
opens inbound ports. It registers with Tracker once, polls jobs over HTTPS, runs
the selected local AI tool, and reports status back to Tracker.

## Install

```bash
npx --yes @cyrnixlab/cyrboard-local-agent@latest --help
```

## Connect a repository

Copy the one-time command from the Tracker project AI settings and run it from
the repository root:

```bash
npx --yes @cyrnixlab/cyrboard-local-agent@latest connect \
  --server https://tracker.example.com \
  --project-id 1 \
  --token cyr_mcp_xxx \
  --repo . \
  --agent codex \
  --model gpt-5.2-codex \
  --reasoning xhigh \
  --start \
  --interval 10
```

The setup token is short-lived and is not stored. After registration the local
config stores only the runner token in `.cyrboard/local-agent.json` with `0600`
permissions.

With `--start`, the command stays in the foreground and keeps polling Tracker
for queued `local_mcp` jobs. Keep the terminal open while this runner should
process jobs.

For branch-based jobs, the runner works in an isolated clone under
`.cyrboard/worktrees/`. Codex, Claude, or SourceCraft edits files and runs checks there; after the
CLI exits, the runner stages, validates, commits, and pushes the configured job
branch. For epic review jobs, the runner also creates the missing epic branch
when needed and pre-merges child branches listed in the job prompt.

For Codex, the default sandbox remains `workspace-write`. The runner also passes
Codex workspace network access so the CLI can call Tracker MCP during the job.

Codex runners also accept user input attachments from Tracker: PNG/JPEG images,
PDF, DOCX, XLSX and CSV. The runner downloads every file before starting Codex,
verifies its declared size and SHA-256, and stores it outside the execution
worktree with private permissions. Images are passed with `codex exec --image`;
the verified attachment directory is added with `--add-dir` for documents. The
files are checked again after every agent run and removed in `finally`.

Attachment capability is intentionally not advertised in `claude` mode yet.
Tracker therefore leaves attachment jobs queued for a compatible Codex runner.

## Automatic updates

The foreground `start` command runs a small supervisor and a job worker. Every
idle claim sends the installed package version to Tracker. Tracker returns its
current `latestVersion`; when a newer stable release is required it does not
assign a job, and the supervisor installs that exact npm package version under
`.cyrboard/runtime/` before restarting the worker.

Updates never interrupt an active Codex, Claude, or SourceCraft process. A repository-level
process lock also prevents two agents from polling with the same local config.
If npm is temporarily unavailable, the supervisor keeps the old runtime,
retries with backoff, and does not process jobs until it reaches the version
required by Tracker.

Versions older than `0.3.0` predate the updater and require one manual restart:

```bash
npx --yes @cyrnixlab/cyrboard-local-agent@latest start --repo .
```

After that bootstrap update, later releases are installed automatically.

## Run

```bash
npx --yes @cyrnixlab/cyrboard-local-agent@latest start
```

For a single claim/execute/report cycle:

```bash
npx --yes @cyrnixlab/cyrboard-local-agent@latest run-once
```

To verify local configuration without starting the polling loop:

```bash
npx --yes @cyrnixlab/cyrboard-local-agent@latest status
```

## Agent modes

- `codex`: runs `codex exec` in the repository.
- `claude`: runs Claude Code in the repository.
- `sourcecraft`: runs the SourceCraft AI agent headlessly through structured
  `src code -- run --format json` output and returns only its final answer.

`--model` and `--reasoning` are optional local defaults. Tracker job input can
override them per AI executor/job.

For Claude Code, the default permission mode is `bypassPermissions` so
non-interactive jobs can run shell checks. Override it with
`--permission-mode <mode>` if a repository needs stricter local behavior.

For SourceCraft, install and authenticate `src` before connecting the runner:

```bash
curl -fsSL https://s3.yandexcloud.net/sourcecraft-cli/install.sh | sh
src
src auth login
src do "Кратко опиши этот репозиторий."
```

The `src` onboarding can use browser-based IAM authentication or a Personal
Access Token for headless environments. SourceCraft credentials remain in the
CLI keyring/config on the developer machine; Cyrboard stores neither IAM nor PAT
credentials. Tracker maps SourceCraft models to the documented CLI values
`ds` (Default), `ds-alt` (Experimental), and `legacy`; reasoning is not passed
because the SourceCraft CLI integration has no compatible separate reasoning
flag.

Supported reasoning values:

- `low`
- `medium`
- `high`
- `xhigh`

The child process receives:

- `CYRBOARD_SERVER`
- `CYRBOARD_JOB_ID`
- `CYRBOARD_PROJECT_ID`
- `CYRBOARD_ISSUE_ID`
- `CYRBOARD_JOB_KIND`
- `CYRBOARD_BRANCH_NAME`
- `CYRBOARD_JOB_PROMPT_PATH`
- `CYRBOARD_JOB_RESULT_PATH`
- `CYRBOARD_MCP_ENDPOINT`
- `CYRBOARD_MCP_TOKEN`
- `CYRBOARD_MCP_TOKEN_ID`
- `CYRBOARD_MCP_SCOPES`
- `CYRBOARD_MCP_EXPIRES_AFTER_LAST_HEARTBEAT_SECONDS`

`CYRBOARD_MCP_TOKEN` is issued per claimed job. It is valid only while the job is
active and for a short window after the latest heartbeat. Do not print it in
logs, comments, artifacts, or commits.

## Security model

- No inbound connection to the developer machine.
- No secrets are committed or shipped in this repository.
- The setup token is used only for `/tracker/local-runners/register`.
- Tracker returns a separate job-scoped MCP token on `/tracker/local-runners/claim`.
- Attachment downloads are same-origin, authenticated with that exact job token,
  size/hash verified, stored outside the worktree, and never included in `git add`.
- Automatic updates install only the hardcoded official npm package at an exact
  semantic version returned by Tracker; npm lifecycle scripts are disabled.
- The long-lived runner token is local to the repository checkout.
- `.cyrboard/` should be ignored by Git.
- Revoke a runner from the Tracker project AI integration page.

## Publishing

The package is intended to be published under the npm scope `@cyrnixlab`:

```bash
npm test
npm run smoke
npm pack --dry-run
npm publish --access public
```

Before publishing, make sure the GitHub repository URL in `package.json`
matches the public repository that hosts this code.

Publish and verify the npm package before configuring
`TRACKER_LOCAL_RUNNER_LATEST_VERSION` to the new version on Tracker. Reversing
that order blocks old runners while the requested package is still unavailable.
