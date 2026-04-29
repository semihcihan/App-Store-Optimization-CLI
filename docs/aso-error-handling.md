# ASO Error Handling Model

## Goal
Define failure boundaries, retry rules, and recovery behavior across CLI, dashboard API, and ASO services.

## Failure Boundaries
- CLI popularity stage (`cli/services/keywords/aso-popularity-service.ts`) handles Search Ads auth/session and popularity failures.
- Dashboard error mapping is centralized in `cli/domain/errors/dashboard-errors.ts` and consumed by both server (`cli/dashboard-server/server.ts`) and UI (`cli/dashboard-ui/app-helpers.ts`).
- Enrichment services (`cli/services/cache-api/services/aso-enrichment-service.ts`, `cli/services/cache-api/services/aso-apple-client.ts`) handle App Store fetch failures and fallback behavior.
- Dashboard keyword/app-doc route handlers are split under `cli/dashboard-server/routes/*`, while auth state and HTTP utilities are isolated in `cli/dashboard-server/auth-state.ts` and `cli/dashboard-server/http-utils.ts`.
- Shared setup/auth prompts are emitted by services and transported through either CLI prompts or dashboard prompt sessions; browser UX does not fork the auth logic.

## Dashboard Error Codes
- `INVALID_REQUEST`
- `PAYLOAD_TOO_LARGE`
- `AUTH_REQUIRED`
- `AUTH_IN_PROGRESS`
- `TTY_REQUIRED`
- `PRIMARY_APP_ID_RECONFIGURE_REQUIRED`
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
- Enrichment applies one bounded retry/backoff cycle for competitive keywords when top-5 difficulty docs are incomplete (`reasonCode=INSUFFICIENT_DOCS` when still unresolved).
- Startup refresh manager retries each unit once and records failures without crashing runtime.
- Startup refresh auth failures are exposed as structured refresh-status state so the dashboard can prompt for reauthentication instead of silently stopping.
- Startup refresh auth failures reuse the same dashboard reauthentication UX as add-keyword: one automatic auth-start attempt, then shared browser prompt / retry handling if user input is needed.
- `keywordPipelineService` isolates terminal failures per keyword and stores normalized failure metadata in `aso_keyword_failures` via `keywordWriteRepository` (single write owner).

## Recovery Behavior
- Dashboard add-keyword:
  - If auth is invalid in stage 1, return `AUTH_REQUIRED` (no interactive prompt in request path).
  - If the configured Primary App ID is inaccessible for the current Apple Ads account, return `PRIMARY_APP_ID_RECONFIGURE_REQUIRED` so the dashboard can reopen the shared Primary App ID setup flow.
- If stage-2 enrichment fails, stage-1 writes remain; caller can retry later.
- Stage-2 enrichment writes are per-keyword progressive: successful keywords are visible in cache/UI polling as soon as that keyword finishes, while other keywords continue running.
- For `appCount >= 5`, enrichment does not persist fallback `difficultyScore=1` when top-5 docs are incomplete; it records a retryable enrichment failure instead.
- If dashboard background stage-2 enrichment throws before returning per-keyword results, pending keywords are marked as `enrichment` failures in `aso_keyword_failures` so UI does not stay indefinitely in `Calculating...` and retry-failed remains available.
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
  - Returns `{ items, failedKeywords, filteredOut }` for partial success.
  - Hard-fails only when all requested keywords fail.
- `aso reset-credentials` clears local auth state explicitly.
- `aso auth`:
  - Attempts cached-session reuse before full credential login.
  - Reuses keychain credentials first when full login is required.
  - Clears invalid keychain credentials and reprompts when Apple rejects stored creds.
- Plain `aso`:
  - Starts dashboard even when Primary App ID is missing.
  - Recovers missing Primary App ID through dashboard setup state instead of requiring an immediate terminal prompt.

## Observability
- Apple HTTP calls carry trace context.
- Bugsnag Apple metadata includes the latest `3` redacted Apple HTTP calls plus up to `3` latest non-success calls when they have already rotated out of that `3`-call window.
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
- Runtime telemetry startup resolves Bugsnag API key in this order: explicit runtime option, runtime `BUGSNAG_API_KEY`, then packaged fallback key injected in release CI from GitHub Secret `BUGSNAG_API_KEY`; startup is skipped with a warning only when all are missing.
- Runtime telemetry startup resolves PostHog settings before shared init: API key from `ASO_POSTHOG_API_KEY` (or packaged fallback when unset) plus optional `ASO_POSTHOG_HOST` override; `posthog-shared` passes host only when explicitly provided and otherwise relies on the PostHog SDK default host, and initialization is skipped in development mode.
- CLI usage tracking persists a stable PostHog `distinctId` in `~/.aso/config.json` (`userId`) and emits `cli_started` with `$set_once.first_seen_at` plus `$set.last_seen_at/cli_version/node_version` on each process start.
- CLI process exit paths explicitly call PostHog shutdown before exiting so short-lived command runs flush queued analytics events.
- Release pipeline enforces packaged-key integrity by requiring the secret, replacing exactly one source placeholder, and failing if placeholder text remains in built artifacts.
- Dashboard Bugsnag startup enables browser session tracking and includes `request`/`navigation` breadcrumbs; CLI/MCP keep stricter defaults.
- Dashboard server reports failures with structured metadata (path, phase, counts).
- Dashboard server suppresses debug request/response logging for `GET` API routes to reduce dashboard poll noise; mutation (`POST`/`DELETE`) debug logging remains enabled.
- Apple debug logging emphasizes compact derived-stage summaries (source mode + result counts for order/enrichment/app-lookup) instead of raw full response payload dumps.
- Bugsnag reporting uses an actionability allowlist:
  - reports internal bugs, Apple contract-change signals, and terminal upstream failures
  - suppresses expected flow/validation noise (`4xx`, validation issues)
  - reports selected user-fault noise as low-severity (`info`, handled) for visibility without paging
- Apple auth `401` responses carrying Apple service code `-20101` are classified as `invalid_credentials` (`user_fault`) instead of contract drift.
- Apple 2FA challenge payloads with service code `-28248` (verification code delivery unavailable) are classified as verification-delivery `user_fault` instead of contract drift.
- Apple HTTP trace metadata attached to Bugsnag is size-bounded (string/array/object/depth truncation) so contract-drift events retain actionable metadata instead of being dropped for oversized payloads.
- Dashboard UI reports only actionable API failures (for example: `5xx`, network/runtime exceptions, malformed success payloads); expected `4xx` flows are suppressed.
- Dashboard UI transport/setup noise (`/api/aso/auth/status` network fetch failures and repeated local search failures) is reclassified as `user_fault` and deduped in-process per signature for `60` seconds.
- MCP parse-json shape drift (`MCP expected JSON output from aso keywords`) is reclassified as `user_fault` and deduped in the shared reporter path for `60` seconds.
- Dashboard UI Bugsnag metadata includes only failed local dashboard traces by default (max `3`); set `ASO_BUGSNAG_VERBOSE_TRACES=1` to include full recent local trace bundles for deep debugging.
- MCP reports runtime/transport/parse-contract failures; non-zero child CLI exits are suppressed by default.
- Startup refresh state (`status`, counters, timestamps, lastError) is exposed via API.
- Startup refresh can be restarted explicitly from the dashboard after recovery (`POST /api/aso/refresh/start`).
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
