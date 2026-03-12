# Contributing

## Local setup

```bash
npm install
npm run build
```

## Development workflow

```bash
npm run dev
```

`dev` runs both runtime and watch processes concurrently:
- App runtime in development mode (`NODE_ENV=development`)
- Dashboard UI (`vite --watch`)
- CLI bundle (`esbuild --watch`)
- MCP bundle (`esbuild --watch`)

Useful scripts:
- `npm run typecheck`
- `npm test -- --watchman=false`
- `npm run build`
- `npm run ci`

## MCP development

- Build and run MCP server:
  - `npm run build`
  - `npm run mcp`
- Test with MCP Inspector:
  - `npm run mcp:test`
- MCP tool behavior and flow contracts are documented in:
  - `docs/aso-runtime-flows.md`
  - `docs/aso-keyword-fetch-design.md`

## Runtime and environment details

See `.env.example` for optional runtime settings.

Most common variables:
- `ASO_DB_PATH`
- `ASO_CACHE_TTL_HOURS`
- `ASO_APP_CACHE_TTL_HOURS`
- `ASO_KEYWORD_ENRICHMENT_CONCURRENCY`

Runtime files are local under `~/.aso`:
- `aso-db.sqlite`
- `aso-cookies.json`
- `version-cache.json`

## Telemetry and privacy

This project reports runtime errors to Bugsnag for stability monitoring in CLI, MCP, and dashboard runtime paths.

Data sent:
- Error details and stack traces
- Runtime metadata attached by the app (command context and categorized diagnostics)
- Basic runtime/device info collected by Bugsnag SDK

Data not intentionally sent by app logic:
- Apple auth cookies and authorization headers (sensitive headers are redacted in request diagnostics)

## Pull requests

Before opening a PR, run:

```bash
npm run typecheck
npm test -- --watchman=false
npm run build
```

PR expectations:
- Keep changes focused.
- Include tests for behavior changes.
- Update docs in `docs/*.md` and `README.md` when behavior changes.
- Add notable user-impact changes to GitHub Release notes.

## Commit style

No strict commit format is required, but commit messages should be clear and actionable.
