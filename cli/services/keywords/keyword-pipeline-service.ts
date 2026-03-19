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
import { normalizeKeyword } from "../../shared/aso-keyword-utils";
import { getKeywords } from "../../db/aso-keywords";
import { listKeywordFailuresForApp } from "../../db/aso-keyword-failures";
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
import { normalizeAppleUpstreamError } from "../../shared/apple-upstream-error";
import { getAsoResilienceConfig } from "../../shared/aso-resilience";
import { keywordWriteRepository } from "./keyword-write-repository";

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

type EnrichmentOutcome = {
  item: AsoKeywordItem | null;
  failedKeyword: FailedKeyword | null;
};

function validateKeywordCount(keywords: string[]): void {
  if (keywords.length > ASO_MAX_KEYWORDS) {
    throw new Error(ASO_MAX_KEYWORDS_PER_CALL_ERROR);
  }
}

function stripTimestamps(item: AsoKeywordItem): AsoKeywordItem {
  const { createdAt, updatedAt, ...rest } = item;
  return rest;
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

function toEnrichmentFailureFromError(
  keyword: string,
  error: unknown
): FailedKeyword {
  const normalized = normalizeAppleUpstreamError({
    error,
    operation: "keyword-enrichment",
    defaultReasonCode: "ENRICHMENT_FAILED",
  });
  return {
    keyword,
    stage: "enrichment",
    reasonCode: normalized.reasonCode,
    message: normalized.message,
    statusCode: normalized.statusCode,
    retryable: normalized.retryable,
    attempts: normalized.attempts,
    requestId: normalized.requestId,
  };
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
    keywordMatch: item.keywordMatch,
    orderedAppIds: item.orderedAppIds,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    orderExpiresAt: item.orderExpiresAt,
    popularityExpiresAt: item.popularityExpiresAt,
  };
}

export class KeywordPipelineService {
  normalizeKeywords(input: string[]): string[] {
    const unique = new Set<string>();
    for (const keyword of input) {
      const normalized = normalizeKeyword(keyword);
      if (normalized) {
        unique.add(normalized);
      }
    }
    return Array.from(unique);
  }

  parseKeywords(raw: string | undefined): string[] {
    if (raw == null || String(raw).trim() === "") return [];
    return this.normalizeKeywords(String(raw).split(","));
  }

  private createEmptyEnrichmentResult(): {
    items: AsoKeywordItem[];
    failedKeywords: FailedKeyword[];
  } {
    return {
      items: [],
      failedKeywords: [],
    };
  }

  private getEnrichmentWorkerCount(itemCount: number): number {
    if (itemCount <= 0) return 0;
    const configuredConcurrency = Math.max(
      1,
      Math.floor(getAsoResilienceConfig().keywordEnrichmentConcurrency)
    );
    return Math.min(configuredConcurrency, itemCount);
  }

  private findMatchedEnrichedItem(
    keyword: string,
    items: AsoKeywordItem[]
  ): AsoKeywordItem | null {
    if (items.length === 0) return null;
    const normalizedKeyword = normalizeKeyword(keyword);
    return (
      items.find((item) => normalizeKeyword(item.keyword) === normalizedKeyword) ??
      items[0] ??
      null
    );
  }

  private findMatchedFailedKeyword(
    keyword: string,
    failures: FailedKeyword[]
  ): FailedKeyword | null {
    if (failures.length === 0) return null;
    const normalizedKeyword = normalizeKeyword(keyword);
    return (
      failures.find(
        (failure) => normalizeKeyword(failure.keyword) === normalizedKeyword
      ) ??
      failures[0] ??
      null
    );
  }

  private createMissingEnrichmentOutcome(keyword: string): EnrichmentOutcome {
    return {
      item: null,
      failedKeyword: toEnrichmentFailureFromError(
        keyword,
        new Error(
          `Keyword enrichment returned no item/failure for keyword "${keyword}".`
        )
      ),
    };
  }

  private persistEnrichmentOutcome(
    country: string,
    outcome: EnrichmentOutcome
  ): void {
    if (outcome.item) {
      keywordWriteRepository.clearFailures(country, [outcome.item.keyword]);
      return;
    }
    if (outcome.failedKeyword) {
      keywordWriteRepository.persistFailures(country, [outcome.failedKeyword]);
    }
  }

