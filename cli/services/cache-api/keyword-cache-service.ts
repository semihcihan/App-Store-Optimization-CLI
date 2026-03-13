import { z } from "zod";
import { getAsoResilienceConfig } from "../../shared/aso-resilience";
import { normalizeAppleUpstreamError } from "../../shared/apple-upstream-error";
import type { FailedKeyword } from "../../shared/aso-keyword-types";
import { localAsoCacheRepository } from "./services/aso-cache-local";
import { enrichKeyword } from "./services/aso-enrichment-service";
import { normalizeKeyword, sanitizeKeywords } from "./services/aso-keyword-utils";
import { getAsoAppDocs as getAsoAppDocsFromService } from "./services/aso-app-doc-service";
import { ASO_MAX_KEYWORDS } from "../../shared/aso-keyword-limits";
import type {
  AsoAppDoc,
  AsoCacheRepository,
  AsoKeywordRecord,
} from "./services/aso-types";
import {
  DEFAULT_ASO_COUNTRY,
  assertSupportedCountry,
  normalizeCountry,
} from "../../domain/keywords/policy";

const CacheLookupRequestSchema = z.object({
  country: z.string().default(DEFAULT_ASO_COUNTRY),
  keywords: z.array(z.string()).min(1).max(ASO_MAX_KEYWORDS),
});

const EnrichRequestSchema = z.object({
  country: z.string().default(DEFAULT_ASO_COUNTRY),
  items: z
    .array(
      z.object({
        keyword: z.string().min(1),
        popularity: z.number().min(0).max(100),
      })
    )
    .min(1)
    .max(ASO_MAX_KEYWORDS),
});
const AppDocsRequestSchema = z.object({
  country: z.string().default(DEFAULT_ASO_COUNTRY),
  appIds: z.array(z.string()).min(1).max(50),
});

interface AsoDependencies {
  repository: AsoCacheRepository;
}

function getDefaultDependencies(): AsoDependencies {
  return { repository: localAsoCacheRepository };
}

async function mapSettledWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
): Promise<Array<PromiseSettledResult<R>>> {
  if (items.length === 0) return [];
  const maxConcurrency = Math.max(1, Math.floor(concurrency));
  const results: Array<PromiseSettledResult<R>> = new Array(items.length);
  let index = 0;

  const runWorker = async (): Promise<void> => {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      try {
        const value = await mapper(items[currentIndex]);
        results[currentIndex] = {
          status: "fulfilled",
          value,
        };
      } catch (reason) {
        results[currentIndex] = {
          status: "rejected",
          reason,
        };
      }
    }
  };

  const workerCount = Math.min(maxConcurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

export async function lookupAsoCache(
  params: { country: string; keywords: string[] },
  dependencies: AsoDependencies = getDefaultDependencies()
): Promise<{ hits: AsoKeywordRecord[]; misses: string[] }> {
  const validated = CacheLookupRequestSchema.parse(params);
  const country = normalizeCountry(validated.country);
  assertSupportedCountry(country);

  return dependencies.repository.getByKeywords({
    country,
    keywords: sanitizeKeywords(validated.keywords),
  });
}

export async function enrichAsoKeywords(
  params: {
    country: string;
    items: Array<{ keyword: string; popularity: number }>;
  },
  dependencies: AsoDependencies = getDefaultDependencies()
): Promise<{
  items: Array<AsoKeywordRecord & { appDocs?: AsoAppDoc[] }>;
  failedKeywords: FailedKeyword[];
}> {
  const validated = EnrichRequestSchema.parse(params);
  const country = normalizeCountry(validated.country);
  assertSupportedCountry(country);

  const getAppDocs = dependencies.repository.getAppDocs
    ? (appIds: string[]) =>
        dependencies.repository.getAppDocs!({ country, appIds })
    : undefined;
  const settled = await mapSettledWithConcurrency(
    validated.items,
    getAsoResilienceConfig().keywordEnrichmentConcurrency,
    (item) =>
      enrichKeyword(
        {
          keyword: item.keyword,
          popularity: item.popularity,
          country,
        },
        getAppDocs ? { getAppDocs } : undefined
      )
  );

  const enriched = settled.flatMap((entry) =>
    entry.status === "fulfilled" ? [entry.value] : []
  );
  const failedKeywords = settled.flatMap((entry, index) => {
    if (entry.status !== "rejected") return [];
    const keyword = validated.items[index]?.keyword ?? "";
    const normalized = normalizeAppleUpstreamError({
      error: entry.reason,
      operation: "keyword-enrichment",
      defaultReasonCode: "ENRICHMENT_FAILED",
    });
    return [
      {
        keyword: normalizeKeyword(keyword),
        stage: "enrichment" as const,
        reasonCode: normalized.reasonCode,
        message: normalized.message,
        statusCode: normalized.statusCode,
        retryable: normalized.retryable,
        attempts: normalized.attempts,
        requestId: normalized.requestId,
      },
    ];
  });

  const allAppDocs = enriched.flatMap((e) => e.appDocs);
  const normalizedAppDocs = allAppDocs.map((doc) => ({
    ...doc,
    country,
  }));
  const appDocsByKeyword = new Map(
    enriched.map((item) => [
      normalizeKeyword(item.keyword),
      (item.appDocs ?? []).map((doc) => ({ ...doc, country })),
    ])
  );
  const persisted =
    enriched.length > 0
      ? await dependencies.repository.upsertMany({
          country,
          items: enriched.map((e) => ({
            keyword: e.keyword,
            popularity: e.popularity,
            difficultyScore: e.difficultyScore,
            minDifficultyScore: e.minDifficultyScore,
            appCount: e.appCount,
            keywordIncluded: e.keywordIncluded,
            orderedAppIds: e.orderedAppIds,
          })),
          appDocs: normalizedAppDocs,
        })
      : [];
  return {
    items: persisted.map((item) => ({
      ...item,
      appDocs: appDocsByKeyword.get(item.normalizedKeyword) ?? [],
    })),
    failedKeywords,
  };
}

export async function getAsoAppDocs(
  params: { country: string; appIds: string[] },
  dependencies: AsoDependencies = getDefaultDependencies()
): Promise<AsoAppDoc[]> {
  const validated = AppDocsRequestSchema.parse(params);
  const country = normalizeCountry(validated.country);
  assertSupportedCountry(country);
  return getAsoAppDocsFromService({
    country,
    appIds: validated.appIds,
    repository: dependencies.repository,
  });
}
