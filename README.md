# Cyrnix Lab Local Agent

Local runner connector for Cyrnix/Cyrboard Tracker `Local Agent / MCP` jobs.

The connector runs on a developer machine, inside a project repository. It never
opens inbound ports. It registers with Tracker once, polls jobs over HTTPS, runs
the selected local AI tool, and reports status back to Tracker.

## Install

```bash
npx @cyrnixlab/cyrboard-local-agent --help
```

## Connect a repository

Copy the one-time command from the Tracker project AI settings and run it from
the repository root:

```bash
npx @cyrnixlab/cyrboard-local-agent connect \
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
`.cyrboard/worktrees/`. Codex/Claude edits files and runs checks there; after the
CLI exits, the runner stages, validates, commits, and pushes the configured job
branch. For epic review jobs, the runner also creates the missing epic branch
when needed and pre-merges child branches listed in the job prompt.

For Codex, the default sandbox remains `workspace-write`. The runner also passes
Codex workspace network access so the CLI can call Tracker MCP during the job.

## Run

```bash
npx @cyrnixlab/cyrboard-local-agent start
```

For a single claim/execute/report cycle:

```bash
npx @cyrnixlab/cyrboard-local-agent run-once
```

To verify local configuration without starting the polling loop:

```bash
npx @cyrnixlab/cyrboard-local-agent status
```

## Agent modes

- `codex`: runs `codex exec` in the repository.
- `claude`: runs Claude Code in the repository.

`--model` and `--reasoning` are optional local defaults. Tracker job input can
override them per AI executor/job.

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
