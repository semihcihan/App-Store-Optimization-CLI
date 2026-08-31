import { logger } from "../../../utils/logger";
import {
  computeAppExpiryIsoForApp,
  normalizeKeyword,
  normalizeTextForKeywordMatch,
} from "./aso-keyword-utils";
import {
  fetchAppStoreAdditionalLocalizations,
  fetchAppStoreLocalizedAppData,
} from "./aso-app-store-details";
import { normalizeCountryOnAppDocs } from "./aso-app-doc-utils";
import { fetchAppStoreLookupAppDocs } from "./aso-app-doc-service";
import type { AsoAppDoc, AsoAppDocIcon } from "./aso-types";
import { asoAppleGet } from "./aso-apple-client";
import { reportAppleContractChange } from "../../keywords/apple-http-trace";
import { getStorefrontDefaultLanguage } from "../../../shared/aso-storefront-localizations";
import { ASO_APPLE_WEB_USER_AGENT } from "../../../shared/aso-apple-http";
import type { KeywordMatchType } from "../../../shared/aso-keyword-match";
import {
  calculateAppDifficultyBreakdown,
  calculateKeywordDifficultyBreakdown,
  keywordMatchToScore,
} from "./aso-difficulty";
import {
  hasRequiredTopDifficultyDocs,
  requiresTopDifficultyDocs,
  TOP_DIFFICULTY_DOC_LIMIT,
} from "../../../shared/aso-difficulty-policy";

interface MzSearchResponse {
  pageData?: {
    bubbles?: Array<{
      name?: string;
      results?: Array<{ id?: string | number }>;
    }>;
  };
}

interface AmpSearchLockup {
  adamId?: string;
  title?: string;
  subtitle?: string | null;
  developerName?: string;
  icon?: {
    template?: string;
    width?: number;
    height?: number;
    backgroundColor?: { red: number; green: number; blue: number };
    [key: string]: unknown;
  };
  rating?: number;
  ratingCount?: string | number;
}

interface AmpSearchResponse {
  data?: Array<{
    data?: {
      shelves?: Array<{
        contentType?: string;
        items?: Array<{
          $kind?: string;
          resultType?: string;
          lockup?: AmpSearchLockup;
        }>;
      }>;
      nextPage?: {
        results?: Array<{
          id?: string;
          type?: string;
        }>;
      };
    };
  }>;
}

const MZSEARCH_PLATFORM_ID_JSON = 29;
const STORE_FRONT_ID_BY_COUNTRY: Record<string, number> = {
  US: 143441,
};
const MZSEARCH_ORDER_URL =
  "https://search.itunes.apple.com/WebObjects/MZSearch.woa/wa/search";
const APPSTORE_SEARCH_URL = "https://apps.apple.com/us/iphone/search";
const INSUFFICIENT_DOCS_RETRY_COUNT = 1;
const INSUFFICIENT_DOCS_RETRY_BACKOFF_MS = 150;
const INCOMPLETE_TOP_DOC_LOOKUP_COOLDOWN_MS = 10 * 60 * 1000;
const incompleteTopDocLookupCooldownUntilByAppId = new Map<string, number>();

type SearchContractDrift = {
  operation: "appstore.search-page" | "mzsearch.keyword-order";
  endpoint: string;
  expectedContract: string;
  actualSignal: string;
  driftKind: string;
  statusCode?: number;
  error?: unknown;
};

function isIncompleteTopDocLookupOnCooldown(
  appId: string,
  nowMs: number = Date.now()
): boolean {
  const cooldownUntil = incompleteTopDocLookupCooldownUntilByAppId.get(appId);
  if (cooldownUntil == null) return false;
  if (cooldownUntil <= nowMs) {
    incompleteTopDocLookupCooldownUntilByAppId.delete(appId);
    return false;
  }
  return true;
}

function markIncompleteTopDocLookupCooldown(
  appIds: string[],
  nowMs: number = Date.now()
): void {
  if (appIds.length === 0) return;
  const cooldownUntil = nowMs + INCOMPLETE_TOP_DOC_LOOKUP_COOLDOWN_MS;
  for (const appId of appIds) {
    incompleteTopDocLookupCooldownUntilByAppId.set(appId, cooldownUntil);
  }
}

function clearIncompleteTopDocLookupCooldown(appIds: string[]): void {
  if (appIds.length === 0) return;
  for (const appId of appIds) {
    incompleteTopDocLookupCooldownUntilByAppId.delete(appId);
  }
}

export function __resetIncompleteTopDocLookupCooldownForTests(): void {
  incompleteTopDocLookupCooldownUntilByAppId.clear();
}

class InsufficientDifficultyDocsError extends Error {
  readonly code = "INSUFFICIENT_DOCS";
  readonly statusCode = 503;

  constructor(params: {
    keyword: string;
    country: string;
    appCount: number;
    docsForDifficultyCount: number;
    missingTopIds: string[];
  }) {
    super(
      `Insufficient top-app docs for difficulty scoring: keyword="${params.keyword}" country="${params.country}" appCount=${params.appCount} docsForDifficulty=${params.docsForDifficultyCount} missingTopIds=${params.missingTopIds.join(",")}`
    );
    this.name = "InsufficientDifficultyDocsError";
  }
}

function safeDaysSince(isoDate: string | undefined): number {
  if (!isoDate) return 365;
  const parsed = Date.parse(isoDate);
  if (Number.isNaN(parsed)) return 365;
  return Math.max(1, Math.floor((Date.now() - parsed) / (1000 * 60 * 60 * 24)));
}

function parseRatingCount(value: string | number | undefined): number {
  if (value == null) return 0;
  if (typeof value === "number" && !Number.isNaN(value))
    return Math.max(0, value);
  const s = String(value).trim().toUpperCase();
  if (!s) return 0;
  const num = parseFloat(s.replace(/[^0-9.]/g, ""));
  if (Number.isNaN(num)) return 0;
  if (s.endsWith("M")) return Math.round(num * 1000000);
  if (s.endsWith("K")) return Math.round(num * 1000);
  return Math.round(num);
}

