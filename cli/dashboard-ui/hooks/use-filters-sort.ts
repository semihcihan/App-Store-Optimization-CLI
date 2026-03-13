import { useEffect, useMemo, useState } from "react";
import { getChange } from "../app-helpers";

export type SortKey =
  | "keyword"
  | "popularity"
  | "difficulty"
  | "appCount"
  | "rank"
  | "change"
  | "updatedAt";
export type SortDir = "asc" | "desc";

const SORT_STORAGE_KEY = "aso-dashboard:keyword-sort";
const DEFAULT_SORT_STATE: { key: SortKey; dir: SortDir } = {
  key: "updatedAt",
  dir: "desc",
};

function isSortKey(value: unknown): value is SortKey {
  return (
    value === "keyword" ||
    value === "popularity" ||
    value === "difficulty" ||
    value === "appCount" ||
    value === "rank" ||
    value === "change" ||
    value === "updatedAt"
  );
}

function isSortDir(value: unknown): value is SortDir {
  return value === "asc" || value === "desc";
}

function getStoredSortState(): { key: SortKey; dir: SortDir } {
  if (typeof window === "undefined") return DEFAULT_SORT_STATE;
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY);
    if (!raw) return DEFAULT_SORT_STATE;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_SORT_STATE;
    const maybeKey = (parsed as { key?: unknown }).key;
    const maybeDir = (parsed as { dir?: unknown }).dir;
    if (!isSortKey(maybeKey) || !isSortDir(maybeDir)) return DEFAULT_SORT_STATE;
    return { key: maybeKey, dir: maybeDir };
  } catch {
    return DEFAULT_SORT_STATE;
  }
}

type FilterableRow = {
  keyword: string;
  popularity: number;
  difficultyScore: number | null;
  appCount: number | null;
  updatedAt?: string;
  previousPosition: number | null;
  currentPosition: number | null;
  keywordStatus: "ok" | "pending" | "failed";
};

type UseFiltersSortParams = {
  keywords: FilterableRow[];
  showRankingColumns: boolean;
};

export function useFiltersSort(params: UseFiltersSortParams) {
  const [keywordFilter, setKeywordFilter] = useState("");
  const [maxDifficulty, setMaxDifficulty] = useState(100);
  const [minPopularity, setMinPopularity] = useState(0);
  const [minRank, setMinRank] = useState(0);
  const [maxRank, setMaxRank] = useState(201);
  const [sortBy, setSortBy] = useState<SortKey>(() => getStoredSortState().key);
  const [sortDir, setSortDir] = useState<SortDir>(() => getStoredSortState().dir);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify({ key: sortBy, dir: sortDir }));
    } catch {
      // no-op
    }
  }, [sortBy, sortDir]);

  useEffect(() => {
    if (params.showRankingColumns) return;
    if (sortBy !== "rank" && sortBy !== "change") return;
    setSortBy(DEFAULT_SORT_STATE.key);
    setSortDir(DEFAULT_SORT_STATE.dir);
  }, [params.showRankingColumns, sortBy]);

  const filteredRows = useMemo(() => {
    const term = keywordFilter.trim().toLowerCase();
    const hasPopularityMinBound = minPopularity > 0;
    const hasDifficultyMaxBound = maxDifficulty < 100;
    const hasRankLowerBound = minRank > 0;
    const hasRankUpperBound = maxRank !== 201;
    const hasRankFilter =
      params.showRankingColumns && (hasRankLowerBound || hasRankUpperBound);

    let rows = params.keywords.filter((row) => {
      if (term && !row.keyword.toLowerCase().includes(term)) return false;
      if (
        hasDifficultyMaxBound &&
        row.difficultyScore != null &&
        row.difficultyScore >= maxDifficulty
      ) {
        return false;
      }
      if (hasPopularityMinBound && row.popularity <= minPopularity) return false;
      if (hasRankFilter) {
        if (row.currentPosition == null) return false;
        if (hasRankLowerBound && row.currentPosition <= minRank) return false;
        if (hasRankUpperBound && row.currentPosition >= maxRank) return false;
      }
      return true;
    });

    rows = [...rows].sort((a, b) => {
      const dir = sortDir === "desc" ? -1 : 1;
      const compareNullable = (x: number | null, y: number | null) => {
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        if (x === y) return 0;
        return x > y ? dir : -dir;
      };

      switch (sortBy) {
        case "keyword": {
          const cmp = a.keyword.localeCompare(b.keyword);
          return sortDir === "desc" ? -cmp : cmp;
        }
        case "updatedAt":
          return compareNullable(
            a.updatedAt ? new Date(a.updatedAt).getTime() : null,
            b.updatedAt ? new Date(b.updatedAt).getTime() : null
          );
        case "change":
          return compareNullable(getChange(a), getChange(b));
        case "rank":
          return compareNullable(a.currentPosition, b.currentPosition);
        case "difficulty":
          return compareNullable(a.difficultyScore, b.difficultyScore);
        case "appCount":
          return compareNullable(a.appCount, b.appCount);
        case "popularity":
          return compareNullable(a.popularity, b.popularity);
      }
    });

    return rows;
  }, [
    params.keywords,
    params.showRankingColumns,
    keywordFilter,
    maxDifficulty,
    minPopularity,
    minRank,
    maxRank,
    sortBy,
    sortDir,
  ]);

  return {
    keywordFilter,
    setKeywordFilter,
    maxDifficulty,
    setMaxDifficulty,
    minPopularity,
    setMinPopularity,
    minRank,
    setMinRank,
    maxRank,
    setMaxRank,
    sortBy,
    setSortBy,
    sortDir,
    setSortDir,
    filteredRows,
  };
}
