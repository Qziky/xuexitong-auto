# Contributing

Thanks for helping improve the project. Keep changes focused and explain user-visible behavior, privacy implications, and any limits in the pull request.

## Development setup

- Windows 10 or later
- Node.js 24 and npm
- Microsoft Edge for optional browser checks

```powershell
npm.cmd ci
npm.cmd run typecheck
npm.cmd run test
npm.cmd run release
npm.cmd audit --omit=dev
```

The preview and tests use synthetic data. Do not add real course names, question text, answers, account identifiers, signed URLs, cookies, screenshots, exported logs, local browser profiles, or API credentials. Keep local diagnostics under the ignored `artifacts/private/` directory and inspect `git status --ignored` before publishing.

For behavior changes, add or update a synthetic fixture and a focused regression test. Preserve the explicit user action boundary between reading, generating a candidate, filling, saving, and submitting. CAPTCHA, rate-limit, login-expiry, and account-mismatch handling must continue to stop without automatic retry or bypass.

## Pull requests

Describe the problem, the change, commands run, and any browser or platform checks not performed. Do not claim a live platform result based only on a unit test or local fixture. The Windows CI workflow runs install, type checking, tests, release packaging, and a production-dependency audit.
