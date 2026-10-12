# Local debugging

The optional Edge debugging scripts use a separate browser profile and local development server. Start with:

```powershell
npm.cmd ci
npm.cmd run debug:edge
```

The setup writes its MCP configuration beneath the project `.codex/` directory. The generated `config.toml`, browser profile, logs, reports, and screenshots are local-only and must not be committed. `.gitignore` excludes the generated configuration and `artifacts/` directory.

Use synthetic pages and the built-in browser fixture for routine development. The `debug:live` helper is opt-in and read-only by default; any live operation requires an explicit `--execute` flag and a developer-supplied exact task allowlist through the `XUEXITONG_TEST_*` environment variables. Keep that allowlist private, use only tasks you are authorized to access, and stop if the platform requests verification, rate-limits access, or account ownership is unclear.

The extension's user-facing steps remain separate: reading, generating a proposal, filling, saving, and submitting. Debug tooling does not turn a local action into evidence that the platform accepted a task.
