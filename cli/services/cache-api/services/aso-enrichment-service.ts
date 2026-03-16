import { logger } from "../../../utils/logger";
import {
  computeAppExpiryIsoForApp,
  normalizeKeyword,
  normalizeTextForKeywordMatch,
} from "./aso-keyword-utils";
import { fetchAppStoreTitleAndSubtitle } from "./aso-app-store-details";
import { fetchAppStoreLookupAppDocs } from "./aso-app-doc-service";
import type { AsoAppDoc, AsoAppDocIcon } from "./aso-types";
import { asoAppleGet } from "./aso-apple-client";
import { reportAppleContractChange } from "../../keywords/apple-http-trace";
import {
  DIFFICULTY_DETAIL_LIMIT,
  type KeywordMatchType,
  calculateAppDifficultyBreakdown,
  calculateKeywordDifficultyBreakdown,
} from "./aso-difficulty";

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
const DEFAULT_APPLE_WEB_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1.1 Safari/605.1.15";
const MZSEARCH_ORDER_URL = "https://search.itunes.apple.com/WebObjects/MZSearch.woa/wa/search";
const APPSTORE_SEARCH_URL = "https://apps.apple.com/us/iphone/search";

function safeDaysSince(isoDate: string | undefined): number {
  if (!isoDate) return 365;
  const parsed = Date.parse(isoDate);
  if (Number.isNaN(parsed)) return 365;
  return Math.max(1, Math.floor((Date.now() - parsed) / (1000 * 60 * 60 * 24)));
}

function parseRatingCount(value: string | number | undefined): number {
  if (value == null) return 0;
  if (typeof value === "number" && !Number.isNaN(value)) return Math.max(0, value);
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
  if (normSubtitle && normSubtitle.includes(normKeyword)) return "subtitleExactPhrase";

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

function appCompetitiveScore(app: AsoAppDoc, keyword: string): number {
  const ratingCount = app.userRatingCount || 0;
  const avgRating = app.averageUserRating ?? 0;
  const lastRelease = app.currentVersionReleaseDate || app.releaseDate;
  const firstRelease = app.releaseDate;
  const daysSinceLastRelease = safeDaysSince(lastRelease ?? undefined);
  const daysSinceFirstRelease = safeDaysSince(firstRelease ?? undefined);
  const keywordMatch = detectKeywordMatchType(app.name, app.subtitle, keyword);

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
}): Promise<string[]> {
  const response = await asoAppleGet<MzSearchResponse>(
    MZSEARCH_ORDER_URL,
    {
      operation: "mzsearch.keyword-order",
      params: {
        clientApplication: "Software",
        term: params.keyword,
      },
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1.1 Safari/605.1.15",
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: "dslang=US-EN",
        "x-apple-store-front": getStoreFrontHeader(params.country),
      },
      timeout: 30000,
    }
  );

  const bubbles = response.data?.pageData?.bubbles;
  if (!Array.isArray(bubbles)) {
    reportAppleContractChange({
      provider: "apple-appstore",
      operation: "mzsearch.keyword-order",
      endpoint: MZSEARCH_ORDER_URL,
      statusCode: response.status,
      expectedContract: "MZSearch response has pageData.bubbles[]",
      actualSignal: `bubblesType=${typeof bubbles}`,
      context: {
        keyword: params.keyword,
        country: params.country.toUpperCase(),
      },
      isTerminal: false,
      dedupeKey: "mzsearch-keyword-order-bubbles-array",
    });
    return [];
  }

  for (const bubble of bubbles) {
    if (bubble?.name !== "software") continue;
    if (!Array.isArray(bubble.results)) {
      reportAppleContractChange({
        provider: "apple-appstore",
        operation: "mzsearch.keyword-order",
        endpoint: MZSEARCH_ORDER_URL,
        statusCode: response.status,
        expectedContract: "software bubble has results[] entries",
        actualSignal: `softwareResultsType=${typeof bubble.results}`,
        context: {
          keyword: params.keyword,
          country: params.country.toUpperCase(),
        },
        isTerminal: false,
        dedupeKey: "mzsearch-keyword-order-software-results-array",
      });
      return [];
    }
    return (bubble.results || [])
      .map((result) => `${result.id || ""}`.trim())
      .filter(Boolean);
  }

  return [];
}

function lockupToAppDoc(lockup: AmpSearchLockup, country: string): AsoAppDoc | null {
  const adamId = `${lockup?.adamId || ""}`.trim();
  if (!adamId) return null;
  const name = (lockup?.title ?? "").trim() || "Unknown";
  const subtitle = lockup?.subtitle?.trim() || undefined;
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
    averageUserRating,
    userRatingCount,
    icon,
  };
}