  private async enrichSinglePendingKeyword(
    country: string,
    pendingItem: PendingKeywordPopularityItem
  ): Promise<EnrichmentOutcome> {
    try {
      const singleResult = await enrichAsoKeywordsLocal(country, [pendingItem]);
      const matchedItem = this.findMatchedEnrichedItem(
        pendingItem.keyword,
        singleResult.items
      );
      if (matchedItem) {
        return {
          item: matchedItem,
          failedKeyword: null,
        };
      }

      const matchedFailure = this.findMatchedFailedKeyword(
        pendingItem.keyword,
        singleResult.failedKeywords
      );
      if (matchedFailure) {
        return {
          item: null,
          failedKeyword: matchedFailure,
        };
      }

      return this.createMissingEnrichmentOutcome(pendingItem.keyword);
    } catch (error) {
      return {
        item: null,
        failedKeyword: toEnrichmentFailureFromError(pendingItem.keyword, error),
      };
    }
  }

  private async populateEnrichmentOutcomes(
    country: string,
    items: PendingKeywordPopularityItem[],
    outcomes: EnrichmentOutcome[]
  ): Promise<void> {
    const workerCount = this.getEnrichmentWorkerCount(items.length);
    let cursor = 0;

    const runWorker = async (): Promise<void> => {
      while (cursor < items.length) {
        const currentIndex = cursor;
        cursor += 1;
        const outcome = await this.enrichSinglePendingKeyword(
          country,
          items[currentIndex]
        );
        this.persistEnrichmentOutcome(country, outcome);
        outcomes[currentIndex] = outcome;
      }
    };

    await Promise.all(
      Array.from({ length: workerCount }, () => runWorker())
    );
  }

  private buildEnrichmentResult(
    outcomes: EnrichmentOutcome[]
  ): { items: AsoKeywordItem[]; failedKeywords: FailedKeyword[] } {
    return {
      items: outcomes.flatMap((outcome) => (outcome?.item ? [outcome.item] : [])),
      failedKeywords: outcomes.flatMap((outcome) =>
        outcome?.failedKeyword ? [outcome.failedKeyword] : []
      ),
    };
  }

