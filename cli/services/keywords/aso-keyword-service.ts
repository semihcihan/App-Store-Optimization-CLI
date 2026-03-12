import { logger } from "../../utils/logger";
import {
  asoPopularityService,
  summarizeFailedPopularityKeywords,
} from "./aso-popularity-service";
import type {
  AsoCacheLookupResponse,
  AsoKeywordItem,
  FailedKeyword,
  KeywordFetchResult,
} from "./aso-types";
import type { StoredAsoKeyword } from "../../db/types";
import {
  enrichAsoKeywordsLocal,
  lookupAsoCacheLocal,
  refreshAsoKeywordOrderLocal,
} from "./aso-local-cache-service";
import {
  computeOrderExpiryIso,
  computePopularityExpiryIso,
  normalizeKeyword,
} from "../../shared/aso-keyword-utils";
import {
  getKeywords,
  upsertKeywords,
} from "../../db/aso-keywords";
import {
  upsertKeywordFailures,
  deleteKeywordFailures,
} from "../../db/aso-keyword-failures";
import {
  getAssociationsForKeyword,
  setPreviousPosition,
} from "../../db/app-keywords";
import {
  isCompleteStoredAsoKeyword,
  isStoredKeywordOrderFresh,
  isStoredKeywordPopularityFresh,
  type CompleteStoredAsoKeyword,
} from "../../shared/aso-keyword-validity";
import {
  ASO_MAX_KEYWORDS,
  ASO_MAX_KEYWORDS_PER_CALL_ERROR,
} from "../../shared/aso-keyword-limits";
export type PendingKeywordPopularityItem = {
  keyword: string;
  popularity: number;
};

export type KeywordPopularityStageResult = {
  hits: AsoKeywordItem[];
  pendingItems: PendingKeywordPopularityItem[];
  orderRefreshKeywords: string[];
  failedKeywords: FailedKeyword[];
};

type KeywordPopularityStageOptions = {
  allowInteractiveAuthRecovery?: boolean;
};

export type KeywordFetchOptions = KeywordPopularityStageOptions;

export function normalizeKeywords(input: string[]): string[] {
  const unique = new Set<string>();
  for (const keyword of input) {
    const normalized = normalizeKeyword(keyword);
    if (normalized) {
      unique.add(normalized);
    }
  }
  return Array.from(unique);
}

export function parseKeywords(raw: string | undefined): string[] {
  if (raw == null || String(raw).trim() === "") return [];
  return normalizeKeywords(String(raw).split(","));
}

function validateKeywordCount(keywords: string[]): void {
  if (keywords.length > ASO_MAX_KEYWORDS) {
    throw new Error(ASO_MAX_KEYWORDS_PER_CALL_ERROR);
  }
}

function stripTimestamps(item: AsoKeywordItem): AsoKeywordItem {
  const { createdAt, updatedAt, ...rest } = item;
  return rest;
}

function defaultOrderExpiresAt(): string {
  return computeOrderExpiryIso();
}

function defaultPopularityExpiresAt(): string {
  return computePopularityExpiryIso();
}

function toAsoKeywordItem(
  item: CompleteStoredAsoKeyword<StoredAsoKeyword>
): AsoKeywordItem {
  return {
    keyword: item.keyword,
    normalizedKeyword: item.normalizedKeyword,
    country: item.country,
    popularity: item.popularity,
    difficultyScore: item.difficultyScore,
    minDifficultyScore: item.minDifficultyScore,
    appCount: item.appCount,
    keywordIncluded: item.keywordIncluded,
    orderedAppIds: item.orderedAppIds,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    orderExpiresAt: item.orderExpiresAt,
    popularityExpiresAt: item.popularityExpiresAt,
  };
}

