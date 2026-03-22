# Contributing

## Local setup

```bash
nvm use
npm install
npm run build
```

Runtime requirement:
- Runtime: Node.js `>=20.18.1`
- Local development/build: Node.js `>=20.19.0` (enforced by script checks)

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
- `npm run test:coverage -- --watchman=false`
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
Default values and parsing live in `cli/shared/aso-env.ts`.

Most common variables:
- `ASO_DB_PATH`
- `ASO_KEYWORD_ORDER_TTL_HOURS`
- `ASO_POPULARITY_CACHE_TTL_HOURS`
- `ASO_APP_CACHE_TTL_HOURS`
- `ASO_OWNED_APP_DOC_REFRESH_MAX_AGE_HOURS`
- `ASO_KEYWORD_ENRICHMENT_CONCURRENCY`

Runtime files are local under `~/.aso`:
- `aso-db.sqlite`
- `aso-cookies.json`
- `version-cache.json`

## Telemetry and privacy

This project reports runtime errors to Bugsnag for stability monitoring in CLI, MCP, and dashboard runtime paths.

Release behavior:
- `BUGSNAG_API_KEY` GitHub Secret is required in release workflow.
- Release CI injects that key into telemetry source before build/publish, enforcing exactly one placeholder replacement and failing if placeholder text remains in `cli/dist`.

Data sent:
- Error details and stack traces
- Runtime metadata attached by the app (command context and categorized diagnostics)
- Basic runtime/device info collected by Bugsnag SDK
- Telemetry classification metadata (`actionable_bug`, `apple_contract_change`, `upstream_terminal_failure`, etc.)

Data not intentionally sent by app logic:
- Apple auth cookies and authorization headers (sensitive headers are redacted in request diagnostics)
- Credential-like fields in telemetry metadata/error payloads (globally scrubbed by Bugsnag SDK-level redaction before send)

## Pull requests

Before opening a PR, run:

```bash
npm run typecheck
npm test -- --watchman=false
npm run test:coverage -- --watchman=false
npm run build
```

PR expectations:
- Keep changes focused.
- Include tests for behavior changes.
- Update docs in `docs/*.md` and `README.md` when behavior changes.
- Add notable user-impact changes to GitHub Release notes.

## Commit style

No strict commit format is required, but commit messages should be clear and actionable.
