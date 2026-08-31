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
- Popularity fetch retries transient responses (`429`, `5xx`, `KWS_NO_ORG_CONTENT_PROVIDERS`) and transient network errors with bounded request attempts (default: 2 total attempts, i.e. one retry).
- App Store web fetches retry `429`, `5xx`, and transient network errors with jittered exponential backoff using the same bounded request-attempt policy (default: 2 total attempts).
- Popularity batch isolation requests (`one keyword per request` after a terminal batch failure) run single-attempt (`maxAttempts=1`) to avoid retry multiplication.
- Enrichment applies one bounded retry/backoff cycle for competitive keywords when top-5 difficulty docs are incomplete (`reasonCode=INSUFFICIENT_DOCS` when still unresolved).
- Enrichment applies a short in-process cooldown for top-app IDs that still return incomplete lookup docs, so nearby keywords do not repeat the same expensive lookup loop immediately.
- App-doc hydration falls back to iTunes Lookup for malformed or incomplete App Store lookup results, but not for endpoint-specific unavailable results.
- Startup refresh manager retries each unit once for transient non-auth failures; it does not retry exhausted `All keywords failed (...)` batch failures, and auth-required failures are terminal for the current run and stop remaining batches.
- Startup refresh auth failures are exposed as structured refresh-status state so the dashboard can prompt for reauthentication instead of silently stopping.
- Dashboard keyword mutation auth failures reuse the same dashboard reauthentication UX: add-keyword, retry-failed, and startup refresh each get one automatic auth-start attempt, then shared browser prompt / retry handling if user input is needed. Add-keyword and retry-failed resume the original dashboard mutation once after auth succeeds.
- `keywordPipelineService` isolates terminal failures per keyword and stores normalized failure metadata in `aso_keyword_failures` via `keywordWriteRepository` (single write owner).

## Recovery Behavior

- Dashboard add-keyword:
  - If auth is invalid in stage 1, return `AUTH_REQUIRED` or `AUTH_IN_PROGRESS` (no interactive prompt in request path).
  - After dashboard reauthentication succeeds, retry the original add once against the originally selected app/country.
  - If the configured Primary App ID is inaccessible for the current Apple Ads account, return `PRIMARY_APP_ID_RECONFIGURE_REQUIRED` so the dashboard can reopen the shared Primary App ID setup flow.
- Dashboard retry-failed:
  - If auth is invalid, return `AUTH_REQUIRED` or `AUTH_IN_PROGRESS` (no interactive prompt in request path); the browser starts the shared reauthentication flow and retries the original mutation once after auth succeeds.
- Dashboard startup-refresh auth recovery:
  - While refresh status reports `requiresReauthentication=true`, keyword mutations (`Add Keywords`, `Retry Failed`) are disabled until reauthentication succeeds.
- If stage-2 enrichment fails, stage-1 writes remain; caller can retry later.
- Stage-2 enrichment writes are per-keyword progressive: successful keywords are visible in cache/UI polling as soon as that keyword finishes, while other keywords continue running.
- For `appCount >= 5`, enrichment does not persist fallback `difficultyScore=1` when top-5 docs are incomplete; it records a retryable enrichment failure instead.
- If dashboard background stage-2 enrichment throws before returning per-keyword results, pending keywords are marked as `enrichment` failures in `aso_keyword_failures` so UI does not stay indefinitely in `Calculating...` and retry-failed remains available.
- Dashboard retry-failed endpoint retries only failed keywords for selected app/country and returns `{ retriedCount, succeededCount, failedCount }`; success/failure counts come from the final persisted failure state, so `succeededCount + failedCount = retriedCount`.
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
- Apple contract-drift reporting is centralized: every genuine Apple response-shape/flow change emits a Bugsnag event classified as `apple_contract_change`, including drift recovered by fallback. Events carry sanitized endpoint + expected-vs-actual metadata, `driftKind`, `recoveryOutcome`, `fallbackSource`, and operation-level terminality.
- Contract-drift reporting covers all Apple API surfaces used by ASO runtime:
  - Apple auth/session bootstrap and 2FA flow
  - Search Ads popularity endpoint
  - App Store search page parsing
  - MZSearch order payload parsing
  - App lookup payload parsing
  - Localized app-page `serialized-server-data` parsing (title/subtitle/rating/ratingCount)
