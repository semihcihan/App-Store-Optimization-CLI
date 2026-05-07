# ASO Keyword Fetch Design

## Scope
Design for `aso keywords` (including `--stdout`) and dashboard keyword-add flow: lookup, popularity, enrichment, and persistence.
Also covers MCP keyword evaluation entrypoint (`aso_evaluate_keywords`) that evaluates explicit keywords + CLI invocation.

## Constraints
- Storefront: `US` only.
- US locale set for difficulty localization enrichment:
  - default: `en-US`
  - additional: `ar`, `zh-Hans`, `zh-Hant`, `fr-FR`, `ko-KR`, `pt-BR`, `ru-RU`, `es-MX`, `vi`
- Request size: max `100` keywords.
- Popularity stage requires a valid Primary App ID accessible by the caller's Apple Ads account.
- ASO research `keyword` means a search term candidate, which can be a single word or a multi-word long-tail phrase.
- App Store metadata keyword field is comma-separated and limited to `100` characters, so terms should be compactly separated (example: `love,couple`).

## Responsibility Split
- Domain policy (`cli/domain/keywords/*`, `cli/domain/errors/*`): shared keyword normalization/country policy (`US`), request limits, and dashboard-safe error/message mapping used by CLI + dashboard server + dashboard UI.
- CLI pipeline (`cli/services/keywords/keyword-pipeline-service.ts`): single orchestrator for stage-1 lookup/popularity, enrichment, order refresh, startup refresh, and failed-keyword retry.
- MCP server (`cli/mcp/index.ts`): validate explicit `keywords` input (max 100), call `aso keywords "<comma-separated-keywords>" --stdout` with resolved thresholds, and return only accepted rows from CLI output `items`.
- Cache API (`cli/services/cache-api/keyword-cache-service.ts`, `cli/services/cache-api/services/*`): lookup cache, enrich keywords, serve app docs.
- Keyword write repository (`cli/services/keywords/keyword-write-repository.ts`): single write owner for `aso_keywords`, `aso_keyword_failures`, competitor app docs, and `app_keywords.previous_position` updates.
- Dashboard server (`cli/dashboard-server/server.ts`, `cli/dashboard-server/routes/*`): run stage 1 synchronously, return early, run stage 2 in background.
- Shared domain policy (`cli/shared/*`): keyword normalization/TTL policy, freshness validation, resilience config, and upstream error normalization used by both `keywords` and `cache-api` layers.

## Pipeline
1. Normalize (`trim + lowercase + dedupe`).
2. `POST /aso/cache-lookup` to get hits/misses.
3. Classify misses:
   - popularity missing/expired -> fetch popularity from Search Ads endpoint.
   - popularity fresh + difficulty incomplete -> reuse cached popularity and enrich.
   - popularity fresh + difficulty complete + order expired -> order-only refresh.
   - when `minPopularity` filter is set, rows below threshold are marked `filteredOut(low_popularity)` and skipped for enrichment/difficulty.
4. Persist popularity-only local rows (`difficultyScore = null`) only for keywords that still need enrichment.
5. `POST /aso/enrich` with `{ keyword, popularity }` for full-enrich keywords.
   - Enrichment must provide top-5 app docs when `appCount >= 5`; it backfills missing top ids from cache/lookup and retries unresolved ids once before local scoring.
   - If top-5 docs are still incomplete for `appCount >= 5`, the keyword is returned as an enrichment failure (`reasonCode=INSUFFICIENT_DOCS`) and no fallback score is persisted.
   - Enrichment also computes `isBrandKeyword` from top-doc publisher signals (`publisherName`) after hydration/backfill:
     - all keyword tokens must be present in `#1.publisherName` tokens
     - if `#1.userRatingCount >= 1000`: brand = `true`
     - else require independent runner-up median (`#2-#5`, different publisher) `userRatingCount >= 10000`
     - missing/insufficient publisher metadata defaults to `false`
   - `isBrandKeyword` is a flag only; difficulty/minDifficulty math is unchanged.
6. Persist enriched keywords and returned app docs.
   - Enrichment persistence is progressive: each keyword success/failure is written as soon as that keyword finishes (bounded by enrichment concurrency), rather than waiting for the full enrich batch to complete.
7. For order-only keywords, refresh `orderedAppIds` + `appCount` without refetching popularity.
   - This step does not upsert competitor app docs; any app metadata returned during order refresh is transient and competitor docs are hydrated by app-doc read flows (`/api/aso/top-apps`, `/api/aso/apps`, `/api/aso/apps/search`) when missing/expired.