function detectKeywordMatchType(
  name: string,
  subtitle: string | undefined,
  keyword: string
): KeywordMatchType {
  const normKeyword = normalizeTextForKeywordMatch(keyword);
  const keywordParts = new Set(normKeyword.split(" ").filter(Boolean));
  const normTitle = normalizeTextForKeywordMatch(name);

  if (normTitle.includes(normKeyword)) return "titleExactPhrase";

  const titleWords = new Set(normTitle.split(" ").filter(Boolean));
  if (
    keywordParts.size > 0 &&
    [...keywordParts].every((w) => titleWords.has(w))
  )
    return "titleAllWords";

  const normSubtitle = normalizeTextForKeywordMatch(subtitle || "");
  if (normSubtitle && normSubtitle.includes(normKeyword))
    return "subtitleExactPhrase";

  const combined = `${normTitle} ${normSubtitle}`.trim();
  if (combined.includes(normKeyword)) return "combinedPhrase";

  const subtitleWords = new Set(normSubtitle.split(" ").filter(Boolean));
  if (
    keywordParts.size > 0 &&
    subtitleWords.size > 0 &&
    [...keywordParts].every((w) => subtitleWords.has(w))
  ) {
    return "subtitleAllWords";
  }

  return "none";
}

function detectBestKeywordMatchType(
  app: AsoAppDoc,
  keyword: string
): KeywordMatchType {
  const localizations: Array<{ name: string; subtitle?: string }> = [
    { name: app.name, subtitle: app.subtitle },
  ];
  for (const localized of Object.values(app.additionalLocalizations ?? {})) {
    localizations.push({
      name: localized.name,
      subtitle: localized.subtitle,
    });
  }

  let bestMatch: KeywordMatchType = "none";
  let bestScore = 0;
  for (const localized of localizations) {
    const match = detectKeywordMatchType(
      localized.name,
      localized.subtitle,
      keyword
    );
    const score = keywordMatchToScore(match);
    if (score > bestScore) {
      bestMatch = match;
      bestScore = score;
      if (bestScore >= 1) {
        break;
      }
    }
  }
  return bestMatch;
}

function detectTopKeywordMatchType(
  apps: AsoAppDoc[],
  keyword: string
): KeywordMatchType {
  let topMatch: KeywordMatchType = "none";
  let topScore = 0;
  for (const app of apps) {
    const match = detectBestKeywordMatchType(app, keyword);
    const score = keywordMatchToScore(match);
    if (score > topScore) {
      topMatch = match;
      topScore = score;
      if (topScore >= 1) {
        break;
      }
    }
  }
  return topMatch;
}

