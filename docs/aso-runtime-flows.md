# ASO Runtime Flows

## Scope
Runtime flow contracts across CLI commands, local dashboard API, and ASO services.

## Runtime Requirement
- Runtime: Node.js `>=18.14.1`.
- Local development/build: Node.js `>=20.19.0`.

## Operational Prerequisite
- Apple Search Ads setup is required only for ASO command flows (`aso ...`).
- Required setup items:
  - Apple Search Ads account
  - Linked App Store Connect account in Apple Search Ads
  - App ID for primary ASO popularity context

## Trigger Map
- `aso`: resolve Primary App ID, start dashboard server (`3456` by default, auto-fallback to a free local port when occupied), start startup refresh manager.
- `aso keywords "..."`: run full keyword pipeline and print envelope result (`items`, `failedKeywords`, `filteredOut`); accepted/filtered rows include brand classification (`isBrandKeyword`) when available.
- `aso keywords "..." --stdout`: machine-friendly mode; emits JSON-only stdout, attempts silent reauth, and fails when interactive user input is required.
- `aso auth`: run only Apple Search Ads reauthentication.
- `aso reset-credentials`: clear saved ASO keychain credentials and local cookies.
- Any `aso` process start emits PostHog `cli_started` telemetry using a persisted user id at `~/.aso/config.json` (`userId`), then flushes telemetry on normal/error exits.
- MCP `aso_evaluate_keywords`: accept explicit keywords (max 100), run `aso keywords "<comma-separated-keywords>" --stdout`, return evaluated keyword results.
- Dashboard API mutations: app add (single-item POST; UI may batch multiple selections), app delete, keyword add/delete, keyword favorite toggle, auth start/respond, setup start/respond.

## Boundary Ownership
- Domain policy (`cli/domain/keywords/*`, `cli/domain/errors/*`) is shared across CLI/server/UI for country guardrails, keyword normalization, limits, and dashboard-safe error/message mapping.
- `keywordPipelineService` (`cli/services/keywords/keyword-pipeline-service.ts`) is the only keyword orchestration entrypoint.
- `keywordWriteRepository` (`cli/services/keywords/keyword-write-repository.ts`) is the only write-side owner for keyword cache rows, failure rows, competitor app docs, and previous-position updates.
- Interactive setup/auth prompts are emitted from shared services and fulfilled by either CLI prompts or dashboard prompt sessions; the prompt transport is not duplicated per surface.
- Dashboard HTTP wiring is split by concern:
  - bootstrap (`server.ts`)
  - auth state (`auth-state.ts`)
  - setup state (`setup-state.ts`)
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
   - when `--min-popularity` is set, rows below threshold are marked `filteredOut(low_popularity)` and skip enrich/difficulty calculation.
4. Persist popularity-only local rows for keywords awaiting full enrich.
5. Enrich required keywords (`/aso/enrich`) and persist enriched keywords + competitor app docs.
   - For top difficulty docs, enrichment fetches configured additional locales for the country and stores locale-keyed `name/subtitle` under competitor docs (`aso_apps.additionalLocalizations`) for per-localization keyword matching.
   - For `appCount>=5`, enrichment backfills missing top ids from cache/lookup and retries unresolved ids once; if still incomplete, keyword enrichment fails with `INSUFFICIENT_DOCS` instead of persisting fallback score `1`.
   - During enrichment, brand classification is computed as `isBrandKeyword` from top-doc publisher signals (`publisherName`) after hydration/backfill; this is a flag only and does not adjust difficulty scores.
6. Refresh order-only keywords and persist updated `orderedAppIds` + `appCount` without refetching popularity.
   - Order refresh may include lightweight app metadata from search-page parsing, but Flow A persists only keyword order fields in this step; competitor doc cache (`aso_apps`) is hydrated later by Flow E endpoints when docs are missing/expired.
7. Association write policy (`app_keywords`):
   - `--no-associate`: skip association writes.
   - association runs only after a successful pipeline return (no write on thrown failures).
   - no filters: associate requested keywords.
   - any filter active (`--min-popularity` and/or `--max-difficulty`): associate accepted `items` only.
   - target app comes from `--app-id`; defaults to `research` when omitted.
8. Apply post-enrichment difficulty threshold when `--max-difficulty` is set:
   - rows above threshold are marked `filteredOut(high_difficulty)` and excluded from `items`.