8. Persist terminal popularity/enrichment failures in `aso_keyword_failures`.
   - Dashboard background enrichment safety: if the background enrichment call throws before emitting per-keyword failures, unresolved pending keywords are recorded as terminal `enrichment` failures so they are retryable in UI.
9. Apply optional max-difficulty filter after difficulty is known:
   - rows above threshold are marked `filteredOut(high_difficulty)` and excluded from accepted `items`.

## Machine-Friendly `--stdout` Contract
- `aso keywords "<comma-separated-keywords>" --stdout` is keyword-only and intended for agents/machine calls.
- Optional filters are available directly on CLI:
  - `--min-popularity`
  - `--max-difficulty`
  - `--app-id` (association target; defaults to `research`)
  - `--no-associate` (skip app-keyword association writes for this run)
- Primary App ID resolution is non-interactive in this mode.
- Primary App ID precedence is: `--primary-app-id` -> `ASO_PRIMARY_APP_ID` -> saved local Primary App ID.
- If none are available, command fails with guidance to set `ASO_PRIMARY_APP_ID`, use `--primary-app-id`, or run interactive `aso`.
- It first runs keyword fetch with interactive auth recovery disabled.
- If auth is required, it attempts one reauthentication pass that is allowed only when no user interaction is needed.
- If credentials/2FA/confirmation input is required, command fails with guidance to run `aso auth` in a terminal first.
- After successful `aso auth`, later `--stdout` runs can reuse saved session/cookies.
- CLI startup update notifications are suppressed in `--stdout` mode so stdout remains JSON-only.
- Success output contract is an envelope:
  - `items`: accepted keyword rows (after active filters)
  - `failedKeywords`: terminal failures with stage + reason metadata
  - `filteredOut`: rows excluded by filters (`low_popularity` / `high_difficulty`)
- Accepted/filtered keyword rows include `isBrandKeyword` when available (`true` / `false` / `null` for not computed yet placeholders).
- Failure output contract is a JSON error envelope on stdout:
  - `error.code`: `CLI_VALIDATION_ERROR` or `CLI_RUNTIME_ERROR`
  - `error.message`: machine-readable failure message
  - `error.help` (optional): actionable guidance for validation failures
- Exit code contract:
  - success envelope: `0`
  - failure envelope: non-zero

## Auth-Only Command
- `aso auth` performs only Apple Search Ads reauthentication.
- It does not run keyword lookup, enrichment, dashboard startup, or Primary App ID resolution.

## Credential Reset Command
- `aso reset-credentials` clears saved Apple Search Ads credentials/cookies only.
- It does not run dashboard startup, keyword lookup, or reauthentication.

## Enrichment Strategy
- Primary ordering source: App Store search page `serialized-server-data`.
- Fallback ordering source: MZSearch.
- App detail sources:
  - App Store lookup payloads for competitor docs and release-date fields.
  - iTunes Lookup fallback (`itunes.apple.com/lookup`) for top-app IDs that are missing or incomplete from App Store lookup, so release-date fields can still be hydrated for difficulty scoring.
  - Localized app-page `serialized-server-data` JSON for `title`, `subtitle`, `icon`, `ratingAverage`, `totalNumberOfRatings`.
  - During enrichment, top difficulty docs aggregate additional locale `name/subtitle` into `aso_apps.additionalLocalizations` for per-localization keyword matching.
  - When search-page lockups are sparse but `nextPage` contributes top ids, enrichment backfills those missing top ids from cached competitor docs and App Lookup before difficulty scoring.
- Difficulty score uses top-result competitiveness signals plus app-count normalization.

### Difficulty Calculation
- For non-competitive keywords (`appCount < 5`), we return baseline values:
  - `difficultyScore = 1`
  - `minDifficultyScore = 1`
- For competitive keywords (`appCount >= 5`), enrichment requires complete top-5 docs; if still incomplete after backfill + one retry, enrichment fails with `INSUFFICIENT_DOCS` instead of persisting fallback scores.

Per-app competitive score (for each of top 5 apps):
- `normalizedRatingCount = clamp(userRatingCount / 10000, 0, 1)`
- `normalizedAvgRating`: starts above rating `3`, scales toward `5`, and is damped for low rating counts (`<= 20`).
- `normalizedAge = 1 - clamp(daysSinceLastRelease / 365, 0, 1)`
- `keywordScore` from keyword presence in title/subtitle, evaluated per localization (default + additional locales) and choosing the best single-localization match:
  - exact title phrase: `1`
  - all keyword words in title: `0.8`
  - exact subtitle phrase: `0.5`
  - phrase in combined title+subtitle: `0.4`
  - all keyword words in subtitle: `0.4`
  - otherwise: `0`
  - words are never mixed across different localizations (no cross-localization token merge).
