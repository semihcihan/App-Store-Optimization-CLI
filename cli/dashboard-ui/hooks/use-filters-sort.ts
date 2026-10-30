import { useEffect, useMemo, useState } from "react";
import { getChange } from "../app-helpers";
import {
  DASHBOARD_FILTER_BOUNDS,
  DASHBOARD_FILTER_DEFAULTS,
  type DashboardBrandFilter,
  type DashboardFavoriteFilter,
} from "../filter-constants";

export type SortKey =
  | "keyword"
  | "popularity"
  | "difficulty"
  | "appCount"
  | "rank"
  | "change"
  | "addedAt"
  | "updatedAt";
export type SortDir = "asc" | "desc";

const SORT_STORAGE_KEY = "aso-dashboard:keyword-sort";
const FILTERS_STORAGE_KEY = "aso-dashboard:keyword-filters";
const DEFAULT_SORT_STATE: { key: SortKey; dir: SortDir } = {
  key: "updatedAt",
  dir: "desc",
};
const DEFAULT_FILTER_STATE = DASHBOARD_FILTER_DEFAULTS;

function isSortKey(value: unknown): value is SortKey {
  return (
    value === "keyword" ||
    value === "popularity" ||
    value === "difficulty" ||
    value === "appCount" ||
    value === "rank" ||
    value === "change" ||
    value === "addedAt" ||
    value === "updatedAt"
  );
}

function isSortDir(value: unknown): value is SortDir {
  return value === "asc" || value === "desc";
}

function isBrandFilter(value: unknown): value is DashboardBrandFilter {
  return value === "all" || value === "brand" || value === "non_brand";
}

function isFavoriteFilter(value: unknown): value is DashboardFavoriteFilter {
  return value === "all" || value === "favorite" || value === "non_favorite";
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

function coerceIntegerInRange(
  value: unknown,
  minInclusive: number,
  maxInclusive: number
): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (!Number.isInteger(value)) return null;
  if (value < minInclusive || value > maxInclusive) return null;
  return value;
}

function getStoredFilterState(): typeof DEFAULT_FILTER_STATE {
  if (typeof window === "undefined") return DEFAULT_FILTER_STATE;
  try {
    const raw = localStorage.getItem(FILTERS_STORAGE_KEY);
    if (!raw) return DEFAULT_FILTER_STATE;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_FILTER_STATE;

    const minPopularity = coerceIntegerInRange(
      (parsed as { minPopularity?: unknown }).minPopularity,
      DASHBOARD_FILTER_BOUNDS.minPopularity.min,
      DASHBOARD_FILTER_BOUNDS.minPopularity.max
    );
    const maxDifficulty = coerceIntegerInRange(
      (parsed as { maxDifficulty?: unknown }).maxDifficulty,
      DASHBOARD_FILTER_BOUNDS.maxDifficulty.min,
      DASHBOARD_FILTER_BOUNDS.maxDifficulty.max
    );
    const minRank = coerceIntegerInRange(
      (parsed as { minRank?: unknown }).minRank,
      DASHBOARD_FILTER_BOUNDS.minRank.min,
      DASHBOARD_FILTER_BOUNDS.minRank.max
    );
    const maxRank = coerceIntegerInRange(
      (parsed as { maxRank?: unknown }).maxRank,
      DASHBOARD_FILTER_BOUNDS.maxRank.min,
      DASHBOARD_FILTER_BOUNDS.maxRank.max
    );
    const parsedBrand = (parsed as { brand?: unknown }).brand;
    const brand = isBrandFilter(parsedBrand)
      ? parsedBrand
      : DEFAULT_FILTER_STATE.brand;
    const parsedFavorite = (parsed as { favorite?: unknown }).favorite;
    const favorite = isFavoriteFilter(parsedFavorite)
      ? parsedFavorite
      : DEFAULT_FILTER_STATE.favorite;

    if (
      minPopularity == null ||
      maxDifficulty == null ||
      minRank == null ||
      maxRank == null
    ) {
      return DEFAULT_FILTER_STATE;
    }
    if (minRank > maxRank) return DEFAULT_FILTER_STATE;

    return {
      minPopularity,
      maxDifficulty,
      brand,
      favorite,
      minRank,
      maxRank,
    };
  } catch {
    return DEFAULT_FILTER_STATE;
  }
}

