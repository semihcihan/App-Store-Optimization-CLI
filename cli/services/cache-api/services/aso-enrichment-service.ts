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

const MAX_COMPETING_APPS = 200;
const MAX_RATINGS = 10000;
const AGE_NORMALIZATION_DAYS = 365;
const RATING_PER_DAY_MAX = 100;
const RATING_PER_DAY_MAP_THRESHOLD = 0.25;
const RATING_PER_DAY_THRESHOLD = 1;
const LOW_RATING_COUNT_THRESHOLD = 10;
const MIN_RATING_FOR_POSITIVE_SCORE = 3;
const MZSEARCH_PLATFORM_ID_JSON = 29;
const STORE_FRONT_ID_BY_COUNTRY: Record<string, number> = {
  US: 143441,
};
const DEFAULT_APPLE_WEB_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1.1 Safari/605.1.15";
const DIFFICULTY_DETAIL_LIMIT = 5;
const DIFFICULTY_AVG_WEIGHT = 1;
const DIFFICULTY_MIN_WEIGHT = 2;
const DIFFICULTY_APP_COUNT_WEIGHT = 1;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

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

function normalizeRatingCountPerDay(ratingPerDay: number): number {
  if (ratingPerDay <= 0) return 0;
  if (ratingPerDay <= RATING_PER_DAY_THRESHOLD)
    return ratingPerDay * RATING_PER_DAY_MAP_THRESHOLD;
  if (ratingPerDay < RATING_PER_DAY_MAX) {
    const t =
      (ratingPerDay - RATING_PER_DAY_THRESHOLD) /
      (RATING_PER_DAY_MAX - RATING_PER_DAY_THRESHOLD);
    return (
      RATING_PER_DAY_MAP_THRESHOLD + (1 - RATING_PER_DAY_MAP_THRESHOLD) * t * t
    );
  }
  return 1;
}

function normalizeAvgRating(avgRating: number, ratingCount: number): number {
  if (avgRating <= MIN_RATING_FOR_POSITIVE_SCORE) return 0;
  let normalized =
    (avgRating - MIN_RATING_FOR_POSITIVE_SCORE) /
    (5 - MIN_RATING_FOR_POSITIVE_SCORE);
  normalized = clamp(normalized, 0, 1);
  normalized =
    (normalized * Math.min(ratingCount, LOW_RATING_COUNT_THRESHOLD)) /
    LOW_RATING_COUNT_THRESHOLD;
  return normalized;
}

function checkKeywordPresence(
  name: string,
  subtitle: string | undefined,
  keyword: string
): number {
  const normKeyword = normalizeTextForKeywordMatch(keyword);
  const keywordParts = new Set(normKeyword.split(" ").filter(Boolean));
  const normTitle = normalizeTextForKeywordMatch(name);

  if (normTitle.includes(normKeyword)) return 1;

  const titleWords = new Set(normTitle.split(" ").filter(Boolean));
  if (
    keywordParts.size > 0 &&
    [...keywordParts].every((w) => titleWords.has(w))
  )
    return 0.7;

  const normSubtitle = normalizeTextForKeywordMatch(subtitle || "");
  if (normSubtitle && normSubtitle.includes(normKeyword)) return 0.7;

  const combined = `${normTitle} ${normSubtitle}`.trim();
  if (combined.includes(normKeyword)) return 0.5;

  const subtitleWords = new Set(normSubtitle.split(" ").filter(Boolean));
  if (
    keywordParts.size > 0 &&
    subtitleWords.size > 0 &&
    [...keywordParts].every((w) => subtitleWords.has(w))
  ) {
    return 0.4;
  }

  return 0;
}