### Flow A1: CLI Keyword Fetch in `--stdout` Mode
1. Run Flow A with interactive auth recovery disabled.
2. Resolve Primary App ID without prompting.
3. Primary App ID precedence: `--primary-app-id` -> `ASO_PRIMARY_APP_ID` -> saved local Primary App ID.
4. If no Primary App ID is available from that chain, fail with guidance to set `ASO_PRIMARY_APP_ID`, use `aso --primary-app-id <id>`, or interactive `aso`.
5. If auth is required, try `asoAuthService.reAuthenticate` once with an `onUserActionRequired` hook that aborts.
6. Retry Flow A once after successful silent reauth.
7. If user input is required, fail with guidance to run `aso auth` and retry.
8. In raw CLI `--stdout` mode, keep the same association policy as Flow A (including `--no-associate`), and skip save logs so stdout stays JSON-only.
9. Success output envelope is machine-parseable JSON: `items`, `failedKeywords`, `filteredOut` with exit code `0`.
10. Failure output envelope is machine-parseable JSON on stdout:
    - `error.code` (`CLI_VALIDATION_ERROR` or `CLI_RUNTIME_ERROR`)
    - `error.message`
    - optional `error.help`
11. Suppress CLI startup update notifications and keep logger failure text off stdout so output remains machine-parseable JSON.

## Flow B: Dashboard Add Keywords (`POST /api/aso/keywords`)
1. Validate and normalize input.
   - Requests over `100` normalized keywords fail immediately before app-association lookups.
2. Remove already-associated keywords for selected app.
3. Run stage-1 popularity pipeline with interactive auth recovery disabled.
4. Create new app-keyword associations.
5. Return `201` immediately with `{ cachedCount, pendingCount, failedCount }`.
6. Persist any popularity-stage failures in `aso_keyword_failures`.
7. `GET /api/aso/keywords` (app-scoped) keeps app-associated failed keywords visible with `keywordStatus="failed"` even when no `aso_keywords` row exists yet (for example, popularity-stage failures).
   - App-scoped keyword reads are always paginated and require `appId`, with server-side search/filter/sort (`keyword`, `minPopularity`, `maxDifficulty`, `brand`, `favorite`, `minRank`, `maxRank`, `sortBy`, `sortDir`, `page`, `pageSize`).
   - Paginated response shape is `{ items, page, pageSize, totalCount, totalPages, hasPrevPage, hasNextPage, associatedCount, failedCount, pendingCount }`.
8. Run background keyword work for misses:
   - full enrichment for `pendingItems`
     - enrichment is persisted per keyword as each worker finishes (progressive visibility on regular keyword polling).
   - order-only refresh for `orderRefreshKeywords`
   - if the background enrichment call throws before returning per-keyword results, unresolved `pendingItems` are persisted as `enrichment` failures so dashboard rows transition from `pending` to `failed` (retryable UX) instead of staying on `Calculating...`.

## Flow B2: Dashboard Retry Failed Keywords (`POST /api/aso/keywords/retry-failed`)
1. Resolve failed keywords for selected `appId` + `country`.
2. Rerun the same keyword pipeline in non-interactive auth mode.
3. Return `{ retriedCount, succeededCount, failedCount }`.
4. Clear failed status for keywords that succeeded.
5. Dashboard UI shows the retry action only when current keyword rows include failed entries.

## Flow B3: Dashboard Keyword Favorites (`POST /api/aso/keywords/favorite`)
1. UI toggles the row heart control in the dedicated `Favorite` column.
2. Client sends `{ appId, country, keyword, isFavorite }`.
3. Server updates `app_keywords.is_favorite` for the exact `(appId, keyword, country)` association.
4. Favorite state is app-scoped: the same keyword associated to a different app keeps its own favorite state.

## Flow C0: Dashboard Primary App Setup
1. Plain `aso` starts the dashboard immediately; it does not block startup on a terminal-only Primary App ID prompt.
2. If Primary App ID is already configured (`--primary-app-id` save, env, or saved local value), dashboard setup is skipped unless a later API call proves that the configured ID is inaccessible for the current Apple Ads account.
3. If Primary App ID is missing, or if the dashboard receives `PRIMARY_APP_ID_RECONFIGURE_REQUIRED`, server starts a single-flight setup session and exposes its prompt state via `GET /api/aso/setup/status`.
4. Dashboard submits the chosen Primary App ID through `POST /api/aso/setup/respond`.
5. On success, the value is persisted through the same `resolveAsoAdamId` / `saveAsoAdamId` path used by CLI, becomes active for the current dashboard process immediately, and startup refresh begins.

