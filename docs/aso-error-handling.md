# ASO Error Handling Model

## Goal
Define failure boundaries, retry rules, and recovery behavior across CLI, dashboard API, and ASO services.

## Failure Boundaries
- CLI popularity stage (`cli/services/keywords/aso-popularity-service.ts`) handles Search Ads auth/session and popularity failures.
- Dashboard server (`cli/dashboard-server/server.ts`) maps internal failures to stable API error codes.
- Enrichment services (`cli/services/cache-api/services/aso-enrichment-service.ts`, `cli/services/cache-api/services/aso-apple-client.ts`) handle App Store fetch failures and fallback behavior.

## Dashboard Error Codes
- `INVALID_REQUEST`
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
- Shared resilience config lives in `cli/services/keywords/aso-resilience.ts`.
- Popularity fetch retries transient responses (`429`, `5xx`, `KWS_NO_ORG_CONTENT_PROVIDERS`) and transient network errors.
- App Store web fetches retry `429`, `5xx`, and transient network errors with jittered exponential backoff.
- Startup refresh manager retries each unit once and records failures without crashing runtime.
- Keyword orchestration isolates terminal failures per keyword and stores normalized failure metadata in `aso_keyword_failures`.

## Recovery Behavior
- Dashboard add-keyword:
  - If auth is invalid in stage 1, return `AUTH_REQUIRED` (no interactive prompt in request path).
- If stage-2 enrichment fails, stage-1 writes remain; caller can retry later.
- Dashboard retry-failed endpoint retries only failed keywords for selected app/country and returns `{ retriedCount, succeededCount, failedCount }`.
- Top-app and app-doc hydration:
  - Missing/expired docs trigger backend fetch.
  - On hydration failure, return available cached data when possible.
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
- Dashboard server reports failures with structured metadata (path, phase, counts).
- Startup refresh state (`status`, counters, timestamps, lastError) is exposed via API.

## Auth Persistence Contract
- Cookie persistence is atomic (temp file + rename).
- Cookie persistence/load prunes expired cookies.
- Popularity requests use URL-scoped cookie selection (domain/path/secure aware), not a flat all-cookies header.

## Design Choice
Prefer partial progress when safe (preserve useful local data), but fail explicitly for auth/contract errors so automation clients can recover deterministically.
