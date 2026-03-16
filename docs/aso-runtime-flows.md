# ASO Runtime Flows

## Scope
Runtime flow contracts across CLI commands, local dashboard API, and ASO services.

## Runtime Requirement
- Runtime: Node.js `>=20.18.1`.
- Local development/build: Node.js `>=20.19.0`.

## Operational Prerequisite
- Apple Search Ads setup is required only for ASO command flows (`aso ...`).
- Required setup items:
  - Apple Search Ads account
  - Linked App Store Connect account in Apple Search Ads
  - App ID for primary ASO popularity context

## Trigger Map
- `aso`: resolve Primary App ID, start dashboard server (`3456` by default, auto-fallback to a free local port when occupied), start startup refresh manager.
- `aso keywords "..."`: run full keyword pipeline and print envelope result (`items`, `failedKeywords`).
- `aso keywords "..." --stdout`: machine-friendly mode; emits JSON-only stdout, attempts silent reauth, and fails when interactive user input is required.
- `aso auth`: run only Apple Search Ads reauthentication.
- `aso reset-credentials`: clear saved ASO keychain credentials and local cookies.
- MCP `aso_evaluate_keywords`: accept explicit keywords (max 100), run `aso keywords "<comma-separated-keywords>" --stdout`, return evaluated keyword results.
- Dashboard API mutations: app add (single-item POST; UI may batch multiple selections), keyword add/delete, auth start.

## Boundary Ownership
- Domain policy (`cli/domain/keywords/*`, `cli/domain/errors/*`) is shared across CLI/server/UI for country guardrails, keyword normalization, limits, and dashboard-safe error/message mapping.
- `keywordPipelineService` (`cli/services/keywords/keyword-pipeline-service.ts`) is the only keyword orchestration entrypoint.
- `keywordWriteRepository` (`cli/services/keywords/keyword-write-repository.ts`) is the only write-side owner for keyword cache rows, failure rows, competitor app docs, and previous-position updates.
- Dashboard HTTP wiring is split by concern:
  - bootstrap (`server.ts`)
  - auth state (`auth-state.ts`)
  - request/response helpers (`http-utils.ts`)
  - apps handlers (`apps-handler.ts`)
  - keyword/app-doc handlers (`routes/keyword-handlers.ts`, `routes/app-doc-handlers.ts`)
  - static assets (`static-files.ts`)

## Flow A: CLI Keyword Fetch
1. Normalize and validate keywords.
2. Cache lookup (`/aso/cache-lookup`).
3. Classify misses:
   - popularity missing/expired -> fetch popularity from Search Ads, then full enrich.
   - popularity fresh + difficulty/order incomplete -> full enrich with cached popularity.
   - popularity fresh + difficulty complete + order expired -> order-only refresh.
4. Persist popularity-only local rows for keywords awaiting full enrich.
5. Enrich required keywords (`/aso/enrich`) and persist enriched keywords + competitor app docs.
6. Refresh order-only keywords and persist updated `orderedAppIds` + `appCount` without refetching popularity.
7. In interactive CLI mode (without `--stdout`), associate requested keywords with the default research app (`research`) in `app_keywords` so failures remain visible for retry.

### Flow A1: CLI Keyword Fetch in `--stdout` Mode
1. Run Flow A with interactive auth recovery disabled.
2. Resolve Primary App ID without prompting.
3. If Primary App ID is not provided and not saved, fail with guidance to set it via `aso --primary-app-id <id>` or interactive `aso`.
4. If auth is required, try `asoAuthService.reAuthenticate` once with an `onUserActionRequired` hook that aborts.
5. Retry Flow A once after successful silent reauth.
6. If user input is required, fail with guidance to run `aso auth` and retry.
7. In raw CLI `--stdout` mode, do not auto-associate keywords to research app.
8. Suppress CLI startup update notifications so stdout stays machine-parseable JSON.

## Flow B: Dashboard Add Keywords (`POST /api/aso/keywords`)
1. Validate and normalize input.
   - Requests over `100` normalized keywords fail immediately before app-association lookups.
2. Remove already-associated keywords for selected app.
3. Run stage-1 popularity pipeline with interactive auth recovery disabled.
4. Create new app-keyword associations.
5. Return `201` immediately with `{ cachedCount, pendingCount, failedCount }`.
6. Persist any popularity-stage failures in `aso_keyword_failures`.
7. `GET /api/aso/keywords` (app-scoped) keeps app-associated failed keywords visible with `keywordStatus="failed"` even when no `aso_keywords` row exists yet (for example, popularity-stage failures).
8. Run background keyword work for misses:
   - full enrichment for `pendingItems`
   - order-only refresh for `orderRefreshKeywords`

## Flow B2: Dashboard Retry Failed Keywords (`POST /api/aso/keywords/retry-failed`)
1. Resolve failed keywords for selected `appId` + `country`.
2. Rerun the same keyword pipeline in non-interactive auth mode.
3. Return `{ retriedCount, succeededCount, failedCount }`.
4. Clear failed status for keywords that succeeded.
5. Dashboard UI shows the retry action only when current keyword rows include failed entries.

## Flow C: Dashboard Reauthentication
1. Add-keyword flow returns `AUTH_REQUIRED` or `AUTH_IN_PROGRESS` when auth state blocks stage 1.
2. Client calls `POST /api/aso/auth/start`.
3. Server runs single-flight `asoAuthService.reAuthenticate()`.
4. Client polls `GET /api/aso/auth/status` until terminal state.
5. On success, client retries pending add-keyword action.
6. While reauth is auto-starting or in progress for a pending add-keyword action, the dashboard keeps the add action in a loading state (`Checking Apple session...`) so the button never appears idle.