## Flow C: Dashboard Reauthentication
1. Add-keyword flow returns `AUTH_REQUIRED` or `AUTH_IN_PROGRESS` when auth state blocks stage 1.
2. Startup-refresh auth-required failures also enter this same flow automatically once, instead of waiting for a separate explicit auth action.
3. Client calls `POST /api/aso/auth/start`.
4. Server runs single-flight `asoAuthService.reAuthenticate()` with a dashboard prompt handler instead of a terminal-only prompt path.
5. Client polls `GET /api/aso/auth/status` until terminal state and submits prompt answers through `POST /api/aso/auth/respond`.
6. Shared auth service can request browser-collected credentials, Keychain-save confirmation, 2FA method choice, trusted phone choice, and verification code without duplicating auth logic.
7. On success, client retries the pending add-keyword action and can resume a previously paused startup refresh.
8. On failure, the same dashboard auth modal remains the single recovery surface for both add-keyword and startup-refresh flows.
9. While reauth is auto-starting or in progress for a pending add-keyword action, the dashboard keeps the add action in a loading state (`Checking Apple session...`) so the button never appears idle.

## Flow D: Startup Background Refresh
1. Start once at dashboard boot after Primary App ID is already configured, or immediately after dashboard setup completes.
2. Select keywords associated with owned or research apps and finite popularity where at least one is true:
   - popularity TTL is stale
   - difficulty has never been computed
   - order TTL is stale (owned-associated keywords only; research-only keywords do not use order staleness as a refresh trigger)
3. Run the same keyword pipeline used by CLI fetch in non-interactive mode, in batches while pausing for foreground mutations.
4. Publish refresh status via `GET /api/aso/refresh-status`, including whether the failure requires Search Ads reauthentication.
5. If auth is required, the dashboard auto-starts the same reauthentication flow used by add-keyword once; silent session reuse stays invisible, while browser prompt steps/failure states surface through the shared auth modal.
6. Allow explicit restart via `POST /api/aso/refresh/start`; the UI uses this after reauthentication or manual retry.

## Flow E: App Doc Hydration
- `GET /api/apps` (owned app list):
  - ensure default research app exists.
  - return `owned_apps` rows joined with `owned_app_country_ratings` for the hydration country (`kind`, rating snapshots, icons, fetch timestamps).
  - refresh stale `kind=owned` rows when `owned_app_country_ratings.last_fetched_at` exceeds `ASO_OWNED_APP_DOC_REFRESH_MAX_AGE_HOURS` (default `24`) using localized app-page `serialized-server-data` JSON.
- `GET /api/aso/top-apps`: read ordered IDs from keyword; when keyword order TTL is stale, refresh order first, then return competitor docs and hydrate missing/expired competitor docs.
- `GET /api/aso/apps`: competitor-doc endpoint for requested IDs (`aso_apps` only), hydrate missing/expired competitor docs (or force with `refresh=true`).
- `GET /api/aso/apps/search`: resolve ordered IDs for a free-text term and hydrate competitor docs for the top IDs.

## Flow E2: Dashboard Add Apps
1. User opens add-app dialog and types a search term.
2. UI debounces search requests and calls `GET /api/aso/apps/search`.
3. UI always prepends a research candidate row (`Research: <typed text>`) so the typed value can be added as a research app even when Apple search has no app hits.
4. UI allows multi-select across search results and submits one `POST /api/apps` per selected entry (`type="app"` or `type="research"`).
5. After submission, UI refreshes owned app list from `GET /api/apps` and selects the latest successfully added app when available.

## Flow E3: Dashboard Delete Apps
1. User right-clicks a sidebar app row (owned apps + non-default research apps) and chooses `Delete`.
2. UI asks for confirmation before sending `DELETE /api/apps` with `{ appId }`.
3. Server rejects deletion for the default research app (`id="research"`).
4. Server removes the app row from `owned_apps` and clears related `app_keywords` associations for that app id.
5. UI refreshes app list + keyword list and falls back to an existing research app selection when the deleted app was selected.

## Rank Delta Contract
- `app_keywords.previous_position` stores prior rank per `(app, keyword, country)`.
- Before keyword overwrite, previous positions are updated from existing `ordered_app_ids`.
- `app_keyword_position_history` stores append-only rank snapshots per `(app, keyword, country, captured_at)` whenever fresh keyword order is persisted.
- Position history retention is `90` days, pruned at most once per day via write-path metadata watermarking.
- Consumers compute current rank from latest `orderedAppIds` and compare against `previous_position`.
- Dashboard history reads use `GET /api/aso/keywords/history?appId=...&keyword=...&country=US` and return time-ordered points with non-null positions only.

