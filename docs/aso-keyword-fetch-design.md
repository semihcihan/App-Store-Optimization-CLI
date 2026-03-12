# ASO Keyword Fetch Design

## Scope
Design for `aso keywords` (including `--stdout`) and dashboard keyword-add flow: lookup, popularity, enrichment, and persistence.
Also covers MCP keyword suggestion entrypoint (`aso_suggest`) that evaluates explicit keywords + CLI invocation.

## Constraints
- Storefront: `US` only.
- Request size: max `100` keywords.
- Popularity stage requires a valid Primary App ID accessible by the caller's Apple Ads account.
- ASO research `keyword` means a search term candidate, which can be a single word or a multi-word long-tail phrase.
- App Store metadata keyword field is comma-separated and limited to `100` characters, so terms should be compactly separated (example: `love,couple`).

## Responsibility Split
- CLI (`cli/services/keywords/aso-keyword-service.ts`): normalize keywords, orchestrate stages, fetch popularity, persist local records.
- MCP server (`cli/mcp/index.ts`): validate explicit `keywords` input (max 100), call `aso keywords "<comma-separated-keywords>" --stdout`, and return only accepted rows after threshold filtering.
- Backend (`cli/services/cache-api/routes/aso.ts`, `cli/services/cache-api/services/*`): lookup cache, enrich keywords, serve app docs, persist backend cache.
- Dashboard server (`cli/dashboard-server/server.ts`): run stage 1 synchronously, return early, run stage 2 in background.

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
8. Persist terminal popularity/enrichment failures in `aso_keyword_failures`.

## Machine-Safe `--stdout` Contract
- `aso keywords "<comma-separated-keywords>" --stdout` is keyword-only and intended for agents/machine calls.
- Primary App ID resolution is non-interactive in this mode.
- If `--primary-app-id` is omitted and no saved Primary App ID exists, command fails with guidance to set it first.
- It first runs keyword fetch with interactive auth recovery disabled.
- If auth is required, it attempts one reauthentication pass that is allowed only when no user interaction is needed.
- If credentials/2FA/confirmation input is required, command fails with guidance to run `aso auth` in a terminal first.
- After successful `aso auth`, later `--stdout` runs can reuse saved session/cookies.
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
- App detail sources: App Store lookup payloads and title/subtitle page parsing.
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
- `keywordScore` from keyword presence in title/subtitle:
  - exact title phrase: `1`
  - all keyword words in title or exact subtitle phrase: `0.7`
  - phrase in combined title+subtitle: `0.5`
  - all keyword words in subtitle: `0.4`
  - otherwise: `0`
- `normalizedRatingPerDay`: rating velocity mapped to `[0,1]` with low-rate damping and high-rate saturation.
- Weighted score:
  - `appCompetitiveScore = 0.2*normalizedRatingCount + 0.2*normalizedAvgRating + 0.1*normalizedAge + 0.3*keywordScore + 0.2*normalizedRatingPerDay`

Keyword-level difficulty:
- `competitiveScores = top5.map(appCompetitiveScore)`
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

## Persistence Model
- Local DB (`~/.aso/aso-db.sqlite`): `aso_keywords`, `aso_apps`, `app_keywords`.
- Failure DB table: `aso_keyword_failures` keyed by `(country, normalized_keyword)` for current failed state.
- Local DB stores `difficultyScore` and `minDifficultyScore` as rounded integers on write.
- Interactive `aso keywords` runs (without `--stdout`) save returned keywords into `app_keywords` for the default research app (`research`) so they appear in dashboard research workspace.
- MCP `aso_suggest` saves only accepted keywords into the same default research app association.
- Cache API repository is SQLite-backed and reuses local DB tables for keyword/app-doc cache lookups.
- No separate JSON cache file is used for ASO keyword/app-doc cache state.
- Rank delta baseline lives in `app_keywords.previous_position`.

## Expiration and Refresh
- TTLs are env-configurable and split by data volatility:
  - `ASO_KEYWORD_ORDER_TTL_HOURS` (default `24`): keyword order/rank data (`orderedAppIds`, `appCount`).
  - `ASO_POPULARITY_CACHE_TTL_HOURS` (default `720`): popularity + difficulty lifecycle (`30` days).
  - `ASO_APP_CACHE_TTL_HOURS` (default `168`): app document cache (`7` days).
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
- Tool: `aso_suggest`
- Country: always `US` (country is not user-configurable at MCP level)
- Input: required `keywords` array (strings). Each item can be a single-word or long-tail phrase. Comma-separated entries are normalized and split.
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