function persistKeywords(country: string, items: AsoKeywordItem[]): void {
  const normalizedItems = items.map((item) => ({
    item,
    normalizedKeyword: item.normalizedKeyword ?? normalizeKeyword(item.keyword),
  }));
  const existingByNormalized = new Map(
    getKeywords(
      country,
      normalizedItems.map((entry) => entry.normalizedKeyword)
    ).map((keyword) => [keyword.normalizedKeyword, keyword] as const)
  );

  for (const entry of normalizedItems) {
    const associations = getAssociationsForKeyword(entry.item.keyword, country);
    const existing = existingByNormalized.get(entry.normalizedKeyword);
    const orderedIds = existing?.orderedAppIds ?? [];
    for (const assoc of associations) {
      const idx = orderedIds.indexOf(assoc.appId);
      const position = idx >= 0 ? idx + 1 : 0;
      if (position > 0) {
        setPreviousPosition(entry.item.keyword, country, assoc.appId, position);
      }
    }
  }

  upsertKeywords(
    country,
    normalizedItems.map((entry) => ({
      keyword: entry.item.keyword,
      normalizedKeyword: entry.normalizedKeyword,
      popularity: entry.item.popularity,
      difficultyScore: entry.item.difficultyScore,
      minDifficultyScore: entry.item.minDifficultyScore,
      appCount: entry.item.appCount,
      keywordIncluded: entry.item.keywordIncluded,
      orderedAppIds: entry.item.orderedAppIds,
      createdAt: entry.item.createdAt,
      updatedAt: entry.item.updatedAt,
      orderExpiresAt: entry.item.orderExpiresAt ?? defaultOrderExpiresAt(),
      popularityExpiresAt:
        entry.item.popularityExpiresAt ??
        existingByNormalized.get(entry.normalizedKeyword)?.popularityExpiresAt ??
        defaultPopularityExpiresAt(),
    }))
  );
}

function persistPopularityOnlyKeywords(
  country: string,
  items: PendingKeywordPopularityItem[]
): void {
  upsertKeywords(
    country,
    items.map((item) => ({
      keyword: item.keyword,
      normalizedKeyword: normalizeKeyword(item.keyword),
      popularity: item.popularity,
      difficultyScore: null,
      minDifficultyScore: null,
      appCount: null,
      keywordIncluded: null,
      orderedAppIds: [],
      orderExpiresAt: defaultOrderExpiresAt(),
      popularityExpiresAt: defaultPopularityExpiresAt(),
    }))
  );
}

function persistFailedKeywords(country: string, failures: FailedKeyword[]): void {
  if (failures.length === 0) return;
  upsertKeywordFailures(
    country,
    failures.map((failure) => ({
      keyword: failure.keyword,
      stage: failure.stage,
      reasonCode: failure.reasonCode,
      message: failure.message,
      statusCode: failure.statusCode,
      retryable: failure.retryable,
      attempts: failure.attempts,
      requestId: failure.requestId,
    }))
  );
}

function clearFailedKeywords(country: string, keywords: string[]): void {
  if (keywords.length === 0) return;
  deleteKeywordFailures(country, keywords);
}

function summarizeFailedKeywords(failures: FailedKeyword[]): string {
  if (failures.length === 0) return "none";
  const preview = failures
    .slice(0, 5)
    .map((failure) => {
      const statusSuffix =
        failure.statusCode != null ? `(${failure.statusCode})` : "";
      return `${failure.keyword}:${failure.reasonCode}${statusSuffix}`;
    })
    .join(", ");
  return failures.length > 5
    ? `${preview} (+${failures.length - 5} more)`
    : preview;
}

type MissClassification = {
  pendingItems: PendingKeywordPopularityItem[];
  popularityFetchKeywords: string[];
  orderRefreshKeywords: string[];
};

function classifyMisses(
  country: string,
  misses: string[]
): MissClassification {
  const pendingItems: PendingKeywordPopularityItem[] = [];
  const popularityFetchKeywords: string[] = [];
  const orderRefreshKeywords: string[] = [];
  const nowMs = Date.now();
  const existingByNormalized = new Map(
    getKeywords(country, misses).map((keyword) => [
      keyword.normalizedKeyword,
      keyword,
    ])
  );

  for (const keyword of misses) {
    const existing = existingByNormalized.get(keyword);
    if (!existing || !Number.isFinite(existing.popularity)) {
      popularityFetchKeywords.push(keyword);
      continue;
    }
    const popularityFresh = isStoredKeywordPopularityFresh(existing, nowMs);
    if (!popularityFresh) {
      popularityFetchKeywords.push(keyword);
      continue;
    }
    if (!isCompleteStoredAsoKeyword(existing)) {
      pendingItems.push({ keyword, popularity: existing.popularity });
      continue;
    }
    if (!isStoredKeywordOrderFresh(existing, nowMs)) {
      orderRefreshKeywords.push(keyword);
      continue;
    }
    pendingItems.push({ keyword, popularity: existing.popularity });
  }

  return { pendingItems, popularityFetchKeywords, orderRefreshKeywords };
}

