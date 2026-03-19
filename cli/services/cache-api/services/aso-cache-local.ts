import {
  computeOrderExpiryIso,
  computePopularityExpiryIso,
  normalizeKeyword,
  sanitizeKeywords,
} from "./aso-keyword-utils";
import {
  getKeyword,
  getKeywords,
} from "../../../db/aso-keywords";
import {
  getCompetitorAppDocs,
} from "../../../db/aso-apps";
import type {
  AsoCacheRepository,
  AsoKeywordRecord,
  AsoAppDoc,
} from "./aso-types";
import {
  isCompleteStoredAsoKeyword,
  isStoredKeywordCacheHit,
} from "../../../shared/aso-keyword-validity";
import { keywordWriteRepository } from "../../keywords/keyword-write-repository";
import { normalizeCountry } from "../../../domain/keywords/policy";

function isFiniteFutureIso(iso: string | undefined, nowMs: number): boolean {
  if (!iso) return false;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) && parsed > nowMs;
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
    additionalLocalizations: row.additionalLocalizations,
    expiresAt: row.expiresAt,
  };
}

export class LocalAsoCacheRepository implements AsoCacheRepository {
  async getByKeywords(params: {
    country: string;
    keywords: string[];
  }): Promise<{ hits: AsoKeywordRecord[]; misses: string[] }> {
    const country = normalizeCountry(params.country);
    const keywords = sanitizeKeywords(params.keywords);
    const nowMs = Date.now();
    const hits: AsoKeywordRecord[] = [];
    const misses: string[] = [];

    for (const keyword of keywords) {
      const item = getKeyword(country, keyword);
      if (!isStoredKeywordCacheHit(item, nowMs)) {
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
    const country = normalizeCountry(params.country);
    const normalizedItems = params.items.map((item) => ({
      ...item,
      normalizedKeyword: normalizeKeyword(item.keyword),
    }));
    keywordWriteRepository.upsertKeywordItems(
      country,
      normalizedItems.map((item) => ({
        keyword: item.keyword,
        normalizedKeyword: item.normalizedKeyword,
        popularity: item.popularity,
        difficultyScore: item.difficultyScore,
        minDifficultyScore: item.minDifficultyScore,
        appCount: item.appCount,
        keywordIncluded: item.keywordIncluded,
        orderedAppIds: item.orderedAppIds,
      }))
    );

    if (params.appDocs && params.appDocs.length > 0) {
      keywordWriteRepository.upsertCompetitorDocs(
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
          additionalLocalizations: app.additionalLocalizations,
          expiresAt: app.expiresAt,
        }))
      );
    }

    const existingByNormalized = new Map(
      getKeywords(
        country,
        normalizedItems.map((item) => item.normalizedKeyword)
      ).map((keyword) => [keyword.normalizedKeyword, keyword] as const)
    );

    return normalizedItems.map((fallback) => {
      const existing = existingByNormalized.get(fallback.normalizedKeyword);
      if (isCompleteStoredAsoKeyword(existing)) {
        return {
          ...existing,
          popularityExpiresAt: existing.popularityExpiresAt,
        };
      }
      const stored = getKeyword(country, fallback.keyword);
      if (isCompleteStoredAsoKeyword(stored)) {
        return {
          ...stored,
          popularityExpiresAt: stored.popularityExpiresAt,
        };
      }
      const now = new Date().toISOString();
      return {
        keyword: fallback.keyword,
        normalizedKeyword: fallback.normalizedKeyword,
        country,
        popularity: fallback.popularity,
        difficultyScore: fallback.difficultyScore,
        minDifficultyScore: fallback.minDifficultyScore,
        appCount: fallback.appCount,
        keywordIncluded: fallback.keywordIncluded,
        orderedAppIds: fallback.orderedAppIds,
        createdAt: now,
        updatedAt: now,
        orderExpiresAt: computeOrderExpiryIso(),
        popularityExpiresAt: computePopularityExpiryIso(),
      };
    });
  }

  async getAppDocs(params: {
    country: string;
    appIds: string[];
  }): Promise<AsoAppDoc[]> {
    const country = normalizeCountry(params.country);
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