## Guardrails
- Country must be `US`.
- Keyword limit is `100`.
- Dashboard JSON request payloads are capped at `1 MiB`.
- Dashboard paginated keyword reads use app-scoped SQL joins so keyword rows are filtered/sorted in storage before page slicing.
- In dashboard research workspace, `Rank` and `Change` columns remain hidden; `Updated` stays visible.
- Dashboard keyword sort is global (`localStorage`) across apps. On startup, restore the last valid sort; fallback to `Updated` descending (newest first) when missing/invalid or when the selected sort column is unavailable in the current workspace.
- Dashboard filters (`minPopularity`, `maxDifficulty`, `brand`, `favorite`, `minRank`, `maxRank`) persist via `localStorage` across browser refresh and dashboard restarts; keyword text search always resets on startup.
- Dashboard keyword table shortcuts: `Cmd/Ctrl+A` selects all visible keywords, `Cmd/Ctrl+C` copies selected visible keywords as comma-separated text, `Cmd/Ctrl+V` pastes clipboard text into the add-keywords input when focus is outside editable fields, and `Delete`/`Backspace` opens the delete confirmation for selected visible keywords when focus is outside editable fields.
- Sidebar app rows treat click targets consistently: clicking row text/icon content selects the app, while explicit app-ID copy controls keep copy behavior and do not trigger app switching.
- Sidebar app rows support right-click app actions; delete is available for owned apps and non-default research apps only.
- Research section in the sidebar can be collapsed/expanded from its section header toggle.
- Dashboard first-run onboarding highlights:
  - highlight the add-keywords input until the user successfully adds at least one keyword.
  - highlight the add-app button until the user has at least one non-default app (`id !== "research"`), including research apps created by user.
  - state is derived from local DB-backed `/api/apps` data (`lastKeywordAddedAt` and app list) and reappears if user removes all added apps/keywords.
- App-doc backend requests are chunked to max `50` IDs.
- In ASO research, a `keyword` is a search term candidate and may be a long-tail phrase, not only a single word.
- In App Store metadata fields, keywords are comma-separated terms under a `100`-character limit.
- Keyword inclusion/difficulty matching is per localization; terms are not mixed across different localizations of the same app.

## Flow F: MCP ASO Evaluate Keywords (`aso_evaluate_keywords`)
1. Read required `keywords` input.
2. Treat each input as a search term candidate (single-word or long-tail phrase), then split comma-separated entries, normalize (`trim + lowercase`), and dedupe valid candidates.
3. Return an MCP error when provided keyword count is greater than `100`.
4. Execute `aso keywords "<comma-separated-keywords>" --stdout --min-popularity <resolvedMin> --max-difficulty <resolvedMax> [--app-id <appId>]`.
5. Parse CLI output envelope and return a compact JSON array derived from accepted `items`.
6. MCP does not write directly; association writes are owned by the CLI command path from step 4.

Accepted row fields:
- `keyword`: normalized keyword phrase.
- `popularity`: Apple Search Ads popularity score (higher is better).
- `difficulty`: keyword competition difficulty score (lower is better).
- `minDifficultyScore`: lowest visibility score among the top 5 search results for the keyword.
- `isBrandKeyword`: `true` when classified as brand keyword, otherwise `false`.

## Flow G: CLI Auth-Only (`aso auth`)
1. Try reusing cached Apple session cookies first (non-interactive validation).
2. If cached session is valid, refresh and save cookie/auth state, then exit.
3. If cached session is invalid:
   - Use saved macOS Keychain credentials first when available.
   - Prompt for credentials only when missing/invalid keychain credentials.
4. Complete Apple login + 2FA as needed, save refreshed cookie/auth state, then exit.
5. Exit without dashboard startup, keyword fetch, or Primary App ID resolution.
6. This uses the same auth service that powers dashboard browser prompts; only the prompt transport differs.

2FA fallback behavior:
- If `noTrustedDevices=true` and exactly one trusted phone exists, treat code delivery as already triggered and prompt only for code.
- If `noTrustedDevices=true` and multiple trusted phones exist, prompt user to choose the phone before requesting code.
- Otherwise, default to trusted-device flow with optional SMS/phone selection.

## Flow H: Credential Reset (`aso reset-credentials`)
1. Clear saved ASO keychain credentials.
2. Clear saved ASO cookies.
3. Exit without dashboard startup, keyword fetch, or reauthentication.

## Prompt / TTY Contract
- Shared services emit structured setup/auth prompts instead of hard-coding surface-specific UX.
- CLI fulfills those prompts through an interactive terminal (`stdin` + `stdout` TTY).
- Dashboard fulfills those prompts through local prompt-session APIs and browser modals.
- When prompt-required auth runs in a non-interactive surface with no prompt handler (for example `--stdout`), auth fails with explicit actionable guidance.
- `aso keywords --stdout` keeps machine-friendly behavior: JSON-only stdout (success envelope or failure envelope), silent session reuse only, and no interactive auth prompts.