- `normalizedRatingPerDay`: rating velocity mapped to `[0,1]` with low-rate damping and high-rate saturation.
- Weighted score:
  - `appCompetitiveScore = (0.2*normalizedRatingCount + 0.1*normalizedAvgRating + 0.1*normalizedAge + 0.3*keywordScore + 0.3*normalizedRatingPerDay) / 1.0`

Keyword-level difficulty:
- `competitiveScores = top5.map(appCompetitiveScore)`
- `keywordMatch = best(top5.map(detectBestKeywordMatchType))` using `keywordMatchToScore` rank, persisted as enum value (not numeric score).
- `avgCompetitive = average(competitiveScores)`
- `minCompetitive = min(competitiveScores)`
- `normalizedAppCount` (`MAX_COMPETING_APPS = 200`) is piecewise:
  - `0` when `appCount <= 10`
  - linear ramp `(appCount - 10) / (200 - 10)` when `10 < appCount < 200`
  - `1` when `appCount >= 200`
- weighted combination (minimum is emphasized):
  - `avgWeight = 2`
  - `minWeight = 4`
  - `appCountWeight = 0.5`
  - `rawDifficulty = (appCountWeight*normalizedAppCount + avgWeight*avgCompetitive + minWeight*minCompetitive) / (avgWeight + minWeight + appCountWeight)`
- `difficultyScore = clamp(rawDifficulty * 100, 1, 100)`
- `minDifficultyScore = minCompetitive * 100`

### Difficulty Lab Tool
- Local script `npm run difficulty:lab` (or `node scripts/difficulty-lab.js`) runs quick difficulty experiments with explicit inputs.
- Input scenarios are explicit per-app fields:
  - `appCount` (same value across rows; keyword-level total competing app count)
  - `averageUserRating`
  - `userRatingCount`
  - `daysSinceLastRelease`
  - `daysSinceFirstRelease`
  - `keywordMatch` (enum):
    - `none`
    - `titleExactPhrase`
    - `titleAllWords`
    - `subtitleExactPhrase`
    - `combinedPhrase`
    - `subtitleAllWords`
- Edit `scripts/difficulty-scenarios.example.json` and rerun. The script always reads this file.
- Output:
  - per-app table with concise input columns + `appScore` (`0..100`)
  - two keyword-level summaries:
    - `runtime` (enforces top-5 gate; may fall back to score `1`)
    - `simulated` (same weights, no top-5 fallback gate)

## Persistence Model
- Local DB (`~/.aso/aso-db.sqlite`): `owned_apps`, `owned_app_country_ratings`, `aso_keywords`, `aso_apps`, `app_keywords`.
- Full local SQLite schema reference (all tables + field types): `docs/aso-local-sqlite-schema.md`.
- Failure DB table: `aso_keyword_failures` keyed by `(country, normalized_keyword)` for current failed state.
- Local DB stores `difficultyScore` and `minDifficultyScore` as rounded integers on write.
- Local DB stores `aso_keywords.is_brand_keyword` (`1` brand / `0` non-brand / `NULL` not computed yet).
- Local DB stores `app_keywords.is_favorite` (`1` favorite / `0` non-favorite) per `(app_id, keyword, country)` association.
- `owned_apps` stores country-agnostic app identity/sidebar metadata (`id`, `kind`, `name`, `icon`) and is independent from competitor `aso_apps`.
- `owned_app_country_ratings` stores country-scoped owned-app ratings (`averageUserRating`, `userRatingCount`, previous snapshots, fetch timestamp, TTL) keyed by `(app_id, country)`.
- `aso_apps` stores competitor app-doc cache only (country scoped, no owned-app daily snapshot fields).
- `aso_apps.publisher_name` stores canonical publisher/developer used by brand detection, populated from search lockups (`developerName`) and lookup fallback payloads (`artistName`/seller equivalent).
- `aso_apps.additionalLocalizations` stores locale-keyed `{ name, subtitle? }` for additional country locales used by difficulty matching.
- `aso keywords` runs (including `--stdout`) own association writes:
  - `--no-associate`: skip association writes for the run
  - association runs only when the command returns successfully (no write on thrown failures)
  - no filters: associate requested keywords
  - filters active: associate accepted `items` only
  - target app: `--app-id` when set, otherwise `research`
