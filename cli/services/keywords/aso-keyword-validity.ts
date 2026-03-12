import type { StoredAsoKeyword } from "../../db/types";

export type CompleteStoredAsoKeyword = StoredAsoKeyword & {
  difficultyScore: number;
  minDifficultyScore: number;
  appCount: number;
  keywordIncluded: number;
};

export function isFreshIso(iso: string | undefined, nowMs: number): boolean {
  if (!iso) return false;
  const ts = Date.parse(iso);
  return Number.isFinite(ts) && ts > nowMs;
}

export function isCompleteStoredAsoKeyword(
  keyword: StoredAsoKeyword | null | undefined
): keyword is CompleteStoredAsoKeyword {
  if (!keyword) return false;
  return (
    keyword.difficultyScore != null &&
    keyword.minDifficultyScore != null &&
    keyword.appCount != null &&
    keyword.keywordIncluded != null
  );
}

export function isStoredKeywordOrderFresh(
  keyword: StoredAsoKeyword,
  nowMs: number
): boolean {
  return isFreshIso(keyword.orderExpiresAt, nowMs);
}

export function isStoredKeywordPopularityFresh(
  keyword: StoredAsoKeyword,
  nowMs: number
): boolean {
  return isFreshIso(keyword.popularityExpiresAt, nowMs);
}

export function isStoredKeywordCacheHit(
  keyword: StoredAsoKeyword | null | undefined,
  nowMs: number
): keyword is CompleteStoredAsoKeyword {
  return (
    isCompleteStoredAsoKeyword(keyword) &&
    isStoredKeywordOrderFresh(keyword, nowMs) &&
    isStoredKeywordPopularityFresh(keyword, nowMs)
  );
}
