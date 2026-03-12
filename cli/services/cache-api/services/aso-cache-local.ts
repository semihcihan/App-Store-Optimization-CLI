import {
  computeExpiryIso,
  computeAppExpiryIsoForApp,
  normalizeKeyword,
  sanitizeKeywords,
} from "./aso-keyword-utils";
import {
  getKeyword,
  upsertKeywords,
  getCompetitorAppDocs,
  upsertCompetitorAppDocs,
} from "../../../db";
import type {
  AsoCacheRepository,
  AsoKeywordRecord,
  AsoAppDoc,
} from "./aso-types";

function isFiniteFutureIso(iso: string | undefined, nowMs: number): boolean {
  if (!iso) return false;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) && parsed > nowMs;
}

function isCompleteKeywordRecord(
  item: Awaited<ReturnType<typeof getKeyword>>
): item is AsoKeywordRecord {
  if (!item) return false;
  return (
    item.difficultyScore != null &&
    item.minDifficultyScore != null &&
    item.appCount != null &&
    item.keywordIncluded != null
  );
}

function toAsoAppDoc(row: ReturnType<typeof getCompetitorAppDocs>[number]): AsoAppDoc {
  return {
    appId: row.appId,
    country: row.country,
    name: row.name,
    subtitle: row.subtitle,
    averageUserRating: row.averageUserRating,
    userRatingCount: row.userRatingCount,
    releaseDate: row.releaseDate,
    currentVersionReleaseDate: row.currentVersionReleaseDate,
    icon: row.icon,
    iconArtwork: row.iconArtwork,
    expiresAt: row.expiresAt,
  };
}

export class LocalAsoCacheRepository implements AsoCacheRepository {
  async getByKeywords(params: {
    country: string;
    keywords: string[];
  }): Promise<{ hits: AsoKeywordRecord[]; misses: string[] }> {
    const country = params.country.toUpperCase();
    const keywords = sanitizeKeywords(params.keywords);
    const nowMs = Date.now();
    const hits: AsoKeywordRecord[] = [];
    const misses: string[] = [];

    for (const keyword of keywords) {
      const item = getKeyword(country, keyword);
      if (
        !isCompleteKeywordRecord(item) ||
        !isFiniteFutureIso(item.expiresAt, nowMs)
      ) {
        misses.push(keyword);
        continue;
      }
      hits.push(item);
    }
    return { hits, misses };
  }

  async upsertMany(params: {
    country: string;
    items: Array<{
      keyword: string;
      popularity: number;
      difficultyScore: number;
      minDifficultyScore: number;
      appCount: number;
      keywordIncluded: number;
      orderedAppIds: string[];
    }>;
    appDocs?: AsoAppDoc[];
  }): Promise<AsoKeywordRecord[]> {
    const country = params.country.toUpperCase();
    const expiresAt = computeExpiryIso();
    const records: AsoKeywordRecord[] = params.items.map((item) => ({
      keyword: item.keyword,
      normalizedKeyword: normalizeKeyword(item.keyword),
      country,
      popularity: item.popularity,
      difficultyScore: item.difficultyScore,
      minDifficultyScore: item.minDifficultyScore,
      appCount: item.appCount,
      keywordIncluded: item.keywordIncluded,
      orderedAppIds: item.orderedAppIds,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt,
    }));

    if (params.items.length > 0) {
      upsertKeywords(
        country,
        params.items.map((item) => ({
          keyword: item.keyword,
          normalizedKeyword: normalizeKeyword(item.keyword),
          popularity: item.popularity,
          difficultyScore: item.difficultyScore,
          minDifficultyScore: item.minDifficultyScore,
          appCount: item.appCount,
          keywordIncluded: item.keywordIncluded,
          orderedAppIds: item.orderedAppIds,
          expiresAt,
        }))
      );
    }

    if (params.appDocs && params.appDocs.length > 0) {
      upsertCompetitorAppDocs(
        country,
        params.appDocs.map((app) => ({
          appId: app.appId,
          name: app.name,
          subtitle: app.subtitle,
          averageUserRating: app.averageUserRating,
          userRatingCount: app.userRatingCount,
          releaseDate: app.releaseDate,
          currentVersionReleaseDate: app.currentVersionReleaseDate,
          icon: app.icon as Record<string, unknown> | undefined,
          iconArtwork: app.iconArtwork as
            | { url?: string; [key: string]: unknown }
            | undefined,
          expiresAt: app.expiresAt ?? computeAppExpiryIsoForApp(),
        }))
      );
    }

    return records.map((fallback) => {
      const stored = getKeyword(country, fallback.keyword);
      if (isCompleteKeywordRecord(stored)) {
        return stored;
      }
      return fallback;
    });
  }

  async getAppDocs(params: {
    country: string;
    appIds: string[];
  }): Promise<AsoAppDoc[]> {
    const country = params.country.toUpperCase();
    const appIds = Array.from(
      new Set(params.appIds.map((appId) => appId.trim()).filter(Boolean))
    );
    if (appIds.length === 0) return [];
    const nowMs = Date.now();
    return getCompetitorAppDocs(country, appIds)
      .filter(
        (doc) =>
          doc.country === country && isFiniteFutureIso(doc.expiresAt, nowMs)
      )
      .map(toAsoAppDoc);
  }
}

export const localAsoCacheRepository = new LocalAsoCacheRepository();