## Flow D: Startup Background Refresh
1. Start once at dashboard boot.
2. Select keywords associated with non-research apps and finite popularity where at least one is true:
   - popularity TTL is stale
   - difficulty has never been computed
   - order TTL is stale
3. Run the same keyword pipeline used by CLI fetch in non-interactive mode, in batches while pausing for foreground mutations.
4. Publish refresh status via `GET /api/aso/refresh-status`.

## Flow E: App Doc Hydration
- `GET /api/aso/top-apps`: read ordered IDs from keyword, return competitor docs, hydrate missing/expired docs.
- `GET /api/aso/apps`: return owned docs for requested IDs, hydrate missing/expired docs (or all docs when `refresh=true`).
- `GET /api/aso/apps/search`: resolve ordered IDs for a free-text term using the same App Store order-search pipeline used by keyword ordering, then hydrate docs for the top IDs.

## Flow E2: Dashboard Add Apps
1. User opens add-app dialog and types a search term.
2. UI debounces search requests and calls `GET /api/aso/apps/search`.
3. UI always prepends a research candidate row (`Research: <typed text>`) so the typed value can be added as a research app even when Apple search has no app hits.
4. UI allows multi-select across search results and submits one `POST /api/apps` per selected entry (`type="app"` or `type="research"`).
5. After submission, UI refreshes app list + app docs and selects the latest successfully added app when available.

## Rank Delta Contract
- `app_keywords.previous_position` stores prior rank per `(app, keyword, country)`.
- Before keyword overwrite, previous positions are updated from existing `ordered_app_ids`.
- Consumers compute current rank from latest `orderedAppIds` and compare against `previous_position`.

## Guardrails
- Country must be `US`.
- Keyword limit is `100`.
- Dashboard JSON request payloads are capped at `1 MiB`.
- Dashboard keyword reads pre-index app-keyword associations by keyword to avoid repeated scans per row.
- In dashboard research workspace, `Rank` and `Change` columns remain hidden; `Updated` stays visible.
- Dashboard keyword sort is global (`localStorage`) across apps. On startup, restore the last valid sort; fallback to `Updated` descending (newest first) when missing/invalid or when the selected sort column is unavailable in the current workspace.
- Dashboard keyword table shortcuts: `Cmd/Ctrl+A` selects all visible keywords, `Cmd/Ctrl+C` copies selected visible keywords as comma-separated text, `Cmd/Ctrl+V` pastes clipboard text into the add-keywords input when focus is outside editable fields, and `Delete`/`Backspace` opens the delete confirmation for selected visible keywords when focus is outside editable fields.
- App-doc backend requests are chunked to max `50` IDs.
- In ASO research, a `keyword` is a search term candidate and may be a long-tail phrase, not only a single word.
- In App Store metadata fields, keywords are comma-separated terms under a `100`-character limit.

## Flow F: MCP ASO Evaluate Keywords (`aso_evaluate_keywords`)
1. Read required `keywords` input.
2. Treat each input as a search term candidate (single-word or long-tail phrase), then split comma-separated entries, normalize (`trim + lowercase`), and dedupe valid candidates.
3. Return an MCP error when provided keyword count is greater than `100`.
4. Execute `aso keywords "<comma-separated-keywords>" --stdout`.
5. Parse CLI output, keep only rows that pass threshold checks, and return a compact JSON array of accepted rows.
6. Save accepted keywords into the default research app (`research`) so they are available in dashboard research workspace.

Accepted row fields:
- `keyword`: normalized keyword phrase.
- `popularity`: Apple Search Ads popularity score (higher is better).
- `difficulty`: keyword competition difficulty score (lower is better).
- `minDifficultyScore`: lowest visibility score among the top 5 search results for the keyword.

## Flow G: CLI Auth-Only (`aso auth`)
1. Try reusing cached Apple session cookies first (non-interactive validation).
2. If cached session is valid, refresh and save cookie/auth state, then exit.
3. If cached session is invalid:
   - Use saved macOS Keychain credentials first when available.
   - Prompt for credentials only when missing/invalid keychain credentials.
4. Complete Apple login + 2FA as needed, save refreshed cookie/auth state, then exit.
5. Exit without dashboard startup, keyword fetch, or Primary App ID resolution.

2FA fallback behavior:
- If `noTrustedDevices=true` and exactly one trusted phone exists, treat code delivery as already triggered and prompt only for code.
- If `noTrustedDevices=true` and multiple trusted phones exist, prompt user to choose the phone before requesting code.
- Otherwise, default to trusted-device flow with optional SMS/phone selection.

## Flow H: Credential Reset (`aso reset-credentials`)
1. Clear saved ASO keychain credentials.
2. Clear saved ASO cookies.
3. Exit without dashboard startup, keyword fetch, or reauthentication.

## Prompt / TTY Contract
- Credential and 2FA prompts require an interactive terminal (`stdin` + `stdout` TTY).
- When prompt-required auth runs in non-interactive mode, auth fails with explicit actionable guidance.
- `aso keywords --stdout` keeps machine-friendly behavior: JSON-only stdout, silent session reuse only, and no interactive auth prompts.