- A missing search-page `nextPage` is an expected partial-response fallback, not contract drift; usable primary order and lockups are retained while MZSearch is queried only for count. Other malformed or missing search-page structures remain reportable.
- `nextPage` tail IDs do not make a missing or malformed leading search shelf usable. In that case, usable documents are retained while MZSearch supplies the complete order and count.
- Structurally valid empty search results are expected results, not drift. Missing/malformed shelves, lockups, present `nextPage.results`, MZSearch bubbles/results, and popularity payloads remain reportable while usable entries are retained.
- App lookup `404`, `itemNotAvailable` plist, and `unsupported_product_page` responses are endpoint-specific unavailable results: they are not drift, do not fall back to iTunes Lookup, and do not produce cacheable documents. Other malformed successful app-lookup payloads are reported after the iTunes Lookup fallback outcome is known.
- An empty MZSearch fallback contradicting non-empty primary order/documents is reported as contract drift and leaves count unresolved; empty MZSearch resolves to zero only when primary also contains no apps.
- Contract-drift events are deduped for `15` minutes per unique signature (`provider + operation + endpoint + drift kind + status bucket + recovery outcome`) to reduce alert spam without allowing a recovered occurrence to suppress a later terminal occurrence.
- Transport failures (`429`, `5xx`, timeout, and network failures) never enter the contract-drift reporter. Retries and fallback resolution determine whether they remain non-terminal or become a separately classified terminal upstream failure.
- Bugsnag redaction is centralized at SDK startup via global `redactedKeys` and `onError` sanitization before event delivery (including nested metadata and keychain command-arg payloads such as `spawnargs` values after `-w`).
- Runtime telemetry startup resolves Bugsnag API key in this order: explicit runtime option, runtime `BUGSNAG_API_KEY`, then packaged fallback key injected in release CI from GitHub Secret `BUGSNAG_API_KEY`; startup is skipped with a warning only when all are missing.
- Runtime telemetry startup resolves PostHog settings before shared init: API key from `ASO_POSTHOG_API_KEY` (or packaged fallback when unset) plus optional `ASO_POSTHOG_HOST` override; `posthog-shared` passes host only when explicitly provided and otherwise relies on the PostHog SDK default host, and initialization is skipped in development mode.
- CLI usage tracking persists a stable PostHog `distinctId` in `~/.aso/config.json` (`userId`) and emits `cli_started` with `$set_once.first_seen_at` plus `$set.last_seen_at/cli_version/node_version` on each process start.
- CLI process exit paths explicitly call PostHog shutdown before exiting so short-lived command runs flush queued analytics events.
- Release pipeline pins its npm toolchain to a Node-compatible version and enforces packaged-key integrity by requiring the secret, replacing exactly one source placeholder, and failing if placeholder text remains in built artifacts.
- Dashboard Bugsnag startup captures frontend runtime failures with browser session tracking and `request`/`navigation` breadcrumbs; it does not manually report dashboard API failures.
- The local dashboard server is the sole reporting owner for dashboard API, Apple, database, and upstream failures, preventing the browser from echoing the same failure. It reports failures with structured metadata (path, phase, counts).
- Dashboard server suppresses debug request/response logging for `GET` API routes to reduce dashboard poll noise; mutation (`POST`/`DELETE`) debug logging remains enabled.
- Apple debug logging emphasizes compact derived-stage summaries (source mode + result counts for order/enrichment/app-lookup) instead of raw full response payload dumps.
- Bugsnag reporting uses an actionability allowlist:
  - reports internal bugs, all genuine Apple contract-change signals, and terminal upstream failures
  - suppresses expected flow/validation noise (`4xx`, validation issues)
  - suppresses known user-fault noise such as invalid credentials and malformed CLI input
- CLI telemetry suppresses expected setup/auth outcomes (reauthentication required, missing/inaccessible Primary App ID, interactive-TTY requirements), all-keyword `4xx` failures, unsupported Node runtimes, and closed stdout/stderr pipes.
- Transient Apple auth responses (`429`/`5xx`) are reported once as terminal upstream failures rather than both upstream failures and contract drift.
- Apple auth `401` responses carrying Apple service code `-20101` are classified as `invalid_credentials` (`user_fault`) instead of contract drift.
- Apple auth responses carrying the known `itctx` account-access condition are classified as `account_setup_required` (`expected_flow`), do not attempt legacy fallback, and are not reported as contract drift.
- Unknown auth responses that propagate are reported once by the outer CLI/server boundary. SIRP drift is reported manually only when legacy fallback recovers it or replaces it with a different failure.
- Apple 2FA challenge payloads with service code `-28248` (verification code delivery unavailable) are classified as verification-delivery `user_fault` instead of contract drift.
- Apple HTTP trace metadata attached to Bugsnag is size-bounded (string/array/object/depth truncation) so contract-drift events retain actionable metadata instead of being dropped for oversized payloads.
- All-keyword failure telemetry preserves every status code separately from the five-item message preview. Suppression applies only when every failure is confirmed `4xx`; mixed or unknown statuses remain reportable.
- MCP parse-json shape drift (`MCP expected JSON output from aso keywords`) is classified as `user_fault` and suppressed.
- Unsupported-country requests use a typed validation error and are suppressed as user input rather than reported as bugs.
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
