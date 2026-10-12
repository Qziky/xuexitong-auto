# Release verification

This document describes reproducible local checks. It contains no account-specific or live-platform acceptance records. Unit tests, a browser fixture, and a successful package build do not prove that every platform page or task type works.

Run the full local verification on Windows with Node.js 24:

```powershell
npm.cmd ci
npm.cmd run release
npm.cmd audit --omit=dev
```

The release command runs TypeScript checking and the test suite, builds and packages the Edge extension, and creates a curated source ZIP with a SHA256 manifest. The package script checks required policy, source, and test files and rejects local evidence/configuration paths. The dependency audit checks production dependencies only.

All committed tests and previews use synthetic fixtures. Live browser and platform behavior must be reported separately and only after a fresh, user-authorized check. Do not add live account records, screenshots, page HTML, or exported logs to this repository.
