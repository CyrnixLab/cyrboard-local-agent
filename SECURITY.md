# Security Policy

## Supported versions

The current `0.x` line is an early MVP. Security fixes are published in the
latest available version.

## Reporting a vulnerability

Report security issues privately by email:

```text
cyrboard@cyrnix.dev
```

Please include:

- package version;
- operating system;
- Tracker server version, if relevant;
- exact command that triggered the issue, with tokens redacted;
- impact and reproduction steps.

Do not open public GitHub issues for vulnerabilities until we have coordinated a
fix.

## Token handling

- Setup tokens are short-lived and should not be stored by this connector.
- Runner tokens are stored only in `.cyrboard/local-agent.json`.
- `.cyrboard/` must not be committed to a project repository.
- Logs and error messages should not print bearer tokens.