export async function fetchAndPersistKeywordPopularityStage(
  country: string,
  keywords: string[],
  options?: KeywordPopularityStageOptions
): Promise<KeywordPopularityStageResult> {
  validateKeywordCount(keywords);

  logger.debug(`Checking backend cache for ${keywords.length} keywords...`);
  const lookupData = (await lookupAsoCacheLocal(
    country,
    keywords
  )) as AsoCacheLookupResponse;

  if (lookupData.misses.length === 0) {
    return {
      hits: lookupData.hits,
      pendingItems: [],
      orderRefreshKeywords: [],
      failedKeywords: [],
    };
  }

  const classified = classifyMisses(country, lookupData.misses);
  const failedKeywords: FailedKeyword[] = [];
  let fetchedPendingItems: PendingKeywordPopularityItem[] = [];
  if (classified.popularityFetchKeywords.length > 0) {
    logger.debug(
      `Cache misses requiring popularity fetch: ${classified.popularityFetchKeywords.length}. Fetching popularities locally...`
    );
    const popularityResult =
      options?.allowInteractiveAuthRecovery === false
        ? await asoPopularityService.fetchKeywordPopularitiesWithFailures(
            classified.popularityFetchKeywords,
            { allowInteractiveAuthRecovery: false }
          )
        : await asoPopularityService.fetchKeywordPopularitiesWithFailures(
            classified.popularityFetchKeywords
          );
    fetchedPendingItems = classified.popularityFetchKeywords
      .filter((keyword) => popularityResult.popularities[keyword] != null)
      .map((keyword) => ({
      keyword,
      popularity: popularityResult.popularities[keyword] ?? 1,
    }));
    failedKeywords.push(...popularityResult.failedKeywords);
    if (fetchedPendingItems.length > 0) {
      persistPopularityOnlyKeywords(country, fetchedPendingItems);
    }
    const popularityFailureSummary = summarizeFailedPopularityKeywords(
      popularityResult.failedKeywords
    );
    if (popularityFailureSummary) {
      logger.debug(
        `[aso-keyword-service] popularity failures=${popularityResult.failedKeywords.length} details=${popularityFailureSummary}`
      );
    }
  }

  const reusedByKeyword = new Map(
    classified.pendingItems.map((item) => [item.keyword, item] as const)
  );
  const fetchedByKeyword = new Map(
    fetchedPendingItems.map((item) => [item.keyword, item] as const)
  );
  const pendingItems = lookupData.misses
    .map((keyword) => reusedByKeyword.get(keyword) ?? fetchedByKeyword.get(keyword))
    .filter((item): item is PendingKeywordPopularityItem => item != null);

  persistFailedKeywords(country, failedKeywords);

  return {
    hits: lookupData.hits,
    pendingItems,
    orderRefreshKeywords: classified.orderRefreshKeywords,
    failedKeywords,
  };
}

export async function enrichAndPersistKeywords(
  country: string,
  items: PendingKeywordPopularityItem[]
): Promise<{ items: AsoKeywordItem[]; failedKeywords: FailedKeyword[] }> {
  if (items.length === 0) {
    return {
      items: [],
      failedKeywords: [],
    };
  }
  logger.debug("Sending popularity data to backend for enrichment...");
  const enrichedResult = await enrichAsoKeywordsLocal(
    country,
    items
  );
  persistFailedKeywords(country, enrichedResult.failedKeywords);
  clearFailedKeywords(
    country,
    enrichedResult.items.map((item) => item.keyword)
  );
  return enrichedResult;
}