function tokenizeForBrand(value: string): string[] {
  return (value.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(Boolean);
}

function detectIsBrandKeyword(keyword: string, apps: AsoAppDoc[]): boolean {
  const leader = apps[0];
  if (!leader?.publisherName) return false;

  const keywordTokens = new Set(tokenizeForBrand(keyword));
  if (keywordTokens.size === 0) return false;

  const leaderPublisherTokens = new Set(tokenizeForBrand(leader.publisherName));
  if (leaderPublisherTokens.size === 0) return false;
  for (const token of keywordTokens) {
    if (!leaderPublisherTokens.has(token)) {
      return false;
    }
  }

  const leaderReviews = Math.max(0, leader.userRatingCount || 0);
  if (leaderReviews >= 1000) {
    return true;
  }

  const leaderPublisher = leader.publisherName.trim().toLowerCase();
  const independentRunnerUps = apps
    .slice(1, TOP_DIFFICULTY_DOC_LIMIT)
    .filter((app) => {
      const publisher = app.publisherName?.trim().toLowerCase();
      return Boolean(publisher && publisher !== leaderPublisher);
    });
  if (independentRunnerUps.length === 0) {
    return false;
  }

  const sortedRunnerUpRatings = independentRunnerUps
    .map((app) => Math.max(0, app.userRatingCount || 0))
    .sort((a, b) => a - b);
  const n = sortedRunnerUpRatings.length;
  const medianRunnerUpRatings =
    n % 2 === 1
      ? sortedRunnerUpRatings[Math.floor(n / 2)]
      : (sortedRunnerUpRatings[n / 2 - 1] + sortedRunnerUpRatings[n / 2]) / 2;
  return medianRunnerUpRatings >= 10000;
}

function appCompetitiveScore(app: AsoAppDoc, keyword: string): number {
  const ratingCount = app.userRatingCount || 0;
  const avgRating = app.averageUserRating ?? 0;
  const lastRelease = app.currentVersionReleaseDate || app.releaseDate;
  const firstRelease = app.releaseDate;
  const daysSinceLastRelease = safeDaysSince(lastRelease ?? undefined);
  const daysSinceFirstRelease = safeDaysSince(firstRelease ?? undefined);
  const keywordMatch = detectBestKeywordMatchType(app, keyword);

  return calculateAppDifficultyBreakdown({
    averageUserRating: avgRating,
    userRatingCount: ratingCount,
    daysSinceLastRelease,
    daysSinceFirstRelease,
    keywordMatch,
  }).score;
}

function getStoreFrontHeader(country: string): string {
  const storeId = STORE_FRONT_ID_BY_COUNTRY[country.toUpperCase()] || 143441;
  return `${storeId}-1,${MZSEARCH_PLATFORM_ID_JSON}`;
}

async function fetchPopularityOrderedIds(params: {
  keyword: string;
  country: string;
}): Promise<{ ids: string[] | null; drifts: SearchContractDrift[] }> {
  const response = await asoAppleGet<MzSearchResponse>(MZSEARCH_ORDER_URL, {
    operation: "mzsearch.keyword-order",
    params: {
      clientApplication: "Software",
      term: params.keyword,
    },
    headers: {
      "User-Agent": ASO_APPLE_WEB_USER_AGENT,
      "Accept-Language": "en-US,en;q=0.9",
      Cookie: "dslang=US-EN",
      "x-apple-store-front": getStoreFrontHeader(params.country),
    },
    timeout: 30000,
  });

  const bubbles = response.data?.pageData?.bubbles;
  if (!Array.isArray(bubbles)) {
    return {
      ids: null,
      drifts: [
        {
          operation: "mzsearch.keyword-order",
          endpoint: MZSEARCH_ORDER_URL,
          statusCode: response.status,
          expectedContract: "MZSearch response has pageData.bubbles[]",
          actualSignal: `bubblesType=${typeof bubbles}`,
          driftKind: "mzsearch_bubbles_not_array",
        },
      ],
    };
  }

  for (const bubble of bubbles) {
    if (bubble?.name !== "software") continue;
    if (!Array.isArray(bubble.results)) {
      return {
        ids: null,
        drifts: [
          {
            operation: "mzsearch.keyword-order",
            endpoint: MZSEARCH_ORDER_URL,
            statusCode: response.status,
            expectedContract: "software bubble has results[] entries",
            actualSignal: `softwareResultsType=${typeof bubble.results}`,
            driftKind: "mzsearch_software_results_not_array",
          },
        ],
      };
    }
    const ids = bubble.results
      .map((result) => `${result.id || ""}`.trim())
      .filter(Boolean);
    const malformedResultCount = bubble.results.length - ids.length;
    return {
      ids,
      drifts:
        malformedResultCount === 0
          ? []
          : [
              {
                operation: "mzsearch.keyword-order",
                endpoint: MZSEARCH_ORDER_URL,
                statusCode: response.status,
                expectedContract:
                  "software results[] entries include an app id",
                actualSignal: `malformedResults=${malformedResultCount} totalResults=${bubble.results.length}`,
                driftKind: "mzsearch_result_missing_id",
              },
            ],
    };
  }

  return { ids: [], drifts: [] };
}

function lockupToAppDoc(
  lockup: AmpSearchLockup,
  country: string
): AsoAppDoc | null {
  const adamId = `${lockup?.adamId || ""}`.trim();
  if (!adamId) return null;
  const name = (lockup?.title ?? "").trim() || "Unknown";
  const subtitle = lockup?.subtitle?.trim() || undefined;
  const publisherName = lockup?.developerName?.trim() || undefined;
  const rating = lockup?.rating;
  const averageUserRating =
    typeof rating === "number" && !Number.isNaN(rating) ? rating : 0;
  const userRatingCount = parseRatingCount(lockup?.ratingCount);
  const icon: AsoAppDocIcon | undefined = lockup?.icon
    ? {
        template: lockup.icon.template,
        width: lockup.icon.width,
        height: lockup.icon.height,
        backgroundColor: lockup.icon.backgroundColor,
      }
    : undefined;

  return {
    appId: adamId,
    country: country.toUpperCase(),
    name,
    subtitle,
    publisherName,
    averageUserRating,
    userRatingCount,
    icon,
  };
}

function isAppLikeSearchResultItem(item: {
  $kind?: string;
  resultType?: string;
}): boolean {
  const kind = (item.$kind ?? "").trim();
  const resultType = (item.resultType ?? "").trim().toLowerCase();
  if (kind === "BundleSearchResult" || resultType === "bundle") {
    return false;
  }
  return true;
}

type SearchPageData = {
  orderedAppIds: string[];
  appDocs: AsoAppDoc[];
  appCount: number | null;
  drifts: SearchContractDrift[];
};

type ResolvedSearchData = {
  orderedAppIds: string[] | null;
  appDocs: AsoAppDoc[];
  appCount: number | null;
  sourceMode:
    | "search-page"
    | "search-page+mzsearch-count"
    | "search-page-docs+mzsearch-order"
    | "mzsearch-fallback"
    | "partial-unresolved";
};

async function fetchSearchPageData(params: {
  keyword: string;
  country: string;
}): Promise<SearchPageData> {
  const response = await asoAppleGet(APPSTORE_SEARCH_URL, {
    operation: "appstore.search-page",
    params: { term: params.keyword },
    headers: {
      "User-Agent": ASO_APPLE_WEB_USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    timeout: 30000,
  });

  const html = `${response.data || ""}`;
  const serializedDataMatch = html.match(
    /<script[^>]*id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/i
  );
  if (!serializedDataMatch?.[1]) {
    return {
      orderedAppIds: [],
      appDocs: [],
      appCount: null,
      drifts: [
        {
          operation: "appstore.search-page",
          endpoint: APPSTORE_SEARCH_URL,
          statusCode: response.status,
          expectedContract: "Search page includes serialized-server-data JSON",
          actualSignal: "serialized_server_data_script_missing",
          driftKind: "search_page_serialized_data_missing",
        },
      ],
    };
  }

  let parsed: AmpSearchResponse;
  try {
    parsed = JSON.parse(serializedDataMatch[1]) as AmpSearchResponse;
  } catch (error) {
    return {
      orderedAppIds: [],
      appDocs: [],
      appCount: null,
      drifts: [
        {
          operation: "appstore.search-page",
          endpoint: APPSTORE_SEARCH_URL,
          statusCode: response.status,
          expectedContract: "serialized-server-data contains valid JSON",
          actualSignal: "serialized_server_data_json_invalid",
          driftKind: "search_page_serialized_json_invalid",
          error,
        },
      ],
    };
  }
  const pageData = parsed.data?.[0]?.data;
  if (!pageData) {
    return {
      orderedAppIds: [],
      appDocs: [],
      appCount: null,
      drifts: [
        {
          operation: "appstore.search-page",
          endpoint: APPSTORE_SEARCH_URL,
          statusCode: response.status,
          expectedContract: "serialized-server-data includes data[0].data",
          actualSignal: "search_page_data_root_missing",
          driftKind: "search_page_data_root_missing",
        },
      ],
    };
  }
  const drifts: SearchContractDrift[] = [];
  const shelves = pageData.shelves;
  if (!Array.isArray(shelves)) {
    drifts.push({
      operation: "appstore.search-page",
      endpoint: APPSTORE_SEARCH_URL,
      statusCode: response.status,
      expectedContract: "Search page serialized data includes shelves[]",
      actualSignal: `shelvesType=${typeof shelves}`,
      driftKind: "search_page_shelves_not_array",
    });
  }
  const usableShelves = Array.isArray(shelves) ? shelves : [];
  const searchShelf = usableShelves.find(
    (shelf) => shelf?.contentType === "searchResult"
  );
  if (!searchShelf) {
    drifts.push({
      operation: "appstore.search-page",
      endpoint: APPSTORE_SEARCH_URL,
      statusCode: response.status,
      expectedContract: "Search page shelves include a searchResult shelf",
      actualSignal: "search_result_shelf_missing",
      driftKind: "search_page_search_shelf_missing",
    });
  } else if (!Array.isArray(searchShelf.items)) {
    drifts.push({
      operation: "appstore.search-page",
      endpoint: APPSTORE_SEARCH_URL,
      statusCode: response.status,
      expectedContract: "Search result shelf includes items[]",
      actualSignal: `itemsType=${typeof searchShelf.items}`,
      driftKind: "search_page_search_items_not_array",
    });
  }

  const appDocs: AsoAppDoc[] = [];
  const seenAppDocIds = new Set<string>();
  for (const shelf of usableShelves) {
    if (!Array.isArray(shelf?.items)) continue;
    for (const item of shelf.items) {
      if (!isAppLikeSearchResultItem(item)) continue;
      const lockup = item?.lockup;
      if (!lockup) continue;
      const doc = lockupToAppDoc(lockup, params.country);
      if (doc && !seenAppDocIds.has(doc.appId)) {
        seenAppDocIds.add(doc.appId);
        appDocs.push(doc);
      }
    }
  }

  const leadingOrderedIds: string[] = [];
  let malformedLockupCount = 0;
  for (const item of searchShelf?.items ?? []) {
    if (!isAppLikeSearchResultItem(item)) {
      continue;
    }
    const lockup = item?.lockup;
    if (!lockup) {
      malformedLockupCount += 1;
      continue;
    }
    const doc = lockupToAppDoc(lockup, params.country);
    if (doc) {
      leadingOrderedIds.push(doc.appId);
    } else {
      malformedLockupCount += 1;
    }
  }
  if (malformedLockupCount > 0) {
    drifts.push({
      operation: "appstore.search-page",
      endpoint: APPSTORE_SEARCH_URL,
      statusCode: response.status,
      expectedContract: "App search result lockups include an adamId",
      actualSignal: `malformedLockups=${malformedLockupCount}`,
      driftKind: "search_page_lockup_missing_required_fields",
    });
  }

  let tailIds: string[] = [];
  let appCount: number | null = null;
  if (pageData.nextPage) {
    if (!Array.isArray(pageData.nextPage.results)) {
      drifts.push({
        operation: "appstore.search-page",
        endpoint: APPSTORE_SEARCH_URL,
        statusCode: response.status,
        expectedContract: "Present nextPage includes results[]",
        actualSignal: `nextPageResultsType=${typeof pageData.nextPage.results}`,
        driftKind: "search_page_next_page_results_not_array",
      });
    } else {
      const malformedAppResultCount = pageData.nextPage.results.filter(
        (item) =>
          item?.type === "apps" &&
          (typeof item.id !== "string" || item.id.trim() === "")
      ).length;
      if (malformedAppResultCount > 0) {
        drifts.push({
          operation: "appstore.search-page",
          endpoint: APPSTORE_SEARCH_URL,
          statusCode: response.status,
          expectedContract: "nextPage app results include a non-empty id",
          actualSignal: `malformedAppResults=${malformedAppResultCount} totalResults=${pageData.nextPage.results.length}`,
          driftKind: "search_page_next_page_app_id_missing",
        });
      }
      tailIds = pageData.nextPage.results
        .filter((item) => item?.type === "apps")
        .map((item) => `${item.id || ""}`.trim())
        .filter(Boolean);
      appCount = new Set([...leadingOrderedIds, ...tailIds]).size;
    }
  }
  const orderedAppIds = [...new Set([...leadingOrderedIds, ...tailIds])];

  return {
    orderedAppIds,
    appDocs,
    appCount,
    drifts,
  };
}

function reportSearchContractDrifts(params: {
  keyword: string;
  country: string;
  drifts: SearchContractDrift[];
  recoveryOutcome: "recovered" | "unresolved";
  fallbackSource?: "mzsearch";
}): void {
  for (const drift of params.drifts) {
    reportAppleContractChange({
      provider: "apple-appstore",
      ...drift,
      context: {
        keyword: params.keyword,
        country: params.country,
      },
      isTerminal: params.recoveryOutcome === "unresolved",
      recoveryOutcome: params.recoveryOutcome,
      fallbackSource: params.fallbackSource,
    });
  }
}

async function resolveSearchData(params: {
  keyword: string;
  country: string;
}): Promise<ResolvedSearchData> {
  let primaryData: SearchPageData = {
    orderedAppIds: [],
    appDocs: [],
    appCount: null,
    drifts: [],
  };

  try {
    primaryData = await fetchSearchPageData(params);
  } catch (error) {
    logger.debug("[aso-enrichment] search page request failed", {
      keyword: params.keyword,
      country: params.country,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const hasPrimaryOrder = primaryData.orderedAppIds.length > 0;
  const hasPrimaryDocs = primaryData.appDocs.length > 0;
  const hasConfirmedEmptyPrimary =
    primaryData.appCount === 0 && primaryData.drifts.length === 0;
  const needsMzSearch =
    primaryData.appCount == null ||
    (!hasPrimaryOrder && !hasConfirmedEmptyPrimary);
  let mzSearchIds: string[] | null = null;
  const contractDrifts = [...primaryData.drifts];

  if (needsMzSearch) {
    try {
      const mzSearch = await fetchPopularityOrderedIds(params);
      mzSearchIds = mzSearch.ids;
      contractDrifts.push(...mzSearch.drifts);
    } catch (error) {
      logger.debug("[aso-enrichment] MZSearch fallback failed", {
        keyword: params.keyword,
        country: params.country,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const hasUsefulPrimaryData = hasPrimaryOrder || hasPrimaryDocs;
  if (hasUsefulPrimaryData && mzSearchIds?.length === 0) {
    contractDrifts.push({
      operation: "mzsearch.keyword-order",
      endpoint: MZSEARCH_ORDER_URL,
      expectedContract:
        "MZSearch returns software results when the primary App Store response contains apps",
      actualSignal: `primaryOrderedAppIds=${primaryData.orderedAppIds.length} primaryAppDocs=${primaryData.appDocs.length} mzSearchIds=0`,
      driftKind: "mzsearch_empty_contradicts_primary",
    });
    mzSearchIds = null;
  }

  const orderedAppIds =
    hasPrimaryOrder || hasConfirmedEmptyPrimary
      ? primaryData.orderedAppIds
      : mzSearchIds;
  let appCount: number | null = null;
  if (
    (hasUsefulPrimaryData || hasConfirmedEmptyPrimary) &&
    primaryData.appCount != null
  ) {
    appCount = Math.max(
      primaryData.appCount,
      primaryData.orderedAppIds.length,
      mzSearchIds?.length ?? 0
    );
  } else if (mzSearchIds != null) {
    appCount = Math.max(primaryData.orderedAppIds.length, mzSearchIds.length);
  }

  let sourceMode: ResolvedSearchData["sourceMode"] = "partial-unresolved";
  if (!needsMzSearch) {
    sourceMode = "search-page";
  } else if (hasPrimaryOrder && mzSearchIds != null) {
    sourceMode = "search-page+mzsearch-count";
  } else if (hasPrimaryDocs && mzSearchIds != null) {
    sourceMode = "search-page-docs+mzsearch-order";
  } else if (mzSearchIds != null) {
    sourceMode = "mzsearch-fallback";
  }

  const recoveryOutcome =
    orderedAppIds != null && appCount != null ? "recovered" : "unresolved";
  reportSearchContractDrifts({
    keyword: params.keyword,
    country: params.country,
    drifts: contractDrifts,
    recoveryOutcome,
    ...(needsMzSearch ? { fallbackSource: "mzsearch" } : {}),
  });

  return {
    orderedAppIds,
    appDocs: primaryData.appDocs,
    appCount,
    sourceMode,
  };
}

export async function refreshKeywordOrder(params: {
  keyword: string;
  country: string;
}): Promise<{
  keyword: string;
  normalizedKeyword: string;
  appCount: number | null;
  orderedAppIds: string[] | null;
  appDocs: AsoAppDoc[];
}> {
  const country = params.country.toUpperCase();
  const normalizedKeyword = normalizeKeyword(params.keyword);
  const resolved = await resolveSearchData({
    keyword: normalizedKeyword,
    country,
  });
  const { orderedAppIds, appDocs, appCount, sourceMode } = resolved;

  logger.debug("[aso-enrichment] order source", {
    keyword: params.keyword,
    country,
    mode: sourceMode,
    appCountResolved: appCount != null,
    orderedAppIdsResolved: orderedAppIds != null,
    orderedAppIdsCount: orderedAppIds?.length ?? 0,
    appDocsCount: appDocs.length,
  });

  logger.debug("[aso-enrichment] order result", {
    keyword: params.keyword,
    country,
    mode: sourceMode,
    appCount,
    orderedAppIdsCount: orderedAppIds?.length ?? 0,
    appDocsCount: appDocs.length,
  });
  return {
    keyword: params.keyword,
    normalizedKeyword,
    appCount,
    orderedAppIds,
    appDocs,
  };
}

type LookupDetails = {
  releaseDate: string | null;
  currentVersionReleaseDate: string | null;
  userRatingCount: number;
};

async function lookupDetailsForAppIds(params: {
  appIds: string[];
  country: string;
}): Promise<Map<string, LookupDetails>> {
  const map = new Map<string, LookupDetails>();
  if (params.appIds.length === 0) return map;
  try {
    const docs = await fetchAppStoreLookupAppDocs({
      country: params.country,
      appIds: params.appIds,
    });
    for (const doc of docs) {
      map.set(doc.appId, {
        releaseDate: doc.releaseDate ?? null,
        currentVersionReleaseDate: doc.currentVersionReleaseDate ?? null,
        userRatingCount: parseRatingCount(doc.userRatingCount),
      });
      if (!doc.releaseDate || !doc.currentVersionReleaseDate) {
        logger.debug(
          "[aso-enrichment] lookup returned app with missing dates",
          {
            appId: doc.appId,
            country: params.country.toUpperCase(),
            hasReleaseDate: Boolean(doc.releaseDate),
            hasCurrentVersionReleaseDate: Boolean(
              doc.currentVersionReleaseDate
            ),
          }
        );
      }
    }
  } catch (error) {
    logger.debug("[aso-enrichment] lookup details fetch failed", {
      appIds: params.appIds,
      country: params.country.toUpperCase(),
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return map;
}

async function buildAppDocsFromLookup(params: {
  appIds: string[];
  country: string;
}): Promise<AsoAppDoc[]> {
  const defaultLanguage = getStorefrontDefaultLanguage(params.country);
  let lookupDocs: AsoAppDoc[] = [];
  try {
    lookupDocs = await fetchAppStoreLookupAppDocs({
      country: params.country,
      appIds: params.appIds,
    });
  } catch {
    lookupDocs = [];
  }

  const byId = new Map(lookupDocs.map((doc) => [doc.appId, doc]));
  const results = await Promise.all(
    params.appIds.map(async (id): Promise<AsoAppDoc | null> => {
      const lookupDoc = byId.get(id);
      if (!lookupDoc) return null;
      try {
        const details = await fetchAppStoreLocalizedAppData(
          id,
          params.country,
          defaultLanguage
        );
        const additionalLocalizations =
          await fetchAppStoreAdditionalLocalizations(id, params.country);
        const averageUserRating =
          details?.ratingAverage ?? lookupDoc.averageUserRating;
        const userRatingCount =
          details?.totalNumberOfRatings == null
            ? lookupDoc.userRatingCount
            : parseRatingCount(details.totalNumberOfRatings);
        return {
          ...lookupDoc,
          name: details?.title || lookupDoc.name || "Unknown",
          subtitle: details?.subtitle ?? undefined,
          averageUserRating,
          userRatingCount,
          ...(Object.keys(additionalLocalizations).length > 0
            ? { additionalLocalizations }
            : {}),
        };
      } catch {
        return lookupDoc;
      }
    })
  );

  return results.filter((d): d is AsoAppDoc => d != null);
}

function mergeSearchFieldsIntoAppDoc(
  cached: AsoAppDoc,
  searchDoc: AsoAppDoc
): AsoAppDoc {
  return {
    ...cached,
    country: searchDoc.country,
    name: searchDoc.name,
    subtitle: searchDoc.subtitle,
    publisherName: searchDoc.publisherName ?? cached.publisherName,
    averageUserRating: searchDoc.averageUserRating,
    userRatingCount: searchDoc.userRatingCount,
    icon: searchDoc.icon,
  };
}

async function hydrateMissingAdditionalLocalizations(params: {
  appDocs: AsoAppDoc[];
  appIds: string[];
  country: string;
}): Promise<AsoAppDoc[]> {
  if (params.appIds.length === 0 || params.appDocs.length === 0) {
    return params.appDocs;
  }

  const docsById = new Map(
    params.appDocs.map((doc) => [doc.appId, doc] as const)
  );
  await Promise.all(
    params.appIds.map(async (appId) => {
      const existing = docsById.get(appId);
      if (!existing) return;
      if (
        existing.additionalLocalizations &&
        Object.keys(existing.additionalLocalizations).length > 0
      ) {
        return;
      }
      const additionalLocalizations =
        await fetchAppStoreAdditionalLocalizations(appId, params.country);
      if (Object.keys(additionalLocalizations).length === 0) {
        return;
      }
      docsById.set(appId, {
        ...existing,
        additionalLocalizations,
      });
    })
  );

  return params.appDocs.map((doc) => docsById.get(doc.appId) ?? doc);
}

function mergeAppDocsById(
  baseDocs: AsoAppDoc[],
  incomingDocs: AsoAppDoc[]
): AsoAppDoc[] {
  if (incomingDocs.length === 0) return baseDocs;
  const merged = [...baseDocs];
  const indexById = new Map(
    merged.map((doc, index) => [doc.appId, index] as const)
  );
  for (const doc of incomingDocs) {
    const existingIndex = indexById.get(doc.appId);
    if (existingIndex == null) {
      indexById.set(doc.appId, merged.length);
      merged.push(doc);
      continue;
    }
    merged[existingIndex] = doc;
  }
  return merged;
}

function hasCompleteDifficultyDoc(doc: AsoAppDoc | undefined): boolean {
  if (!doc) return false;
  return Boolean(doc.releaseDate && doc.currentVersionReleaseDate);
}

function listIncompleteTopDifficultyDocIds(params: {
  orderedAppIds: string[];
  appDocs: AsoAppDoc[];
}): string[] {
  const topIds = params.orderedAppIds.slice(0, TOP_DIFFICULTY_DOC_LIMIT);
  if (topIds.length === 0) return [];
  const docsById = new Map(
    params.appDocs.map((doc) => [doc.appId, doc] as const)
  );
  return topIds.filter((id) => !hasCompleteDifficultyDoc(docsById.get(id)));
}

function reorderAppDocsForTopDifficultyIds(params: {
  orderedAppIds: string[];
  appDocs: AsoAppDoc[];
}): AsoAppDoc[] {
  const topIds = params.orderedAppIds.slice(0, TOP_DIFFICULTY_DOC_LIMIT);
  if (topIds.length === 0) return params.appDocs;
  const docsById = new Map(
    params.appDocs.map((doc) => [doc.appId, doc] as const)
  );
  const topDocs = topIds
    .map((id) => docsById.get(id))
    .filter((doc): doc is AsoAppDoc => doc != null);
  const includedTopIds = new Set(topDocs.map((doc) => doc.appId));
  const remainingDocs = params.appDocs.filter(
    (doc) => !includedTopIds.has(doc.appId)
  );
  return [...topDocs, ...remainingDocs];
}

function getDocsForDifficultyCount(
  orderedAppIds: string[],
  appDocs: AsoAppDoc[]
): number {
  const topIds = orderedAppIds.slice(0, TOP_DIFFICULTY_DOC_LIMIT);
  if (topIds.length === 0) return 0;
  const docsById = new Map(appDocs.map((doc) => [doc.appId, doc] as const));
  return topIds.filter((id) => hasCompleteDifficultyDoc(docsById.get(id)))
    .length;
}

async function backfillMissingTopDifficultyDocs(params: {
  orderedAppIds: string[];
  appDocs: AsoAppDoc[];
  country: string;
  cachedTopDocs?: AsoAppDoc[];
  getAppDocs?: (appIds: string[]) => Promise<AsoAppDoc[]>;
}): Promise<AsoAppDoc[]> {
  let mergedDocs = params.appDocs;
  let missingTopIds = listIncompleteTopDifficultyDocIds({
    orderedAppIds: params.orderedAppIds,
    appDocs: mergedDocs,
  });
  if (missingTopIds.length === 0) {
    return reorderAppDocsForTopDifficultyIds({
      orderedAppIds: params.orderedAppIds,
      appDocs: mergedDocs,
    });
  }

  if (params.cachedTopDocs && params.cachedTopDocs.length > 0) {
    const cachedById = new Map(
      normalizeCountryOnAppDocs(params.country, params.cachedTopDocs).map(
        (doc) => [doc.appId, doc] as const
      )
    );
    const cachedMissingDocs = missingTopIds
      .map((id) => cachedById.get(id))
      .filter((doc): doc is AsoAppDoc => doc != null);
    mergedDocs = mergeAppDocsById(mergedDocs, cachedMissingDocs);
    missingTopIds = listIncompleteTopDifficultyDocIds({
      orderedAppIds: params.orderedAppIds,
      appDocs: mergedDocs,
    });
  }

  if (missingTopIds.length > 0 && params.getAppDocs) {
    const cachedDocs = normalizeCountryOnAppDocs(
      params.country,
      await params.getAppDocs(missingTopIds)
    );
    mergedDocs = mergeAppDocsById(mergedDocs, cachedDocs);
    missingTopIds = listIncompleteTopDifficultyDocIds({
      orderedAppIds: params.orderedAppIds,
      appDocs: mergedDocs,
    });
  }

  if (missingTopIds.length > 0) {
    const nowMs = Date.now();
    const lookupEligibleMissingTopIds = missingTopIds.filter(
      (appId) => !isIncompleteTopDocLookupOnCooldown(appId, nowMs)
    );
    if (lookupEligibleMissingTopIds.length > 0) {
      const lookedUpDocs = normalizeCountryOnAppDocs(
        params.country,
        await buildAppDocsFromLookup({
          appIds: lookupEligibleMissingTopIds,
          country: params.country,
        })
      );
      mergedDocs = mergeAppDocsById(mergedDocs, lookedUpDocs);
      missingTopIds = listIncompleteTopDifficultyDocIds({
        orderedAppIds: params.orderedAppIds,
        appDocs: mergedDocs,
      });
      const unresolvedLookups = lookupEligibleMissingTopIds.filter((appId) =>
        missingTopIds.includes(appId)
      );
      markIncompleteTopDocLookupCooldown(unresolvedLookups, nowMs);
    }
    const resolvedTopIds = params.orderedAppIds
      .slice(0, TOP_DIFFICULTY_DOC_LIMIT)
      .filter((appId) => !missingTopIds.includes(appId));
    clearIncompleteTopDocLookupCooldown(resolvedTopIds);
  }

  return reorderAppDocsForTopDifficultyIds({
    orderedAppIds: params.orderedAppIds,
    appDocs: mergedDocs,
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function enrichKeyword(
  params: {
    keyword: string;
    country: string;
    popularity: number;
  },
  options?: { getAppDocs?: (appIds: string[]) => Promise<AsoAppDoc[]> }
): Promise<{
  keyword: string;
  normalizedKeyword: string;
  popularity: number;
  difficultyScore: number;
  minDifficultyScore: number;
  isBrandKeyword: boolean;
  appCount: number;
  keywordMatch: KeywordMatchType;
  orderedAppIds: string[];
  appDocs: AsoAppDoc[];
}> {
  const country = params.country.toUpperCase();
  const normalizedKeyword = normalizeKeyword(params.keyword);
  const resolved = await resolveSearchData({
    keyword: normalizedKeyword,
    country,
  });
  if (resolved.orderedAppIds == null) {
    throw new Error(
      `Unable to resolve App Store order for keyword="${params.keyword}" country="${country}"`
    );
  }
  if (resolved.appCount == null) {
    throw new Error(
      `Unable to resolve App Store result count for keyword="${params.keyword}" country="${country}"`
    );
  }

  const orderedAppIds = resolved.orderedAppIds;
  let appDocs = resolved.appDocs;
  const appCount = resolved.appCount;
  let cachedTopDocs: AsoAppDoc[] = [];
  const usedSearchPageDocs = appDocs.length > 0;
  const sourceMode = resolved.sourceMode;
  const firstFiveIds = orderedAppIds.slice(0, TOP_DIFFICULTY_DOC_LIMIT);

  if (!usedSearchPageDocs) {
    appDocs = await buildAppDocsFromLookup({
      appIds: firstFiveIds,
      country: params.country,
    });
  }

  logger.debug("[aso-enrichment] enrich source", {
    keyword: params.keyword,
    country,
    mode: sourceMode,
    appCount,
    orderedAppIdsCount: orderedAppIds.length,
    appDocsCount: appDocs.length,
  });

  if (usedSearchPageDocs) {
    cachedTopDocs = options?.getAppDocs
      ? normalizeCountryOnAppDocs(
          country,
          await options.getAppDocs(firstFiveIds)
        )
      : [];
    const cachedByAppId = new Map(
      cachedTopDocs.map((d) => [d.appId, d] as const)
    );
    const searchDocByAppId = new Map(
      appDocs.map((doc) => [doc.appId, doc] as const)
    );
    const now = Date.now();
    const idsThatNeedLookup = firstFiveIds.filter((id) => {
      const searchDoc = searchDocByAppId.get(id);
      if (!searchDoc) return false;
      const c = cachedByAppId.get(id);
      const hasStaleOrMissingCache =
        !c || Date.parse(c.expiresAt ?? "0") <= now;
      const hasIncompleteDifficultyFields =
        c != null && (!c.releaseDate || !c.currentVersionReleaseDate);
      if (!hasStaleOrMissingCache && !hasIncompleteDifficultyFields) {
        return false;
      }
      return !isIncompleteTopDocLookupOnCooldown(id, now);
    });
    const lookupDetailsByAppId =
      idsThatNeedLookup.length > 0
        ? await lookupDetailsForAppIds({
            appIds: idsThatNeedLookup,
            country: params.country,
          })
        : new Map<
            string,
            {
              releaseDate: string | null;
              currentVersionReleaseDate: string | null;
              userRatingCount: number;
            }
          >();
    const mergedFirstFive: AsoAppDoc[] = firstFiveIds
      .map((id) => {
        const searchDoc = appDocs.find((d) => d.appId === id);
        if (!searchDoc) return null;
        const cached = cachedByAppId.get(id);
        const needLookup =
          !cached ||
          Date.parse(cached.expiresAt ?? "0") <= now ||
          !cached.releaseDate ||
          !cached.currentVersionReleaseDate;
        if (cached && !needLookup) {
          const merged = mergeSearchFieldsIntoAppDoc(cached, searchDoc);
          return { ...merged, expiresAt: cached.expiresAt };
        }
        const merged: AsoAppDoc = { ...searchDoc };
        const details = lookupDetailsByAppId.get(id);
        if (details) {
          merged.releaseDate = details.releaseDate ?? undefined;
          merged.currentVersionReleaseDate =
            details.currentVersionReleaseDate ?? undefined;
          merged.userRatingCount = parseRatingCount(details.userRatingCount);
          if (!details.releaseDate || !details.currentVersionReleaseDate) {
            logger.debug(
              "[aso-enrichment] merged lookup details missing dates",
              {
                appId: id,
                country,
                hasReleaseDate: Boolean(details.releaseDate),
                hasCurrentVersionReleaseDate: Boolean(
                  details.currentVersionReleaseDate
                ),
              }
            );
          }
        } else {
          logger.debug("[aso-enrichment] no lookup details for app", {
            appId: id,
            country,
          });
        }
        merged.expiresAt = computeAppExpiryIsoForApp();
        return merged;
      })
      .filter((d): d is AsoAppDoc => d != null);
    appDocs = mergedFirstFive.concat(
      appDocs.filter((d) => !firstFiveIds.includes(d.appId))
    );
  }

  for (const doc of appDocs) {
    if (!doc.expiresAt && firstFiveIds.includes(doc.appId)) {
      doc.expiresAt = computeAppExpiryIsoForApp();
    }
  }
  appDocs = normalizeCountryOnAppDocs(country, appDocs);
  appDocs = await hydrateMissingAdditionalLocalizations({
    appDocs,
    appIds: firstFiveIds,
    country,
  });

  let missingTopIds = listIncompleteTopDifficultyDocIds({
    orderedAppIds,
    appDocs,
  });
  let docsForDifficultyCount = getDocsForDifficultyCount(
    orderedAppIds,
    appDocs
  );

  if (requiresTopDifficultyDocs(appCount) && missingTopIds.length > 0) {
    appDocs = await backfillMissingTopDifficultyDocs({
      orderedAppIds,
      appDocs,
      country,
      cachedTopDocs,
      getAppDocs: options?.getAppDocs,
    });
    missingTopIds = listIncompleteTopDifficultyDocIds({
      orderedAppIds,
      appDocs,
    });
    docsForDifficultyCount = getDocsForDifficultyCount(orderedAppIds, appDocs);

    for (
      let attempt = 0;
      attempt < INSUFFICIENT_DOCS_RETRY_COUNT &&
      requiresTopDifficultyDocs(appCount) &&
      missingTopIds.length > 0;
      attempt += 1
    ) {
      await sleep(INSUFFICIENT_DOCS_RETRY_BACKOFF_MS);
      appDocs = await backfillMissingTopDifficultyDocs({
        orderedAppIds,
        appDocs,
        country,
        getAppDocs: options?.getAppDocs,
      });
      missingTopIds = listIncompleteTopDifficultyDocIds({
        orderedAppIds,
        appDocs,
      });
      docsForDifficultyCount = getDocsForDifficultyCount(
        orderedAppIds,
        appDocs
      );
    }
  }

  for (const doc of appDocs) {
    if (!doc.expiresAt && firstFiveIds.includes(doc.appId)) {
      doc.expiresAt = computeAppExpiryIsoForApp();
    }
  }

  const docsForDifficulty = firstFiveIds
    .map((id) => appDocs.find((d) => d.appId === id))
    .filter((d): d is AsoAppDoc => d != null);
  const keywordMatch = detectTopKeywordMatchType(
    docsForDifficulty,
    params.keyword
  );
  const isBrandKeyword = detectIsBrandKeyword(
    params.keyword,
    docsForDifficulty
  );

  if (appCount < TOP_DIFFICULTY_DOC_LIMIT) {
    logger.debug(
      "[aso-enrichment] returning fallback difficulty due to insufficient docs",
      {
        keyword: params.keyword,
        country,
        appCount,
        docsForDifficultyCount,
        requiredDocsCount: TOP_DIFFICULTY_DOC_LIMIT,
      }
    );
    logger.debug("[aso-enrichment] enrich result", {
      keyword: params.keyword,
      country,
      mode: sourceMode,
      fallbackDifficulty: true,
      appCount,
      orderedAppIdsCount: orderedAppIds.length,
      appDocsCount: appDocs.length,
      docsForDifficultyCount,
    });
    return {
      keyword: params.keyword,
      normalizedKeyword,
      popularity: params.popularity,
      difficultyScore: 1,
      minDifficultyScore: 1,
      isBrandKeyword,
      appCount,
      keywordMatch,
      orderedAppIds,
      appDocs,
    };
  }

  if (
    !hasRequiredTopDifficultyDocs({
      appCount,
      docsForDifficultyCount,
    })
  ) {
    logger.debug(
      "[aso-enrichment] insufficient top docs for difficulty scoring",
      {
        keyword: params.keyword,
        country,
        mode: sourceMode,
        appCount,
        docsForDifficultyCount,
        expectedDocsForDifficultyCount: TOP_DIFFICULTY_DOC_LIMIT,
        missingTopIds,
      }
    );
    throw new InsufficientDifficultyDocsError({
      keyword: params.keyword,
      country,
      appCount,
      docsForDifficultyCount,
      missingTopIds,
    });
  }

  const competitiveScores = docsForDifficulty.map((app) =>
    appCompetitiveScore(app, params.keyword)
  );
  const difficulty = calculateKeywordDifficultyBreakdown({
    competitiveScores,
    appCount,
  });

  logger.debug("[aso-enrichment] enrich result", {
    keyword: params.keyword,
    country,
    mode: sourceMode,
    fallbackDifficulty: false,
    appCount,
    orderedAppIdsCount: orderedAppIds.length,
    appDocsCount: appDocs.length,
    docsForDifficultyCount,
  });
  return {
    keyword: params.keyword,
    normalizedKeyword,
    popularity: params.popularity,
    difficultyScore: difficulty.difficultyScore,
    minDifficultyScore: difficulty.minDifficultyScore,
    isBrandKeyword,
    appCount,
    keywordMatch,
    orderedAppIds,
    appDocs,
  };
}
