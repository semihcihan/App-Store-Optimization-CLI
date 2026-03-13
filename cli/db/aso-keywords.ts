import type { StoredAsoKeyword } from "./types";
import { getDb } from "./store";
import { computePopularityExpiryIso } from "../shared/aso-keyword-utils";
import { normalizeKeyword } from "../domain/keywords/policy";

type KeywordRow = {
  country: string;
  normalized_keyword: string;
  keyword: string;
  popularity: number;
  difficulty_score: number | null;
  min_difficulty_score: number | null;
  app_count: number | null;
  keyword_included: number | null;
  ordered_app_ids: string;
  created_at: string;
  updated_at: string;
  order_expires_at: string;
  popularity_expires_at: string;
};

function roundNullableScore(value: number | null): number | null {
  if (value == null) return null;
  return Math.round(value);
}

function toStoredKeyword(row: KeywordRow): StoredAsoKeyword {
  let orderedAppIds: string[] = [];
  try {
    const parsed = JSON.parse(row.ordered_app_ids) as unknown;
    if (Array.isArray(parsed)) {
      orderedAppIds = parsed.map((id) => String(id));
    }
  } catch {
    orderedAppIds = [];
  }
  return {
    keyword: row.keyword,
    normalizedKeyword: row.normalized_keyword,
    country: row.country,
    popularity: row.popularity,
    difficultyScore: row.difficulty_score,
    minDifficultyScore: row.min_difficulty_score,
    appCount: row.app_count,
    keywordIncluded: row.keyword_included,
    orderedAppIds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    orderExpiresAt: row.order_expires_at,
    popularityExpiresAt: row.popularity_expires_at,
  };
}

export function getKeyword(country: string, keyword: string): StoredAsoKeyword | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT country, normalized_keyword, keyword, popularity, difficulty_score,
              min_difficulty_score, app_count, keyword_included, ordered_app_ids,
              created_at, updated_at, order_expires_at, popularity_expires_at
       FROM aso_keywords
       WHERE country = ? AND normalized_keyword = ?`
    )
    .get(country, normalizeKeyword(keyword)) as KeywordRow | undefined;
  if (!row) return null;
  return toStoredKeyword(row);
}

export function listKeywords(country: string): StoredAsoKeyword[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT country, normalized_keyword, keyword, popularity, difficulty_score,
              min_difficulty_score, app_count, keyword_included, ordered_app_ids,
              created_at, updated_at, order_expires_at, popularity_expires_at
       FROM aso_keywords
       WHERE country = ?
       ORDER BY keyword COLLATE NOCASE ASC`
    )
    .all(country) as KeywordRow[];
  return rows.map(toStoredKeyword);
}

export function getKeywords(
  country: string,
  keywords: string[]
): StoredAsoKeyword[] {
  const normalizedKeywords = Array.from(
    new Set(keywords.map((keyword) => normalizeKeyword(keyword)).filter(Boolean))
  );
  if (normalizedKeywords.length === 0) return [];

  const db = getDb();
  const placeholders = normalizedKeywords.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT country, normalized_keyword, keyword, popularity, difficulty_score,
              min_difficulty_score, app_count, keyword_included, ordered_app_ids,
              created_at, updated_at, order_expires_at, popularity_expires_at
       FROM aso_keywords
       WHERE country = ? AND normalized_keyword IN (${placeholders})`
    )
    .all(country, ...normalizedKeywords) as KeywordRow[];
  return rows.map(toStoredKeyword);
}

export function upsertKeywords(
  country: string,
  items: Array<{
    keyword: string;
    normalizedKeyword?: string;
    popularity: number;
    difficultyScore: number | null;
    minDifficultyScore: number | null;
    appCount: number | null;
    keywordIncluded: number | null;
    orderedAppIds: string[];
    createdAt?: string;
    updatedAt?: string;
    orderExpiresAt: string;
    popularityExpiresAt?: string;
  }>
): void {
  if (items.length === 0) return;
  const db = getDb();
  const now = new Date().toISOString();
  const getExistingStmt = db.prepare(
    `SELECT created_at, popularity_expires_at
     FROM aso_keywords
     WHERE country = ? AND normalized_keyword = ?`
  );
  const upsertStmt = db.prepare(`
    INSERT INTO aso_keywords (
      country, normalized_keyword, keyword, popularity, difficulty_score,
      min_difficulty_score, app_count, keyword_included, ordered_app_ids,
      created_at, updated_at, order_expires_at, popularity_expires_at
    )
    VALUES (
      @country, @normalizedKeyword, @keyword, @popularity, @difficultyScore,
      @minDifficultyScore, @appCount, @keywordIncluded, @orderedAppIds,
      @createdAt, @updatedAt, @orderExpiresAt, @popularityExpiresAt
    )
    ON CONFLICT(country, normalized_keyword) DO UPDATE SET
      keyword = excluded.keyword,
      popularity = excluded.popularity,
      difficulty_score = excluded.difficulty_score,
      min_difficulty_score = excluded.min_difficulty_score,
      app_count = excluded.app_count,
      keyword_included = excluded.keyword_included,
      ordered_app_ids = excluded.ordered_app_ids,
      updated_at = excluded.updated_at,
      order_expires_at = excluded.order_expires_at,
      popularity_expires_at = excluded.popularity_expires_at
  `);
  const tx = db.transaction(() => {
    for (const item of items) {
      const norm = item.normalizedKeyword ?? normalizeKeyword(item.keyword);
      const existing = getExistingStmt.get(country, norm) as
        | { created_at: string; popularity_expires_at: string }
        | undefined;
      const record: StoredAsoKeyword = {
        keyword: item.keyword,
        normalizedKeyword: norm,
        country,
        popularity: item.popularity,
        difficultyScore: roundNullableScore(item.difficultyScore),
        minDifficultyScore: roundNullableScore(item.minDifficultyScore),
        appCount: item.appCount,
        keywordIncluded: item.keywordIncluded,
        orderedAppIds: item.orderedAppIds,
        createdAt: item.createdAt ?? existing?.created_at ?? now,
        updatedAt: item.updatedAt ?? now,
        orderExpiresAt: item.orderExpiresAt,
        popularityExpiresAt:
          item.popularityExpiresAt ??
          existing?.popularity_expires_at ??
          computePopularityExpiryIso(),
      };
      upsertStmt.run({
        country: record.country,
        normalizedKeyword: record.normalizedKeyword,
        keyword: record.keyword,
        popularity: record.popularity,
        difficultyScore: record.difficultyScore,
        minDifficultyScore: record.minDifficultyScore,
        appCount: record.appCount,
        keywordIncluded: record.keywordIncluded,
        orderedAppIds: JSON.stringify(record.orderedAppIds),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        orderExpiresAt: record.orderExpiresAt,
        popularityExpiresAt: record.popularityExpiresAt,
      });
    }
  });
  tx();
}

export function getExpiredKeywords(country: string): string[] {
  const db = getDb();
  const now = new Date().toISOString();
  const rows = db
    .prepare(
      `SELECT keyword
       FROM aso_keywords
       WHERE country = ? AND order_expires_at <= ?
       ORDER BY keyword COLLATE NOCASE ASC`
    )
    .all(country, now) as Array<{ keyword: string }>;
  return rows.map((row) => row.keyword);
}