export async function refreshAndPersistKeywordOrder(
  country: string,
  keywords: string[]
): Promise<AsoKeywordItem[]> {
  if (keywords.length === 0) return [];
  const normalized = normalizeKeywords(keywords);
  const existingByNormalized = new Map(
    getKeywords(country, normalized).map((keyword) => [
      keyword.normalizedKeyword,
      keyword,
    ])
  );
  const refreshed: AsoKeywordItem[] = [];

  for (const keyword of normalized) {
    const existing = existingByNormalized.get(keyword);
    if (!isCompleteStoredAsoKeyword(existing)) continue;

    let updatedOrder:
      | {
          keyword: string;
          normalizedKeyword: string;
          appCount: number;
          orderedAppIds: string[];
        }
      | null = null;
    try {
      updatedOrder = await refreshAsoKeywordOrderLocal(country, keyword);
    } catch (error) {
      logger.debug(
        `[aso-keyword-service] order refresh skipped keyword=${keyword} reason=${String(error)}`
      );
      continue;
    }
    if (!updatedOrder) continue;
    const orderExpiresAt = defaultOrderExpiresAt();
    const updatedAt = new Date().toISOString();
    const refreshedItem: AsoKeywordItem = {
      keyword: existing.keyword,
      normalizedKeyword: existing.normalizedKeyword,
      country: existing.country,
      popularity: existing.popularity,
      difficultyScore: existing.difficultyScore,
      minDifficultyScore: existing.minDifficultyScore,
      appCount: updatedOrder.appCount,
      keywordIncluded: existing.keywordIncluded,
      orderedAppIds: updatedOrder.orderedAppIds,
      createdAt: existing.createdAt,
      updatedAt,
      orderExpiresAt,
      popularityExpiresAt: existing.popularityExpiresAt,
    };
    refreshed.push(refreshedItem);
  }

  if (refreshed.length > 0) {
    persistKeywords(country, refreshed);
  }

  return refreshed;
}

export async function refreshKeywordsForStartup(
  country: string,
  items: PendingKeywordPopularityItem[]
): Promise<AsoKeywordItem[]> {
  if (items.length === 0) return [];
  const seen = new Set<string>();
  const keywords: string[] = [];

  for (const item of items) {
    const normalizedKeyword = normalizeKeyword(item.keyword);
    if (!normalizedKeyword || seen.has(normalizedKeyword)) continue;
    seen.add(normalizedKeyword);
    keywords.push(normalizedKeyword);
  }

  const result = await fetchAndPersistKeywords(country, keywords, {
    allowInteractiveAuthRecovery: false,
  });
  return result.items;
}

export async function fetchAndPersistKeywords(
  country: string,
  keywords: string[],
  options?: KeywordFetchOptions
): Promise<KeywordFetchResult> {
  const { hits, pendingItems, orderRefreshKeywords, failedKeywords: popularityFailures } =
    await fetchAndPersistKeywordPopularityStage(
    country,
    keywords,
    options
  );
  const [enrichedResult, orderRefreshedItems] = await Promise.all([
    enrichAndPersistKeywords(country, pendingItems),
    refreshAndPersistKeywordOrder(country, orderRefreshKeywords),
  ]);
  const items = [...hits, ...orderRefreshedItems, ...enrichedResult.items].map(
    stripTimestamps
  );
  const failedKeywords = [...popularityFailures, ...enrichedResult.failedKeywords];
  persistFailedKeywords(country, failedKeywords);
  clearFailedKeywords(
    country,
    items.map((item) => item.keyword)
  );
  if (failedKeywords.length > 0) {
    logger.debug(
      `[aso-keyword-service] failed keywords count=${failedKeywords.length} details=${summarizeFailedKeywords(
        failedKeywords
      )}`
    );
  }
  if (items.length === 0 && failedKeywords.length > 0) {
    throw new Error(
      `All keywords failed (${failedKeywords.length}): ${summarizeFailedKeywords(
        failedKeywords
      )}`
    );
  }
  return {
    items,
    failedKeywords,
  };
}
