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
- MCP server (`cli/mcp/index.ts`): validate explicit `keywords` input (max 100), call `aso keywords "<comma-separated-keywords>" --stdout`, and return only accepted rows after threshold filtering.
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
4. Persist popularity-only local rows (`difficultyScore = null`) only for keywords that still need enrichment.
5. `POST /aso/enrich` with `{ keyword, popularity }` for full-enrich keywords.
6. Persist enriched keywords and returned app docs.
7. For order-only keywords, refresh `orderedAppIds` + `appCount` without refetching popularity.
   - This step does not upsert competitor app docs; any app metadata returned during order refresh is transient and competitor docs are hydrated by app-doc read flows (`/api/aso/top-apps`, `/api/aso/apps`, `/api/aso/apps/search`) when missing/expired.
8. Persist terminal popularity/enrichment failures in `aso_keyword_failures`.

## Machine-Friendly `--stdout` Contract
- `aso keywords "<comma-separated-keywords>" --stdout` is keyword-only and intended for agents/machine calls.
- Primary App ID resolution is non-interactive in this mode.
- Primary App ID precedence is: `--primary-app-id` -> `ASO_PRIMARY_APP_ID` -> saved local Primary App ID.
- If none are available, command fails with guidance to set `ASO_PRIMARY_APP_ID`, use `--primary-app-id`, or run interactive `aso`.
- It first runs keyword fetch with interactive auth recovery disabled.
- If auth is required, it attempts one reauthentication pass that is allowed only when no user interaction is needed.
- If credentials/2FA/confirmation input is required, command fails with guidance to run `aso auth` in a terminal first.
- After successful `aso auth`, later `--stdout` runs can reuse saved session/cookies.
- CLI startup update notifications are suppressed in `--stdout` mode so stdout remains JSON-only.
- Output contract is an envelope:
  - `items`: successful keyword rows
  - `failedKeywords`: terminal failures with stage + reason metadata

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
  - Localized app-page `serialized-server-data` JSON for `title`, `subtitle`, `icon`, `ratingAverage`, `totalNumberOfRatings`.
  - During enrichment, top difficulty docs aggregate additional locale `title/subtitle` into `aso_apps.additionalLocalizations` for per-localization keyword matching.
- Difficulty score uses top-result competitiveness signals plus app-count normalization.

### Difficulty Calculation
- Difficulty is computed only when we have both:
  - top `5` ranked app docs for the keyword (`DIFFICULTY_DETAIL_LIMIT = 5`)
  - total `appCount >= 5`
- If either condition is not met, we return baseline values:
  - `difficultyScore = 1`
  - `minDifficultyScore = 1`

Per-app competitive score (for each of top 5 apps):
- `normalizedRatingCount = clamp(userRatingCount / 10000, 0, 1)`
- `normalizedAvgRating`: starts above rating `3`, scales toward `5`, and is damped for low rating counts (`<= 10`).
- `normalizedAge = 1 - clamp(daysSinceLastRelease / 365, 0, 1)`
- `keywordScore` from keyword presence in title/subtitle, evaluated per localization (default + additional locales) and choosing the best single-localization match:
  - exact title phrase: `1`
  - all keyword words in title or exact subtitle phrase: `0.7`
  - phrase in combined title+subtitle: `0.5`
  - all keyword words in subtitle: `0.4`
  - otherwise: `0`
  - words are never mixed across different localizations (no cross-localization token merge).
- `normalizedRatingPerDay`: rating velocity mapped to `[0,1]` with low-rate damping and high-rate saturation.
- Weighted score:
  - `appCompetitiveScore = 0.2*normalizedRatingCount + 0.2*normalizedAvgRating + 0.1*normalizedAge + 0.3*keywordScore + 0.2*normalizedRatingPerDay`