async function fetchSearchPageOrderedData(params: {
  keyword: string;
  country: string;
}): Promise<{
  orderedAppIds: string[];
  appDocs: AsoAppDoc[];
}> {
  const response = await asoAppleGet(APPSTORE_SEARCH_URL, {
    operation: "appstore.search-page",
    params: { term: params.keyword },
    headers: {
      "User-Agent": DEFAULT_APPLE_WEB_USER_AGENT,
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
    throw new Error("serialized-server-data script not found in search page");
  }

  const parsed = JSON.parse(serializedDataMatch[1]) as AmpSearchResponse;
  const pageData = parsed.data?.[0]?.data;
  const searchShelf = (pageData?.shelves || []).find(
    (shelf) => shelf?.contentType === "searchResult"
  );

  const appDocs: AsoAppDoc[] = [];
  const leadingOrderedIds: string[] = [];
  for (const item of searchShelf?.items || []) {
    const lockup = item?.lockup;
    if (!lockup) continue;
    const doc = lockupToAppDoc(lockup, params.country);
    if (doc) {
      leadingOrderedIds.push(doc.appId);
      appDocs.push(doc);
    }
  }

  const tailIds = (pageData?.nextPage?.results || [])
    .filter((item) => item?.type === "apps")
    .map((item) => `${item.id || ""}`.trim())
    .filter(Boolean);
  const orderedAppIds = [...new Set([...leadingOrderedIds, ...tailIds])];
  if (orderedAppIds.length === 0) {
    throw new Error("Search page serialized data did not return ordered app ids");
  }

  return { orderedAppIds, appDocs };
}

export async function refreshKeywordOrder(params: {
  keyword: string;
  country: string;
}): Promise<{
  keyword: string;
  normalizedKeyword: string;
  appCount: number;
  orderedAppIds: string[];
}> {
  const country = params.country.toUpperCase();
  const normalizedKeyword = normalizeKeyword(params.keyword);
  let orderedAppIds: string[] = [];

  try {
    const searchPageData = await fetchSearchPageOrderedData({
      keyword: normalizedKeyword,
      country,
    });
    orderedAppIds = searchPageData.orderedAppIds;
    logger.debug(
      `ASO order refresh: search page HTML succeeded for keyword="${params.keyword}" country=${params.country}`
    );
  } catch (htmlErr) {
    const htmlMessage =
      htmlErr instanceof Error ? htmlErr.message : String(htmlErr);
    reportAppleContractChange({
      provider: "apple-appstore",
      operation: "appstore.search-page",
      endpoint: APPSTORE_SEARCH_URL,
      expectedContract:
        "Search page includes serialized-server-data with ordered app ids",
      actualSignal: htmlMessage,
      context: {
        keyword: params.keyword,
        country,
      },
      error: htmlErr,
      isTerminal: false,
      dedupeKey: "appstore-search-page-fallback",
    });
    logger.debug(
      `ASO order refresh: search page HTML failed for keyword="${params.keyword}" (${htmlMessage}), falling back to MZSearch`
    );
    orderedAppIds = await fetchPopularityOrderedIds({
      keyword: normalizedKeyword,
      country,
    });
  }

  return {
    keyword: params.keyword,
    normalizedKeyword,
    appCount: orderedAppIds.length,
    orderedAppIds,
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
        logger.debug("[aso-enrichment] lookup returned app with missing dates", {
          appId: doc.appId,
          country: params.country.toUpperCase(),
          hasReleaseDate: Boolean(doc.releaseDate),
          hasCurrentVersionReleaseDate: Boolean(doc.currentVersionReleaseDate),
        });
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
        const details = await fetchAppStoreTitleAndSubtitle(
          id,
          params.country,
          "en-us"
        );
        return {
          ...lookupDoc,
          name: details?.title || lookupDoc.name || "Unknown",
          subtitle: details?.subtitle ?? undefined,
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
    averageUserRating: searchDoc.averageUserRating,
    userRatingCount: searchDoc.userRatingCount,
    icon: searchDoc.icon,
  };
}

function normalizeCountryOnAppDocs(country: string, appDocs: AsoAppDoc[]): AsoAppDoc[] {
  const normalizedCountry = country.toUpperCase();
  return appDocs.map((doc) => ({
    ...doc,
    country: normalizedCountry,
  }));
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
  appCount: number;
  keywordIncluded: number;
  orderedAppIds: string[];
  appDocs: AsoAppDoc[];
}> {
  const country = params.country.toUpperCase();
  const normalizedKeyword = normalizeKeyword(params.keyword);
  let orderedAppIds: string[] = [];
  let appDocs: AsoAppDoc[] = [];
  let usedSearchPage = false;

  try {
    const searchPageData = await fetchSearchPageOrderedData({
      keyword: normalizedKeyword,
      country,
    });
    orderedAppIds = searchPageData.orderedAppIds;
    appDocs = searchPageData.appDocs;
    usedSearchPage = true;
    logger.debug(
      `ASO enrichment: search page HTML succeeded for keyword="${params.keyword}" country=${params.country}`
    );
  } catch (htmlErr) {
    const htmlMessage =
      htmlErr instanceof Error ? htmlErr.message : String(htmlErr);
    reportAppleContractChange({
      provider: "apple-appstore",
      operation: "appstore.search-page",
      endpoint: APPSTORE_SEARCH_URL,
      expectedContract:
        "Search page includes serialized-server-data with ordered app ids and lockups",
      actualSignal: htmlMessage,
      context: {
        keyword: params.keyword,
        country,
      },
      error: htmlErr,
      isTerminal: false,
      dedupeKey: "appstore-search-page-fallback",
    });
    logger.debug(
      `ASO enrichment: search page HTML failed for keyword="${params.keyword}" (${htmlMessage}), falling back to MZSearch`
    );
    orderedAppIds = await fetchPopularityOrderedIds({
      keyword: normalizedKeyword,
      country: params.country,
    });
    const firstFiveIds = orderedAppIds.slice(0, DIFFICULTY_DETAIL_LIMIT);
    appDocs = await buildAppDocsFromLookup({
      appIds: firstFiveIds,
      country: params.country,
    });
    logger.debug(
      `ASO enrichment: using MZSearch for keyword="${params.keyword}" (app docs from lookup for first ${firstFiveIds.length})`
    );
  }

  const appCount = orderedAppIds.length;
  const firstFiveIds = orderedAppIds.slice(0, DIFFICULTY_DETAIL_LIMIT);

  if (usedSearchPage && appDocs.length > 0) {
    const cachedDocs = options?.getAppDocs
      ? normalizeCountryOnAppDocs(country, await options.getAppDocs(firstFiveIds))
      : [];
    const cachedByAppId = new Map(
      cachedDocs.map((d) => [d.appId, d] as const)
    );
    const now = Date.now();
    const idsThatNeedLookup = firstFiveIds.filter((id) => {
      const c = cachedByAppId.get(id);
      return (
        !c ||
        Date.parse(c.expiresAt ?? "0") <= now ||
        !c.releaseDate ||
        !c.currentVersionReleaseDate
      );
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
            logger.debug("[aso-enrichment] merged lookup details missing dates", {
              appId: id,
              country,
              hasReleaseDate: Boolean(details.releaseDate),
              hasCurrentVersionReleaseDate: Boolean(details.currentVersionReleaseDate),
            });
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

  const docsForDifficulty = firstFiveIds
    .map((id) => appDocs.find((d) => d.appId === id))
    .filter((d): d is AsoAppDoc => d != null);
  const keywordIncluded = docsForDifficulty.reduce((count, app) => {
    const keywordMatch = detectKeywordMatchType(app.name, app.subtitle, params.keyword);
    return count + (keywordMatch === "none" ? 0 : 1);
  }, 0);

  if (
    docsForDifficulty.length !== DIFFICULTY_DETAIL_LIMIT ||
    appCount < DIFFICULTY_DETAIL_LIMIT
  ) {
    logger.debug("[aso-enrichment] returning fallback difficulty due to insufficient docs", {
      keyword: params.keyword,
      country,
      appCount,
      docsForDifficultyCount: docsForDifficulty.length,
      requiredDocsCount: DIFFICULTY_DETAIL_LIMIT,
    });
    return {
      keyword: params.keyword,
      normalizedKeyword,
      popularity: params.popularity,
      difficultyScore: 1,
      minDifficultyScore: 1,
      appCount,
      keywordIncluded,
      orderedAppIds,
      appDocs,
    };
  }

  const competitiveScores = docsForDifficulty.map((app) =>
    appCompetitiveScore(app, params.keyword)
  );
  const difficulty = calculateKeywordDifficultyBreakdown({
    competitiveScores,
    appCount,
  });

  return {
    keyword: params.keyword,
    normalizedKeyword,
    popularity: params.popularity,
    difficultyScore: difficulty.difficultyScore,
    minDifficultyScore: difficulty.minDifficultyScore,
    appCount,
    keywordIncluded,
    orderedAppIds,
    appDocs,
  };
}