  async runPopularityStage(
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
        keywordWriteRepository.upsertPopularityOnly(country, fetchedPendingItems);
      }
      const popularityFailureSummary = summarizeFailedPopularityKeywords(
        popularityResult.failedKeywords
      );
      if (popularityFailureSummary) {
        logger.debug(
          `[keyword-pipeline] popularity failures=${popularityResult.failedKeywords.length} details=${popularityFailureSummary}`
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
      .map(
        (keyword) => reusedByKeyword.get(keyword) ?? fetchedByKeyword.get(keyword)
      )
      .filter((item): item is PendingKeywordPopularityItem => item != null);

    keywordWriteRepository.persistFailures(country, failedKeywords);

    return {
      hits: lookupData.hits,
      pendingItems,
      orderRefreshKeywords: classified.orderRefreshKeywords,
      failedKeywords,
    };
  }

  async enrichAndPersist(
    country: string,
    items: PendingKeywordPopularityItem[]
  ): Promise<{ items: AsoKeywordItem[]; failedKeywords: FailedKeyword[] }> {
    if (items.length === 0) {
      return this.createEmptyEnrichmentResult();
    }
    logger.debug("Sending popularity data to backend for enrichment...");
    const outcomes: EnrichmentOutcome[] = new Array(items.length);
    await this.populateEnrichmentOutcomes(country, items, outcomes);
    return this.buildEnrichmentResult(outcomes);
  }

  persistBackgroundEnrichmentCrashFailures(
    country: string,
    items: PendingKeywordPopularityItem[],
    error: unknown
  ): void {
    if (items.length === 0) return;

    const normalizedError = normalizeAppleUpstreamError({
      error,
      operation: "keyword-enrichment",
      defaultReasonCode: "ENRICHMENT_FAILED",
    });
    const normalizedPendingKeywords = this.normalizeKeywords(
      items.map((item) => item.keyword)
    );
    if (normalizedPendingKeywords.length === 0) return;

    const existingByKeyword = new Map(
      getKeywords(country, normalizedPendingKeywords).map((keyword) => [
        keyword.normalizedKeyword,
        keyword,
      ])
    );
    const unresolvedPendingKeywords = normalizedPendingKeywords.filter(
      (keyword) => !isCompleteStoredAsoKeyword(existingByKeyword.get(keyword))
    );
    if (unresolvedPendingKeywords.length === 0) return;

    keywordWriteRepository.persistFailures(
      country,
      unresolvedPendingKeywords.map((keyword) => ({
        keyword,
        stage: "enrichment",
        reasonCode: normalizedError.reasonCode,
        message: normalizedError.message,
        statusCode: normalizedError.statusCode,
        retryable: normalizedError.retryable,
        attempts: normalizedError.attempts,
        requestId: normalizedError.requestId,
      }))
    );
  }

  async refreshOrder(
    country: string,
    keywords: string[]
  ): Promise<AsoKeywordItem[]> {
    if (keywords.length === 0) return [];
    const normalized = this.normalizeKeywords(keywords);
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
          `[keyword-pipeline] order refresh skipped keyword=${keyword} reason=${String(error)}`
        );
        continue;
      }
      if (!updatedOrder) continue;
      const updatedAt = new Date().toISOString();
      const refreshedItem: AsoKeywordItem = {
        keyword: existing.keyword,
        normalizedKeyword: existing.normalizedKeyword,
        country: existing.country,
        popularity: existing.popularity,
        difficultyScore: existing.difficultyScore,
        minDifficultyScore: existing.minDifficultyScore,
        appCount: updatedOrder.appCount,
        keywordMatch: existing.keywordMatch,
        orderedAppIds: updatedOrder.orderedAppIds,
        createdAt: existing.createdAt,
        updatedAt,
        orderExpiresAt: existing.orderExpiresAt,
        popularityExpiresAt: existing.popularityExpiresAt,
      };
      refreshed.push(refreshedItem);
    }

    if (refreshed.length > 0) {
      keywordWriteRepository.upsertKeywordItems(
        country,
        refreshed.map((item) => ({
          keyword: item.keyword,
          normalizedKeyword: item.normalizedKeyword,
          popularity: item.popularity,
          difficultyScore: item.difficultyScore,
          minDifficultyScore: item.minDifficultyScore,
          appCount: item.appCount,
          keywordMatch: item.keywordMatch,
          orderedAppIds: item.orderedAppIds,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          popularityExpiresAt: item.popularityExpiresAt,
        }))
      );
    }

    return refreshed;
  }

  async refreshStartup(
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

    const result = await this.run(country, keywords, {
      allowInteractiveAuthRecovery: false,
    });
    return result.items;
  }

  async run(
    country: string,
    keywords: string[],
    options?: KeywordFetchOptions
  ): Promise<KeywordFetchResult> {
    const {
      hits,
      pendingItems,
      orderRefreshKeywords,
      failedKeywords: popularityFailures,
    } = await this.runPopularityStage(country, keywords, options);
    const [enrichedResult, orderRefreshedItems] = await Promise.all([
      this.enrichAndPersist(country, pendingItems),
      this.refreshOrder(country, orderRefreshKeywords),
    ]);
    const items = [...hits, ...orderRefreshedItems, ...enrichedResult.items].map(
      stripTimestamps
    );
    const failedKeywords = [...popularityFailures, ...enrichedResult.failedKeywords];
    keywordWriteRepository.persistFailures(country, failedKeywords);
    keywordWriteRepository.clearFailures(
      country,
      items.map((item) => item.keyword)
    );
    if (failedKeywords.length > 0) {
      logger.debug(
        `[keyword-pipeline] failed keywords count=${failedKeywords.length} details=${summarizeFailedKeywords(
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

  async retryFailed(appId: string, country: string): Promise<{
    retriedCount: number;
    succeededCount: number;
    failedCount: number;
  }> {
    const failures = listKeywordFailuresForApp(appId, country);
    const keywordsToRetry = Array.from(
      new Set(failures.map((failure) => failure.keyword))
    );
    if (keywordsToRetry.length === 0) {
      return {
        retriedCount: 0,
        succeededCount: 0,
        failedCount: 0,
      };
    }

    const stageResult = await this.runPopularityStage(country, keywordsToRetry, {
      allowInteractiveAuthRecovery: false,
    });
    const [enrichedResult, orderRefreshedItems] = await Promise.all([
      this.enrichAndPersist(country, stageResult.pendingItems),
      this.refreshOrder(country, stageResult.orderRefreshKeywords),
    ]);
    const succeededKeywords = [
      ...stageResult.hits.map((item) => item.keyword),
      ...orderRefreshedItems.map((item) => item.keyword),
      ...enrichedResult.items.map((item) => item.keyword),
    ];
    if (succeededKeywords.length > 0) {
      keywordWriteRepository.clearFailures(country, succeededKeywords);
    }
    const failedCount =
      stageResult.failedKeywords.length + enrichedResult.failedKeywords.length;

    return {
      retriedCount: keywordsToRetry.length,
      succeededCount: succeededKeywords.length,
      failedCount,
    };
  }
}

export const keywordPipelineService = new KeywordPipelineService();
