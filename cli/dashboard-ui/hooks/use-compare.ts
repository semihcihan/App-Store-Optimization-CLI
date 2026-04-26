import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiGet, apiWrite, toActionableErrorMessage } from "../app-helpers";
import type {
  CompareKeywordsResponse,
  CompareMatrixResponse,
} from "../../shared/compare-types";

const UNIVERSE_DEBOUNCE_MS = 150;
const MATRIX_DEBOUNCE_MS = 250;
const LOCALSTORAGE_KEY = "aso-compare-state";

export type ComparePersistedState = {
  appIds: string[];
  keywords: string[];
  sortBy?: CompareSort;
  country?: string;
  savedAt?: string;
};

export type CompareSort =
  | { kind: "keyword"; dir: "asc" | "desc" }
  | { kind: "popularity"; dir: "asc" | "desc" }
  | { kind: "rank"; appId: string; dir: "asc" | "desc" };

export function loadPersistedCompareState(): ComparePersistedState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LOCALSTORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const appIds = Array.isArray(record.appIds)
      ? record.appIds.filter((v): v is string => typeof v === "string")
      : [];
    const keywords = Array.isArray(record.keywords)
      ? record.keywords.filter((v): v is string => typeof v === "string")
      : [];
    const sortBy = isValidSort(record.sortBy) ? (record.sortBy as CompareSort) : undefined;
    const country = typeof record.country === "string" ? record.country : undefined;
    return { appIds, keywords, sortBy, country };
  } catch {
    return null;
  }
}

function isValidSort(value: unknown): value is CompareSort {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.dir !== "asc" && record.dir !== "desc") return false;
  if (record.kind === "keyword" || record.kind === "popularity") return true;
  if (record.kind === "rank" && typeof record.appId === "string") return true;
  return false;
}

export function persistCompareState(state: ComparePersistedState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      LOCALSTORAGE_KEY,
      JSON.stringify({ ...state, savedAt: new Date().toISOString() })
    );
  } catch {}
}

export function useCompareUniverse(
  appIds: string[],
  country: string,
  enabled: boolean
) {
  const [data, setData] = useState<CompareKeywordsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorText, setErrorText] = useState("");
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setData(null);
      return;
    }
    if (appIds.length < 2) {
      setData(null);
      return;
    }
    const handle = window.setTimeout(() => {
      const requestId = ++requestIdRef.current;
      setIsLoading(true);
      setErrorText("");
      const params = new URLSearchParams({
        appIds: appIds.join(","),
        country,
      });
      apiGet<CompareKeywordsResponse>(
        `/api/aso/compare/keywords?${params.toString()}`
      )
        .then((response) => {
          if (requestIdRef.current !== requestId) return;
          setData(response);
        })
        .catch((error) => {
          if (requestIdRef.current !== requestId) return;
          setErrorText(
            toActionableErrorMessage(error, "Failed to load keyword universe")
          );
          setData(null);
        })
        .finally(() => {
          if (requestIdRef.current !== requestId) return;
          setIsLoading(false);
        });
    }, UNIVERSE_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(handle);
    };
  }, [appIds.join(","), country, enabled]);

  return { universe: data, isUniverseLoading: isLoading, universeError: errorText };
}

export function useCompareMatrix(
  appIds: string[],
  keywords: string[],
  country: string,
  enabled: boolean
) {
  const [data, setData] = useState<CompareMatrixResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorText, setErrorText] = useState("");
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setData(null);
      return;
    }
    if (appIds.length < 2 || keywords.length < 1) {
      setData(null);
      return;
    }
    const handle = window.setTimeout(() => {
      const requestId = ++requestIdRef.current;
      setIsLoading(true);
      setErrorText("");
      apiWrite<CompareMatrixResponse>("POST", "/api/aso/compare/matrix", {
        appIds,
        keywords,
        country,
      })
        .then((response) => {
          if (requestIdRef.current !== requestId) return;
          setData(response);
        })
        .catch((error) => {
          if (requestIdRef.current !== requestId) return;
          setErrorText(
            toActionableErrorMessage(error, "Failed to load compare matrix")
          );
          setData(null);
        })
        .finally(() => {
          if (requestIdRef.current !== requestId) return;
          setIsLoading(false);
        });
    }, MATRIX_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(handle);
    };
  }, [appIds.join(","), keywords.join(","), country, enabled]);

  return { matrix: data, isMatrixLoading: isLoading, matrixError: errorText };
}

export function useSortedMatrixRows(
  matrix: CompareMatrixResponse | null,
  sort: CompareSort
): CompareMatrixResponse["rows"] {
  return useMemo(() => {
    if (!matrix) return [];
    const rows = [...matrix.rows];
    const dirMultiplier = sort.dir === "asc" ? 1 : -1;
    const compareNumbers = (a: number | null, b: number | null): number => {
      if (a === null && b === null) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      return (a - b) * dirMultiplier;
    };
    const compareStrings = (a: string, b: string): number =>
      a.localeCompare(b, undefined, { sensitivity: "base" }) * dirMultiplier;
    rows.sort((a, b) => {
      if (sort.kind === "keyword") {
        return compareStrings(a.keyword, b.keyword);
      }
      if (sort.kind === "popularity") {
        return compareNumbers(a.popularity, b.popularity);
      }
      const aCell = a.cells.find((c) => c.appId === sort.appId);
      const bCell = b.cells.find((c) => c.appId === sort.appId);
      return compareNumbers(
        aCell?.currentPosition ?? null,
        bCell?.currentPosition ?? null
      );
    });
    return rows;
  }, [matrix, sort]);
}

const defaultSort: CompareSort = { kind: "keyword", dir: "asc" };

export function useCompareSort(initial?: CompareSort) {
  const [sort, setSort] = useState<CompareSort>(initial ?? defaultSort);
  const toggleSort = useCallback((next: CompareSort) => {
    setSort((current) => {
      if (
        current.kind === next.kind &&
        (current.kind !== "rank" ||
          (next.kind === "rank" && current.appId === next.appId))
      ) {
        return { ...current, dir: current.dir === "asc" ? "desc" : "asc" };
      }
      return next;
    });
  }, []);
  return { sort, setSort, toggleSort };
}
