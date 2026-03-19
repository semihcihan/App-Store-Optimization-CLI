import type { KeywordMatchType } from "./aso-keyword-match";

type KeywordFreshnessFields = {
  difficultyScore: number | null;
  minDifficultyScore: number | null;
  appCount: number | null;
  keywordMatch: KeywordMatchType | null;
  orderExpiresAt: string;
  popularityExpiresAt: string;
};

export type CompleteStoredAsoKeyword<
  T extends KeywordFreshnessFields = KeywordFreshnessFields,
> = T & {
  difficultyScore: number;
  minDifficultyScore: number;
  appCount: number;
  keywordMatch: KeywordMatchType;
};

export function isFreshIso(iso: string | undefined, nowMs: number): boolean {
  if (!iso) return false;
  const ts = Date.parse(iso);
  return Number.isFinite(ts) && ts > nowMs;
}

export function isCompleteStoredAsoKeyword<T extends KeywordFreshnessFields>(
  keyword: T | null | undefined
): keyword is CompleteStoredAsoKeyword<T> {
  if (!keyword) return false;
  return (
    keyword.difficultyScore != null &&
    keyword.minDifficultyScore != null &&
    keyword.appCount != null &&
    keyword.keywordMatch != null
  );
}

export function isStoredKeywordOrderFresh(
  keyword: KeywordFreshnessFields,
  nowMs: number
): boolean {
  return isFreshIso(keyword.orderExpiresAt, nowMs);
}

export function isStoredKeywordPopularityFresh(
  keyword: KeywordFreshnessFields,
  nowMs: number
): boolean {
  return isFreshIso(keyword.popularityExpiresAt, nowMs);
}

export function isStoredKeywordCacheHit<T extends KeywordFreshnessFields>(
  keyword: T | null | undefined,
  nowMs: number
): keyword is CompleteStoredAsoKeyword<T> {
  return (
    isCompleteStoredAsoKeyword(keyword) &&
    isStoredKeywordOrderFresh(keyword, nowMs) &&
    isStoredKeywordPopularityFresh(keyword, nowMs)
  );
}