function appCompetitiveScore(app: AsoAppDoc, keyword: string): number {
  const ratingCount = app.userRatingCount || 0;
  const avgRating = app.averageUserRating ?? 0;
  const lastRelease = app.currentVersionReleaseDate || app.releaseDate;
  const firstRelease = app.releaseDate;
  const daysSinceLastRelease = safeDaysSince(lastRelease ?? undefined);
  const daysSinceFirstRelease = safeDaysSince(firstRelease ?? undefined);

  const normalizedAge =
    1 - clamp(daysSinceLastRelease / AGE_NORMALIZATION_DAYS, 0, 1);
  const ratingPerDay = ratingCount / Math.max(daysSinceFirstRelease, 1);
  const normalizedRatingPerDay = normalizeRatingCountPerDay(ratingPerDay);
  const normalizedRatingCount = clamp(ratingCount / MAX_RATINGS, 0, 1);
  const normalizedAvgRating = normalizeAvgRating(avgRating, ratingCount);
  const keywordScore = checkKeywordPresence(
    app.name,
    app.subtitle,
    keyword
  );

  const score =
    0.2 * normalizedRatingCount +
    0.2 * normalizedAvgRating +
    0.1 * normalizedAge +
    0.3 * keywordScore +
    0.2 * normalizedRatingPerDay;
  return Math.max(0, score);
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
    "https://search.itunes.apple.com/WebObjects/MZSearch.woa/wa/search",
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

  const bubbles = response.data?.pageData?.bubbles || [];
  for (const bubble of bubbles) {
    if (bubble?.name !== "software") continue;
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
  const response = await asoAppleGet(
    "https://apps.apple.com/us/iphone/search",
    {
      operation: "appstore.search-page",
      params: { term: params.keyword },
      headers: {
        "User-Agent": DEFAULT_APPLE_WEB_USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 30000,
    }
  );

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
    }
  } catch {
    // leave missing
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
    logger.info(
      `ASO enrichment: search page HTML succeeded for keyword="${params.keyword}" country=${params.country}`
    );
  } catch (htmlErr) {
    const htmlMessage =
      htmlErr instanceof Error ? htmlErr.message : String(htmlErr);
    logger.info(
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
    logger.info(
      `ASO enrichment: using MZSearch for keyword="${params.keyword}" (app docs from lookup for first ${firstFiveIds.length})`
    );
  }

  const appCount = orderedAppIds.length;

  if (usedSearchPage && appDocs.length > 0) {
    const firstFiveIds = orderedAppIds.slice(0, DIFFICULTY_DETAIL_LIMIT);
    const cachedDocs = options?.getAppDocs
      ? normalizeCountryOnAppDocs(country, await options.getAppDocs(firstFiveIds))
      : [];
    const cachedByAppId = new Map(
      cachedDocs.map((d) => [d.appId, d] as const)
    );
    const now = Date.now();
    const idsThatNeedLookup = firstFiveIds.filter((id) => {
      const c = cachedByAppId.get(id);
      return !c || Date.parse(c.expiresAt ?? "0") <= now;
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
        const needLookup = !cached || Date.parse(cached.expiresAt ?? "0") <= now;
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
    if (!doc.expiresAt) doc.expiresAt = computeAppExpiryIsoForApp();
  }
  appDocs = normalizeCountryOnAppDocs(country, appDocs);

  const firstFiveIds = orderedAppIds.slice(0, DIFFICULTY_DETAIL_LIMIT);
  const docsForDifficulty = firstFiveIds
    .map((id) => appDocs.find((d) => d.appId === id))
    .filter((d): d is AsoAppDoc => d != null);
  const keywordIncluded = docsForDifficulty.reduce((count, app) => {
    const score = checkKeywordPresence(app.name, app.subtitle, params.keyword);
    return count + (score > 0 ? 1 : 0);
  }, 0);

  if (
    docsForDifficulty.length !== DIFFICULTY_DETAIL_LIMIT ||
    appCount < DIFFICULTY_DETAIL_LIMIT
  ) {
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
  const avgCompetitive =
    competitiveScores.reduce((a, b) => a + b, 0) / competitiveScores.length;
  const minCompetitive = Math.min(...competitiveScores);
  const normalizedAppCount = Math.min(appCount / MAX_COMPETING_APPS, 1);
  const weightSum =
    DIFFICULTY_AVG_WEIGHT +
    DIFFICULTY_MIN_WEIGHT +
    DIFFICULTY_APP_COUNT_WEIGHT;
  const rawDifficulty =
    (DIFFICULTY_APP_COUNT_WEIGHT * normalizedAppCount +
      DIFFICULTY_AVG_WEIGHT * avgCompetitive +
      DIFFICULTY_MIN_WEIGHT * minCompetitive) /
    weightSum;
  const difficultyScore = Math.max(
    1,
    Math.min(100, rawDifficulty * 100)
  );
  const minDifficultyScore = minCompetitive * 100;

  return {
    keyword: params.keyword,
    normalizedKeyword,
    popularity: params.popularity,
    difficultyScore,
    minDifficultyScore,
    appCount,
    keywordIncluded,
    orderedAppIds,
    appDocs,
  };
}
