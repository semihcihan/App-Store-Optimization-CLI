# Apple Data Endpoint Matrix (ASO Runtime)

## Scope
Apple upstream fetch surfaces used by ASO keyword enrichment and dashboard app hydration.

## Internal Targets
- Keyword cache target (`aso_keywords`):
  - `keyword`, `normalizedKeyword`, `popularity`, `difficultyScore`, `minDifficultyScore`, `appCount`, `orderedAppIds`, `keywordMatch`
- Competitor app-doc target (`aso_apps`):
  - `country`, `appId`, `name`, `subtitle`, `averageUserRating`, `userRatingCount`, `releaseDate`, `currentVersionReleaseDate`, `icon`, `iconArtwork`, `additionalLocalizations`, `expiresAt`
- Owned app target (`owned_apps`):
  - `id`, `kind`, `name`, `icon`
- Owned app country-rating target (`owned_app_country_ratings`):
  - `appId`, `country`, `averageUserRating`, `userRatingCount`, `previousAverageUserRating`, `previousUserRatingCount`, `expiresAt`, `lastFetchedAt`

## Endpoint Matrix
| Endpoint | Used For | Apple fields we read | Internal mapping | Fallback / notes |
|---|---|---|---|---|
| `POST https://app-ads.apple.com/cm/api/v2/keywords/popularities?adamId={id}` | Keyword popularity stage | `data[].name`, `data[].popularity` | keyword key -> `normalizedKeyword`; popularity -> `popularity` | `popularity === null` rows are skipped. |
| `GET https://apps.apple.com/us/iphone/search?term={keyword}` | Primary keyword order + initial app docs | `serialized-server-data` lockups: `adamId`, `title`, `subtitle`, `rating`, `ratingCount`, `icon`; plus `nextPage.results[].id` (`type=apps`) | lockup fields seed `aso_apps` docs and keyword order/app count | Primary order source; on parse/contract failure, fall back to MZSearch order. `rating`/`ratingCount` here are bootstrap values and can be rounded/approximate. Dashboard add-app search uses lockup `id/name/icon` directly and does not run lookup hydration in this path. |
| `GET https://search.itunes.apple.com/WebObjects/MZSearch.woa/wa/search?clientApplication=Software&term={keyword}` | Order fallback | `pageData.bubbles[name=software].results[].id` | IDs -> `orderedAppIds`, count -> `appCount` | Used only when App Store search-page extraction fails. |
| `GET https://apps.apple.com/app/id{appId}` | Competitor app-doc enrichment (top docs, dates, icons) | `storePlatformData["product-dv"].results[*]` fields (`id`, `name`, `subtitle`, `userRating.value`, `userRating.ratingCount`, `releaseDate`, artwork/icon); `pageData.versionHistory[0].releaseDate` | Writes/updates `aso_apps` docs | Response can be JSON or HTML with `serialized-server-data`; parser supports both shapes. `releaseDate` + `currentVersionReleaseDate` come from this endpoint. `userRating.value` may be rounded, so do not treat it as owned/sidebar source of truth. |
| `GET https://apps.apple.com/{country}/app/id{appId}?l={language}` | Localized app-page refresh for owned apps and keyword-difficulty localization enrichment | JSON inside `<script id="serialized-server-data">`: `data[0].data.lockup.title`, `data[0].data.lockup.subtitle`, `data[0].data.lockup.icon`, `data[0].data.shelfMapping.productRatings.items[0].ratingAverage`, `data[0].data.shelfMapping.productRatings.items[0].totalNumberOfRatings` | Default locale: `title -> name`, `icon -> icon`, `subtitle -> subtitle`, `ratingAverage -> averageUserRating`, `totalNumberOfRatings -> userRatingCount`; additional locales: `title/subtitle -> aso_apps.additionalLocalizations[language]` | Parsed from serialized JSON only (no `h1/h2` HTML selector parsing). Sidebar/owned-app refresh stays single-language; keyword difficulty enrichment fetches configured additional locales per country with no locale-code fallback retries. This endpoint does not supply release-date fields. |

## Source Chains

### 1) Keyword enrichment chain
1. Try App Store search page for ordered IDs and lockup app metadata.
2. If search page fails, use MZSearch for order.
3. Hydrate top competitor docs through App Lookup; merge with cached/fresh competitor docs.

### 2) Owned app refresh chain
1. `/api/apps` reads `owned_apps` cache.
2. For stale owned rows (`kind=owned`), call localized app page endpoint.
3. Persist country-agnostic fields (`name`, `icon`) into `owned_apps` and rating fields into `owned_app_country_ratings`.

## Important Contracts
- Localized app page parsing must read `serialized-server-data` JSON; HTML selectors are intentionally not used.
- `ratingAverage` and `totalNumberOfRatings` from localized JSON are the source of truth wherever that endpoint is used.
- Keyword inclusion/difficulty matching evaluates each localization independently; terms are never mixed across different localizations.
- `releaseDate` / `currentVersionReleaseDate` are sourced from App Lookup (`/app/id{appId}`), not localized app-page JSON.
- Search-page lockup ratings are acceptable for initial seeding only and should not overwrite owned/sidebar rating snapshots.
- `aso_apps` and `owned_apps` are independent caches; docs are not shared between those tables.
