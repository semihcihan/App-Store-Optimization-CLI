import { z } from "zod";
import { getAsoResilienceConfig } from "../../keywords/aso-resilience";
import { localAsoCacheRepository } from "../services/aso-cache-local";
import { enrichKeyword } from "../services/aso-enrichment-service";
import { normalizeKeyword, sanitizeKeywords } from "../services/aso-keyword-utils";
import { getAsoAppDocs as getAsoAppDocsFromService } from "../services/aso-app-doc-service";
import type {
  AsoAppDoc,
  AsoCacheRepository,
  AsoKeywordRecord,
} from "../services/aso-types";

const MAX_KEYWORDS = 100;

const CacheLookupRequestSchema = z.object({
  country: z.string().default("US"),
  keywords: z.array(z.string()).min(1).max(MAX_KEYWORDS),
});

const EnrichRequestSchema = z.object({
  country: z.string().default("US"),
  items: z
    .array(
      z.object({
        keyword: z.string().min(1),
        popularity: z.number().min(0).max(100),
      })
    )
    .min(1)
    .max(MAX_KEYWORDS),
});
const AppDocsRequestSchema = z.object({
  country: z.string().default("US"),
  appIds: z.array(z.string()).min(1).max(50),
});

interface AsoDependencies {
  repository: AsoCacheRepository;
}

function getDefaultDependencies(): AsoDependencies {
  return { repository: localAsoCacheRepository };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const maxConcurrency = Math.max(1, Math.floor(concurrency));
  const results: R[] = new Array(items.length);
  let index = 0;

  const runWorker = async (): Promise<void> => {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await mapper(items[currentIndex]);
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
  const country = validated.country.toUpperCase();
  if (country !== "US") {
    throw new Error("Only US is supported for now");
  }

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
): Promise<Array<AsoKeywordRecord & { appDocs?: AsoAppDoc[] }>> {
  const validated = EnrichRequestSchema.parse(params);
  const country = validated.country.toUpperCase();
  if (country !== "US") {
    throw new Error("Only US is supported for now");
  }

  const getAppDocs = dependencies.repository.getAppDocs
    ? (appIds: string[]) =>
        dependencies.repository.getAppDocs!({ country, appIds })
    : undefined;
  const enriched = await mapWithConcurrency(
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
  const persisted = await dependencies.repository.upsertMany({
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
  });
  return persisted.map((item) => ({
    ...item,
    appDocs: appDocsByKeyword.get(item.normalizedKeyword) ?? [],
  }));
}

export async function getAsoAppDocs(
  params: { country: string; appIds: string[] },
  dependencies: AsoDependencies = getDefaultDependencies()
): Promise<AsoAppDoc[]> {
  const validated = AppDocsRequestSchema.parse(params);
  return getAsoAppDocsFromService({
    country: validated.country,
    appIds: validated.appIds,
    repository: dependencies.repository,
  });
}
