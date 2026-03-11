import { logger } from "../../utils/logger";
import { asoPopularityService } from "./aso-popularity-service";
import type { AsoCacheLookupResponse, AsoKeywordItem } from "./aso-types";
import {
  enrichAsoKeywordsLocal,
  lookupAsoCacheLocal,
} from "./aso-local-cache-service";
import {
  getKeyword,
  upsertKeywords,
  getAssociationsForKeyword,
  setPreviousPosition,
  upsertCompetitorAppDocs,
} from "../../db";

const MAX_KEYWORDS = 100;
export type PendingKeywordPopularityItem = {
  keyword: string;
  popularity: number;
};

export type KeywordPopularityStageResult = {
  hits: AsoKeywordItem[];
  pendingItems: PendingKeywordPopularityItem[];
};

type KeywordPopularityStageOptions = {
  allowInteractiveAuthRecovery?: boolean;
};

export type KeywordFetchOptions = KeywordPopularityStageOptions;

export function normalizeKeywords(input: string[]): string[] {
  const unique = new Set<string>();
  for (const keyword of input) {
    const normalized = keyword.trim().toLowerCase();
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

function defaultExpiresAt(): string {
  const d = new Date();
  d.setHours(d.getHours() + 24);
  return d.toISOString();
}

function persistKeywords(country: string, items: AsoKeywordItem[]): void {
  for (const item of items) {
    const associations = getAssociationsForKeyword(item.keyword, country);
    const existing = getKeyword(country, item.keyword);
    const orderedIds = existing?.orderedAppIds ?? [];
    for (const assoc of associations) {
      const idx = orderedIds.indexOf(assoc.appId);
      const position = idx >= 0 ? idx + 1 : 0;
      if (position > 0) {
        setPreviousPosition(item.keyword, country, assoc.appId, position);
      }
    }
  }
  upsertKeywords(
    country,
    items.map((item) => ({
      keyword: item.keyword,
      normalizedKeyword:
        item.normalizedKeyword ?? item.keyword.trim().toLowerCase(),
      popularity: item.popularity,
      difficultyScore: item.difficultyScore,
      minDifficultyScore: item.minDifficultyScore,
      appCount: item.appCount,
      keywordIncluded: item.keywordIncluded,
      orderedAppIds: item.orderedAppIds,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      expiresAt: item.expiresAt ?? defaultExpiresAt(),
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
      normalizedKeyword: item.keyword.trim().toLowerCase(),
      popularity: item.popularity,
      difficultyScore: null,
      minDifficultyScore: null,
      appCount: null,
      keywordIncluded: null,
      orderedAppIds: [],
      expiresAt: defaultExpiresAt(),
    }))
  );
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
    return { hits: lookupData.hits, pendingItems: [] };
  }

  logger.debug(
    `Cache misses: ${lookupData.misses.length}. Fetching popularities locally...`
  );
  const popularities =
    options?.allowInteractiveAuthRecovery === false
      ? await asoPopularityService.fetchKeywordPopularities(
          lookupData.misses,
          { allowInteractiveAuthRecovery: false }
        )
      : await asoPopularityService.fetchKeywordPopularities(lookupData.misses);
  const pendingItems = lookupData.misses.map((keyword) => ({
    keyword,
    popularity: popularities[keyword] ?? 1,
  }));
  persistPopularityOnlyKeywords(country, pendingItems);

  return {
    hits: lookupData.hits,
    pendingItems,
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

export async function fetchAndPersistKeywords(
  country: string,
  keywords: string[],
  options?: KeywordFetchOptions
): Promise<AsoKeywordItem[]> {
  const { hits, pendingItems } = await fetchAndPersistKeywordPopularityStage(
    country,
    keywords,
    options
  );
  const enrichedItems = await enrichAndPersistKeywords(country, pendingItems);
  return [...hits, ...enrichedItems].map(stripTimestamps);
}
