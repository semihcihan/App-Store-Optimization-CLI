import { logger } from "../../utils/logger";
import { asoPopularityService } from "./aso-popularity-service";
import type { AsoCacheLookupResponse, AsoKeywordItem } from "./aso-types";
import {
  enrichAsoKeywordsLocal,
  lookupAsoCacheLocal,
  refreshAsoKeywordOrderLocal,
} from "./aso-local-cache-service";
import {
  computeOrderExpiryIso,
  computePopularityExpiryIso,
  normalizeKeyword,
} from "../cache-api/services/aso-keyword-utils";
import {
  getKeywords,
  upsertKeywords,
  getAssociationsForKeyword,
  setPreviousPosition,
  upsertCompetitorAppDocs,
} from "../../db";
import {
  isCompleteStoredAsoKeyword,
  isStoredKeywordOrderFresh,
  isStoredKeywordPopularityFresh,
  type CompleteStoredAsoKeyword,
} from "./aso-keyword-validity";

const MAX_KEYWORDS = 100;
export type PendingKeywordPopularityItem = {
  keyword: string;
  popularity: number;
};

export type KeywordPopularityStageResult = {
  hits: AsoKeywordItem[];
  pendingItems: PendingKeywordPopularityItem[];
  orderRefreshKeywords: string[];
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
  if (keywords.length > MAX_KEYWORDS) {
    throw new Error(
      `A maximum of ${MAX_KEYWORDS} keywords is supported per call`
    );
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

function toAsoKeywordItem(item: CompleteStoredAsoKeyword): AsoKeywordItem {
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
  const appDocs = items.flatMap((item) => item.appDocs ?? []);
  if (appDocs.length > 0) {
    upsertCompetitorAppDocs(country, appDocs);
  }
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
  if (lookupData.hits.length > 0) {
    persistKeywords(country, lookupData.hits);
  }

  if (lookupData.misses.length === 0) {
    return { hits: lookupData.hits, pendingItems: [], orderRefreshKeywords: [] };
  }

  const classified = classifyMisses(country, lookupData.misses);
  let fetchedPendingItems: PendingKeywordPopularityItem[] = [];
  if (classified.popularityFetchKeywords.length > 0) {
    logger.debug(
      `Cache misses requiring popularity fetch: ${classified.popularityFetchKeywords.length}. Fetching popularities locally...`
    );
    const popularities =
      options?.allowInteractiveAuthRecovery === false
        ? await asoPopularityService.fetchKeywordPopularities(
            classified.popularityFetchKeywords,
            { allowInteractiveAuthRecovery: false }
          )
        : await asoPopularityService.fetchKeywordPopularities(
            classified.popularityFetchKeywords
          );
    fetchedPendingItems = classified.popularityFetchKeywords.map((keyword) => ({
      keyword,
      popularity: popularities[keyword] ?? 1,
    }));
    persistPopularityOnlyKeywords(country, fetchedPendingItems);
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

  return {
    hits: lookupData.hits,
    pendingItems,
    orderRefreshKeywords: classified.orderRefreshKeywords,
  };
}

export async function enrichAndPersistKeywords(
  country: string,
  items: PendingKeywordPopularityItem[]
): Promise<AsoKeywordItem[]> {
  if (items.length === 0) {
    return [];
  }
  logger.debug("Sending popularity data to backend for enrichment...");
  const enrichedItems = (await enrichAsoKeywordsLocal(
    country,
    items
  )) as AsoKeywordItem[];
  if (enrichedItems.length > 0) {
    persistKeywords(country, enrichedItems);
  }
  return enrichedItems;
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

    const updatedOrder = await refreshAsoKeywordOrderLocal(country, keyword);
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

  return fetchAndPersistKeywords(country, keywords, {
    allowInteractiveAuthRecovery: false,
  });
}

export async function fetchAndPersistKeywords(
  country: string,
  keywords: string[],
  options?: KeywordFetchOptions
): Promise<AsoKeywordItem[]> {
  const { hits, pendingItems, orderRefreshKeywords } =
    await fetchAndPersistKeywordPopularityStage(
    country,
    keywords,
    options
  );
  const [enrichedItems, orderRefreshedItems] = await Promise.all([
    enrichAndPersistKeywords(country, pendingItems),
    refreshAndPersistKeywordOrder(country, orderRefreshKeywords),
  ]);
  return [...hits, ...orderRefreshedItems, ...enrichedItems].map(stripTimestamps);
}
