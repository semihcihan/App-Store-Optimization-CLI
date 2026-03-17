# ASO Error Handling Model

## Goal
Define failure boundaries, retry rules, and recovery behavior across CLI, dashboard API, and ASO services.

## Failure Boundaries
- CLI popularity stage (`cli/services/keywords/aso-popularity-service.ts`) handles Search Ads auth/session and popularity failures.
- Dashboard error mapping is centralized in `cli/domain/errors/dashboard-errors.ts` and consumed by both server (`cli/dashboard-server/server.ts`) and UI (`cli/dashboard-ui/app-helpers.ts`).
- Enrichment services (`cli/services/cache-api/services/aso-enrichment-service.ts`, `cli/services/cache-api/services/aso-apple-client.ts`) handle App Store fetch failures and fallback behavior.
- Dashboard keyword/app-doc route handlers are split under `cli/dashboard-server/routes/*`, while auth state and HTTP utilities are isolated in `cli/dashboard-server/auth-state.ts` and `cli/dashboard-server/http-utils.ts`.

## Dashboard Error Codes
- `INVALID_REQUEST`
- `PAYLOAD_TOO_LARGE`
- `AUTH_REQUIRED`
- `AUTH_IN_PROGRESS`
- `TTY_REQUIRED`
- `AUTHORIZATION_FAILED`
- `RATE_LIMITED`
- `REQUEST_TIMEOUT`
- `NETWORK_ERROR`
- `NOT_FOUND`
- `INTERNAL_ERROR`

## Retry Policy
- Shared resilience config lives in `cli/shared/aso-resilience.ts` (env defaults/parsing centralized in `cli/shared/aso-env.ts`).
- Popularity fetch retries transient responses (`429`, `5xx`, `KWS_NO_ORG_CONTENT_PROVIDERS`) and transient network errors.
- App Store web fetches retry `429`, `5xx`, and transient network errors with jittered exponential backoff.
- Startup refresh manager retries each unit once and records failures without crashing runtime.
- `keywordPipelineService` isolates terminal failures per keyword and stores normalized failure metadata in `aso_keyword_failures` via `keywordWriteRepository` (single write owner).

## Recovery Behavior
- Dashboard add-keyword:
  - If auth is invalid in stage 1, return `AUTH_REQUIRED` (no interactive prompt in request path).
- If stage-2 enrichment fails, stage-1 writes remain; caller can retry later.
- Dashboard retry-failed endpoint retries only failed keywords for selected app/country and returns `{ retriedCount, succeededCount, failedCount }`.
- Top-app and competitor app-doc hydration (`/api/aso/top-apps`, `/api/aso/apps`):
  - Missing/expired competitor docs trigger backend fetch.
  - On hydration failure, return available cached competitor data when possible.
- Owned app list hydration (`/api/apps`):
  - Stale owned rows trigger localized app-page fetch.
  - On hydration failure, keep cached owned row and continue serving `/api/apps`.
- Dashboard app search (`GET /api/aso/apps/search`):
  - Empty search terms return an empty list.
  - If search-order lookup fails, numeric app-id input can still hydrate via direct lookup.
  - If final hydration fails, return `NETWORK_ERROR`.
- CLI keyword fetch:
  - Returns `{ items, failedKeywords }` for partial success.
  - Hard-fails only when all requested keywords fail.
- `aso reset-credentials` clears local auth state explicitly.
- `aso auth`:
  - Attempts cached-session reuse before full credential login.
  - Reuses keychain credentials first when full login is required.
  - Clears invalid keychain credentials and reprompts when Apple rejects stored creds.

## Observability
- Apple HTTP calls carry trace context.
- Bugsnag Apple metadata includes the latest `10` redacted Apple HTTP calls plus up to `3` latest non-success calls when they have already rotated out of that `10`-call window.
- Apple contract-drift reporting is centralized: when expected Apple response shapes/flow contracts drift, the runtime emits Bugsnag events classified as `apple_contract_change` with endpoint + expected-vs-actual metadata.
- Contract-drift reporting covers all Apple API surfaces used by ASO runtime:
  - Apple auth/session bootstrap and 2FA flow
  - Search Ads popularity endpoint
  - App Store search page parsing
  - MZSearch order payload parsing
  - App lookup payload parsing
  - Localized app-page `serialized-server-data` parsing (title/subtitle/rating/ratingCount)
- Contract-drift events are deduped for `15` minutes per unique signature (`provider + operation + endpoint + drift kind + status bucket`) to reduce alert spam during repeated failures.
- Bugsnag redaction is centralized at SDK startup via global `redactedKeys` and `onError` sanitization before event delivery (including nested metadata and keychain command-arg payloads such as `spawnargs` values after `-w`).
- Dashboard server reports failures with structured metadata (path, phase, counts).
- Bugsnag reporting uses an actionability allowlist:
  - reports internal bugs, Apple contract-change signals, and terminal upstream failures
  - suppresses expected user-flow noise (invalid credentials, expected auth/API `4xx`, validation issues)
- Dashboard UI reports only actionable API failures (for example: `5xx`, network/runtime exceptions, malformed success payloads); expected `4xx` flows are suppressed.
- Dashboard UI Bugsnag metadata includes the latest `10` redacted dashboard API traces (`method`, `path`, `durationMs`, response/error summary) to aid transport-failure debugging when no HTTP response is returned.
- MCP reports runtime/transport/parse-contract failures; non-zero child CLI exits are suppressed by default.
- Startup refresh state (`status`, counters, timestamps, lastError) is exposed via API.
- CLI ASO retry/fallback diagnostics (auth, popularity, and enrichment fallback traces) are logged at `debug`; user-facing flows should surface terminal outcomes and actionable prompts/errors instead of intermediate warning noise.

## Request Payload Limits
- Dashboard JSON request bodies are capped at `1 MiB`.
- Requests above this limit return `413` with `errorCode="PAYLOAD_TOO_LARGE"`.

## Auth Persistence Contract
- Cookie persistence is atomic (temp file + rename).
- Cookie persistence/load prunes expired cookies.
- Popularity requests use URL-scoped cookie selection (domain/path/secure aware), not a flat all-cookies header.

## Design Choice
Prefer partial progress when safe (preserve useful local data), but fail explicitly for auth/contract errors so automation clients can recover deterministically.
