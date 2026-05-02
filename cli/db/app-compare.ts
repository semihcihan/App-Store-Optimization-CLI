import { getDb } from "./store";
import {
  DEFAULT_ASO_COUNTRY,
  normalizeKeyword,
} from "../domain/keywords/policy";

const COUNTRY = DEFAULT_ASO_COUNTRY;

export type CompareUniverseRow = {
  keyword: string;
  normalizedKeyword: string;
  trackedByAppIds: string[];
  trackedCount: number;
  popularity: number | null;
  difficulty: number | null;
  isResearched: boolean;
};

export type CompareMatrixRow = {
  appId: string;
  keyword: string;
  normalizedKeyword: string;
  popularity: number | null;
  difficulty: number | null;
  isResearched: boolean;
  currentPosition: number | null;
  previousPosition: number | null;
  isTracked: boolean;
};

type UniverseSqlRow = {
  keyword: string;
  tracked_app_ids_csv: string | null;
  tracked_count: number;
  popularity: number | null;
  difficulty: number | null;
  is_researched: number;
};

type MatrixSqlRow = {
  app_id: string;
  keyword: string;
  normalized: string;
  popularity: number | null;
  difficulty: number | null;
  is_researched: number;
  current_position: number | null;
  previous_position: number | null;
  is_tracked: number;
};

function dedupeNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function dedupeNormalizedKeywords(values: string[]): Array<{
  raw: string;
  normalized: string;
}> {
  const seen = new Set<string>();
  const out: Array<{ raw: string; normalized: string }> = [];
  for (const value of values) {
    const normalized = normalizeKeyword(value);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({ raw: value.trim(), normalized });
  }
  return out;
}

export function listUnionKeywords(
  appIds: string[],
  country: string = COUNTRY
): CompareUniverseRow[] {
  const dedupedAppIds = dedupeNonEmpty(appIds);
  if (dedupedAppIds.length === 0) return [];
  const db = getDb();
  const appPlaceholders = dedupedAppIds.map(() => "?").join(", ");
  const sql = `
    SELECT
      ak.keyword AS keyword,
      GROUP_CONCAT(ak.app_id, ',') AS tracked_app_ids_csv,
      COUNT(DISTINCT ak.app_id) AS tracked_count,
      k.popularity AS popularity,
      k.difficulty_score AS difficulty,
      CASE WHEN k.normalized_keyword IS NULL THEN 0 ELSE 1 END AS is_researched
    FROM app_keywords ak
    LEFT JOIN aso_keywords k
      ON k.normalized_keyword = ak.keyword
     AND k.country = ak.country
    WHERE ak.app_id IN (${appPlaceholders})
      AND ak.country = ?
    GROUP BY ak.keyword
    ORDER BY tracked_count DESC,
             (k.popularity IS NULL) ASC,
             k.popularity DESC,
             ak.keyword COLLATE NOCASE ASC
  `;
  const rows = db
    .prepare(sql)
    .all(...dedupedAppIds, country) as UniverseSqlRow[];
  const requestedAppIdSet = new Set(dedupedAppIds);
  return rows.map((row) => {
    const trackedByAppIds = (row.tracked_app_ids_csv ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value): value is string => value.length > 0)
      .filter((appId) => requestedAppIdSet.has(appId));
    const uniqueTracked = Array.from(new Set(trackedByAppIds));
    return {
      keyword: row.keyword,
      normalizedKeyword: row.keyword,
      trackedByAppIds: uniqueTracked,
      trackedCount: uniqueTracked.length,
      popularity: row.popularity,
      difficulty: row.difficulty,
      isResearched: row.is_researched === 1,
    };
  });
}

export function getCompareMatrix(
  appIds: string[],
  keywords: string[],
  country: string = COUNTRY
): CompareMatrixRow[] {
  const dedupedAppIds = dedupeNonEmpty(appIds);
  const dedupedKeywords = dedupeNormalizedKeywords(keywords);
  if (dedupedAppIds.length === 0 || dedupedKeywords.length === 0) return [];
  const db = getDb();
  const appValues = dedupedAppIds.map(() => "(?)").join(", ");
  const kwValues = dedupedKeywords.map(() => "(?, ?)").join(", ");
  const sql = `
    WITH
      selected_apps(app_id) AS (VALUES ${appValues}),
      selected_kws(keyword, normalized) AS (VALUES ${kwValues}),
      kw_meta AS (
        SELECT
          sk.keyword AS keyword,
          sk.normalized AS normalized,
          k.popularity AS popularity,
          k.difficulty_score AS difficulty,
          k.ordered_app_ids AS ordered_app_ids,
          CASE WHEN k.normalized_keyword IS NULL THEN 0 ELSE 1 END AS is_researched
        FROM selected_kws sk
        LEFT JOIN aso_keywords k
          ON k.normalized_keyword = sk.normalized
         AND k.country = ?
      )
    SELECT
      sa.app_id AS app_id,
      km.keyword AS keyword,
      km.normalized AS normalized,
      km.popularity AS popularity,
      km.difficulty AS difficulty,
      km.is_researched AS is_researched,
      (
        SELECT CAST(je.key AS INTEGER) + 1
        FROM json_each(COALESCE(km.ordered_app_ids, '[]')) AS je
        WHERE je.value = sa.app_id
        LIMIT 1
      ) AS current_position,
      ak.previous_position AS previous_position,
      CASE WHEN ak.app_id IS NULL THEN 0 ELSE 1 END AS is_tracked
    FROM selected_apps sa
    CROSS JOIN kw_meta km
    LEFT JOIN app_keywords ak
      ON ak.app_id = sa.app_id
     AND ak.keyword = km.normalized
     AND ak.country = ?
    ORDER BY km.normalized ASC, sa.app_id ASC
  `;
  const params: unknown[] = [];
  for (const appId of dedupedAppIds) params.push(appId);
  for (const { raw, normalized } of dedupedKeywords) {
    params.push(raw);
    params.push(normalized);
  }
  params.push(country);
  params.push(country);
  const rows = db.prepare(sql).all(...params) as MatrixSqlRow[];
  return rows.map((row) => ({
    appId: row.app_id,
    keyword: row.keyword,
    normalizedKeyword: row.normalized,
    popularity: row.popularity,
    difficulty: row.difficulty,
    isResearched: row.is_researched === 1,
    currentPosition: row.current_position,
    previousPosition: row.previous_position,
    isTracked: row.is_tracked === 1,
  }));
}