Keyword-level difficulty:
- `competitiveScores = top5.map(appCompetitiveScore)`
- `keywordMatch = best(top5.map(detectBestKeywordMatchType))` using `keywordMatchToScore` rank, persisted as enum value (not numeric score).
- `avgCompetitive = average(competitiveScores)`
- `minCompetitive = min(competitiveScores)`
- `normalizedAppCount = min(appCount / 200, 1)` (`MAX_COMPETING_APPS = 200`)
- weighted combination (minimum is emphasized):
  - `avgWeight = 1`
  - `minWeight = 2`
  - `appCountWeight = 1`
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
- `owned_apps` stores country-agnostic app identity/sidebar metadata (`id`, `kind`, `name`, `icon`) and is independent from competitor `aso_apps`.
- `owned_app_country_ratings` stores country-scoped owned-app ratings (`averageUserRating`, `userRatingCount`, previous snapshots, fetch timestamp, TTL) keyed by `(app_id, country)`.
- `aso_apps` stores competitor app-doc cache only (country scoped, no owned-app daily snapshot fields).
- `aso_apps.additionalLocalizations` stores locale-keyed `{ title, subtitle? }` for additional country locales used by difficulty matching.
- Interactive `aso keywords` runs (without `--stdout`) save requested keywords into `app_keywords` for the default research app (`research`) so failed terms stay visible in dashboard research workspace.
- MCP `aso_evaluate_keywords` saves only accepted keywords into `app_keywords`: defaults to the research app association, or uses caller-provided `appId` when set.
- Dashboard keyword reads include app-associated failures even when no `aso_keywords` cache row exists yet, marking those rows as failed for retry UX.
- Cache API repository is SQLite-backed and reuses local DB tables for keyword/app-doc cache lookups.
- No separate JSON cache file is used for ASO keyword/app-doc cache state.
- Rank delta baseline lives in `app_keywords.previous_position`.

## Expiration and Refresh
- TTLs are env-configurable and split by data volatility:
  - `ASO_KEYWORD_ORDER_TTL_HOURS` (default `24`): keyword order/rank data (`orderedAppIds`, `appCount`).
  - `ASO_POPULARITY_CACHE_TTL_HOURS` (default `720`): popularity + difficulty lifecycle (`30` days).
  - `ASO_APP_CACHE_TTL_HOURS` (default `168`): app document cache (`7` days).
- Dashboard owned apps (`GET /api/apps`) enforce `ASO_OWNED_APP_DOC_REFRESH_MAX_AGE_HOURS` (default `24`) using `owned_app_country_ratings.last_fetched_at` for the hydration country. Stale owned IDs are rehydrated from localized App Store app-page JSON and written back to `owned_app_country_ratings` (including previous rating/count snapshots).
- Cache lookup returns only rows that are complete and fresh for both order TTL and popularity TTL.
- Popularity and difficulty are refreshed together when popularity TTL expires.
- Startup refresh processes associated owned-app keywords in background batches when popularity expires, difficulty is missing, or order expires.
- Missing/expired app docs trigger hydration.

## API Surface
- `POST /aso/cache-lookup`
- `POST /aso/enrich`
- `POST /aso/app-docs` (max `50` IDs)
- `POST /api/aso/keywords/retry-failed`

## MCP Surface
- Tool: `aso_evaluate_keywords`
- Country: always `US` (country is not user-configurable at MCP level)
- Input: required `keywords` array (strings). Each item can be a single-word or long-tail phrase. Comma-separated entries are normalized and split.
- Input: optional `appId` string. When provided, accepted keywords are associated to that local app id instead of the default research app.
- Max request size: `100` provided keywords (enforced by MCP handler)
- Output is a JSON array of accepted keywords only (no rejected list). Each row includes:
  - `keyword`: normalized keyword phrase.
  - `popularity`: Apple Search Ads popularity score (higher is better).
  - `difficulty`: keyword competition difficulty score (lower is better).
  - `minDifficultyScore`: lowest visibility score among the top 5 search results for that keyword.

## Key Decisions
- Popularity stays in CLI because it depends on local Search Ads auth + Primary App ID context.
- Enrichment/cache stays backend-side for deterministic reuse.
- Two-stage flow keeps dashboard latency low while preserving full enrichment asynchronously.
- `keywordPipelineService` is the only orchestration entrypoint for CLI commands, dashboard keyword routes, startup refresh, and retry-failed flow.
- `keywordWriteRepository` is the only write owner for keyword/failure/app-doc persistence and previous-position updates.