type FilterableRow = {
  keyword: string;
  popularity: number;
  difficultyScore: number | null;
  isBrandKeyword: boolean | null;
  isFavorite: boolean;
  appCount: number | null;
  addedAt?: string | null;
  updatedAt?: string;
  previousPosition: number | null;
  currentPosition: number | null;
  keywordStatus: "ok" | "pending" | "failed";
};

type UseFiltersSortParams<T extends FilterableRow> = {
  keywords: T[];
  showRankingColumns: boolean;
  mode?: "local" | "server";
};

export function useFiltersSort<T extends FilterableRow>(params: UseFiltersSortParams<T>) {
  const [initialFilterState] = useState(() => getStoredFilterState());
  const [keywordFilter, setKeywordFilter] = useState("");
  const [maxDifficulty, setMaxDifficulty] = useState(initialFilterState.maxDifficulty);
  const [minPopularity, setMinPopularity] = useState(initialFilterState.minPopularity);
  const [brandFilter, setBrandFilter] = useState(initialFilterState.brand);
  const [favoriteFilter, setFavoriteFilter] = useState(initialFilterState.favorite);
  const [minRank, setMinRank] = useState(initialFilterState.minRank);
  const [maxRank, setMaxRank] = useState(initialFilterState.maxRank);
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
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem(
        FILTERS_STORAGE_KEY,
        JSON.stringify({
          maxDifficulty,
          minPopularity,
          brand: brandFilter,
          favorite: favoriteFilter,
          minRank,
          maxRank,
        })
      );
    } catch {
      // no-op
    }
  }, [maxDifficulty, minPopularity, brandFilter, favoriteFilter, minRank, maxRank]);

  useEffect(() => {
    if (params.showRankingColumns) return;
    if (sortBy !== "rank" && sortBy !== "change") return;
    setSortBy(DEFAULT_SORT_STATE.key);
    setSortDir(DEFAULT_SORT_STATE.dir);
  }, [params.showRankingColumns, sortBy]);

  const filteredRows = useMemo(() => {
    if (params.mode === "server") {
      return params.keywords;
    }

    const term = keywordFilter.trim().toLowerCase();
    const hasPopularityMinBound = minPopularity > DEFAULT_FILTER_STATE.minPopularity;
    const hasDifficultyMaxBound = maxDifficulty < DEFAULT_FILTER_STATE.maxDifficulty;
    const hasBrandFilter = brandFilter !== DEFAULT_FILTER_STATE.brand;
    const hasFavoriteFilter = favoriteFilter !== DEFAULT_FILTER_STATE.favorite;
    const hasRankLowerBound = minRank > DEFAULT_FILTER_STATE.minRank;
    const hasRankUpperBound = maxRank !== DEFAULT_FILTER_STATE.maxRank;
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
      if (hasBrandFilter) {
        if (brandFilter === "brand" && row.isBrandKeyword !== true) return false;
        if (brandFilter === "non_brand" && row.isBrandKeyword !== false) return false;
      }
      if (hasFavoriteFilter) {
        if (favoriteFilter === "favorite" && row.isFavorite !== true) return false;
        if (favoriteFilter === "non_favorite" && row.isFavorite === true) return false;
      }
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
        case "addedAt":
          return compareNullable(
            a.addedAt ? new Date(a.addedAt).getTime() : null,
            b.addedAt ? new Date(b.addedAt).getTime() : null
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
    params.mode,
    params.keywords,
    params.showRankingColumns,
    keywordFilter,
    maxDifficulty,
    minPopularity,
    brandFilter,
    favoriteFilter,
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
    brandFilter,
    setBrandFilter,
    favoriteFilter,
    setFavoriteFilter,
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