- MCP `aso_evaluate_keywords` does not write directly; it delegates to the CLI command path above.
- Dashboard keyword reads include app-associated failures even when no `aso_keywords` cache row exists yet, marking those rows as failed for retry UX.
- Cache API repository is SQLite-backed and reuses local DB tables for keyword/app-doc cache lookups.
- No separate JSON cache file is used for ASO keyword/app-doc cache state.
- Rank delta baseline lives in `app_keywords.previous_position`.
- Rank history snapshots live in `app_keyword_position_history` and are appended on order writes for associated app-keyword rows.
- Rank history retention is `90` days with a write-path prune guard that runs at most once per day.
- Dashboard keyword favorites are app-scoped and live in `app_keywords.is_favorite`.

## Expiration and Refresh
- TTLs are env-configurable and split by data volatility:
  - `ASO_KEYWORD_ORDER_TTL_HOURS` (default `24`): keyword order/rank data (`orderedAppIds`, `appCount`).
  - `ASO_POPULARITY_CACHE_TTL_HOURS` (default `720`): popularity + difficulty lifecycle (`30` days).
  - `ASO_APP_CACHE_TTL_HOURS` (default `168`): app document cache (`7` days).
- Dashboard owned apps (`GET /api/apps`) enforce `ASO_OWNED_APP_DOC_REFRESH_MAX_AGE_HOURS` (default `24`) using `owned_app_country_ratings.last_fetched_at` for the hydration country. Stale owned IDs are rehydrated from localized App Store app-page JSON and written back to `owned_app_country_ratings` (including previous rating/count snapshots).
- Cache lookup returns only rows that are complete and fresh for both order TTL and popularity TTL.
- Popularity and difficulty are refreshed together when popularity TTL expires.
- Startup refresh processes associated owned + research keywords in background batches when popularity expires or difficulty is missing; order expiry triggers startup refresh only for owned-associated keywords (not research-only keywords).
- Missing/expired app docs trigger hydration.

## API Surface
- `POST /aso/cache-lookup`
- `POST /aso/enrich`
- `POST /aso/app-docs` (max `50` IDs)
- `GET /api/aso/keywords`
  - App-scoped reads are paginated and require `appId`.
  - Supported query params: `page`, `pageSize`, `sortBy`, `sortDir`, `keyword`, `minPopularity`, `maxDifficulty`, `brand`, `favorite`, `minRank`, `maxRank`.
  - Paginated response: `{ items, page, pageSize, totalCount, totalPages, hasPrevPage, hasNextPage, associatedCount, failedCount, pendingCount }`.
- `GET /api/aso/keywords/history`
  - Required query params: `appId`, `keyword`; optional `country` (defaults to `US`).
  - Returns time-ordered rank points with non-null positions: `{ appId, keyword, points: [{ capturedAt, position }] }`.
- `POST /api/aso/keywords/retry-failed`
- `POST /api/aso/keywords/favorite`
  - Body: `{ appId, country, keyword, isFavorite }`
  - Updates app-scoped `app_keywords.is_favorite` only for that keyword association.

## MCP Surface
- Tool: `aso_evaluate_keywords`
- Country: always `US` (country is not user-configurable at MCP level)
- Input: required `keywords` array (strings). Each item can be a single-word or long-tail phrase. Comma-separated entries are normalized and split.
- Input: optional `appId` string. When provided, accepted keywords are associated to that local app id instead of the default research app.
- Input: optional `minPopularity` and `maxDifficulty`; defaults are `6` and `70` with absolute min-popularity floor `6`.
- Max request size: `100` provided keywords (enforced by MCP handler)
- Output is a JSON array of accepted keywords only (no rejected list). Each row includes:
  - `keyword`: normalized keyword phrase.
  - `popularity`: Apple Search Ads popularity score (higher is better).
  - `difficulty`: keyword competition difficulty score (lower is better).
  - `minDifficultyScore`: lowest visibility score among the top 5 search results for that keyword.
  - `isBrandKeyword`: `true` when classified as brand, otherwise `false`.

## Key Decisions
- Popularity stays in CLI because it depends on local Search Ads auth + Primary App ID context.
- Enrichment/cache stays backend-side for deterministic reuse.
- Two-stage flow keeps dashboard latency low while preserving full enrichment asynchronously.
- `keywordPipelineService` is the only orchestration entrypoint for CLI commands, dashboard keyword routes, startup refresh, and retry-failed flow.
- `keywordWriteRepository` is the only write owner for keyword/failure/app-doc persistence and previous-position updates.
