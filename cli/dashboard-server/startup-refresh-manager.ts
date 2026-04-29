import type { StoredAppKeyword, StoredAsoKeyword } from "../db/types";
import { normalizeKeyword } from "../shared/aso-keyword-utils";
import {
  isCompleteStoredAsoKeyword,
  isStoredKeywordOrderFresh,
  isStoredKeywordPopularityFresh,
} from "../shared/aso-keyword-validity";

export type StartupRefreshStatus = "idle" | "running" | "completed" | "failed";

export type StartupRefreshCounters = {
  eligibleKeywordCount: number;
  refreshedKeywordCount: number;
  failedKeywordCount: number;
};

export type StartupRefreshState = {
  status: StartupRefreshStatus;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  requiresReauthentication: boolean;
  counters: StartupRefreshCounters;
};

export type KeywordRefreshItem = {
  keyword: string;
  popularity: number;
};

export const STARTUP_KEYWORD_REFRESH_BATCH_SIZE = 25;
const FOREGROUND_PAUSE_MS = 300;
const RETRY_DELAY_MS = 500;

type StartupRefreshDeps = {
  country: string;
  listKeywords: (country: string) => StoredAsoKeyword[];
  listAppKeywords: (country: string) => StoredAppKeyword[];
  listAssociatedAppIds: () => Set<string>;
  listOrderRelevantAppIds: () => Set<string>;
  enrichKeywords: (
    country: string,
    items: KeywordRefreshItem[]
  ) => Promise<unknown>;
  isForegroundBusy: () => boolean;
  reportError?: (error: unknown, metadata: Record<string, unknown>) => void;
  isAuthReauthRequiredError?: (error: unknown) => boolean;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  keywordBatchSize?: number;
};

export type StartupRefreshManager = {
  start: () => void;
  getState: () => StartupRefreshState;
};

export function selectKeywordRefreshCandidates(params: {
  keywords: StoredAsoKeyword[];
  appKeywords: StoredAppKeyword[];
  associatedAppIds: Set<string>;
  orderRelevantAppIds: Set<string>;
  nowMs: number;
}): KeywordRefreshItem[] {
  const associatedKeywords = new Set(
    params.appKeywords
      .filter((row) => params.associatedAppIds.has(row.appId))
      .map((row) => normalizeKeyword(row.keyword))
      .filter(Boolean)
  );
  const orderRelevantKeywords = new Set(
    params.appKeywords
      .filter((row) => params.orderRelevantAppIds.has(row.appId))
      .map((row) => normalizeKeyword(row.keyword))
      .filter(Boolean)
  );

  return params.keywords
    .filter((keyword) => associatedKeywords.has(keyword.normalizedKeyword))
    .filter(
      (keyword) =>
        typeof keyword.popularity === "number" &&
        Number.isFinite(keyword.popularity)
    )
    .filter((keyword) => {
      const orderFresh = isStoredKeywordOrderFresh(keyword, params.nowMs);
      const popularityFresh = isStoredKeywordPopularityFresh(
        keyword,
        params.nowMs
      );
      if (!isCompleteStoredAsoKeyword(keyword) || !popularityFresh) {
        return true;
      }
      if (!orderRelevantKeywords.has(keyword.normalizedKeyword)) {
        return false;
      }
      return !orderFresh;
    })
    .map((keyword) => ({
      keyword: keyword.keyword,
      popularity: keyword.popularity,
    }));
}

function chunkItems<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const chunkSize = Math.max(1, Math.floor(size));
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    result.push(items.slice(i, i + chunkSize));
  }
  return result;
}

function initialCounters(): StartupRefreshCounters {
  return {
    eligibleKeywordCount: 0,
    refreshedKeywordCount: 0,
    failedKeywordCount: 0,
  };
}

function initialState(): StartupRefreshState {
  return {
    status: "idle",
    startedAt: null,
    finishedAt: null,
    lastError: null,
    requiresReauthentication: false,
    counters: initialCounters(),
  };
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message;
  }
  const raw = String(error ?? "");
  return raw.trim() || "Background refresh failed.";
}

async function withOneRetry(
  operation: () => Promise<void>,
  sleep: (ms: number) => Promise<void>,
  shouldRetry?: (error: unknown) => boolean
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (shouldRetry?.(error) === false) {
      throw error;
    }
    await sleep(RETRY_DELAY_MS);
    await operation();
  }
}

export function createStartupRefreshManager(
  deps: StartupRefreshDeps
): StartupRefreshManager {
  const nowMs = () => deps.nowMs?.() ?? Date.now();
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const keywordBatchSize = Math.min(
    100,
    Math.max(1, deps.keywordBatchSize ?? STARTUP_KEYWORD_REFRESH_BATCH_SIZE)
  );

  let state: StartupRefreshState = initialState();
  let runPromise: Promise<void> | null = null;

  const setFailure = (error: unknown, metadata: Record<string, unknown>) => {
    if (!state.lastError) {
      state.lastError = errorToMessage(error);
      state.requiresReauthentication =
        deps.isAuthReauthRequiredError?.(error) === true;
    }
    deps.reportError?.(error, metadata);
  };

  const refreshKeywordsInBatches = async (): Promise<void> => {
    const items = selectKeywordRefreshCandidates({
      keywords: deps.listKeywords(deps.country),
      appKeywords: deps.listAppKeywords(deps.country),
      associatedAppIds: deps.listAssociatedAppIds(),
      orderRelevantAppIds: deps.listOrderRelevantAppIds(),
      nowMs: nowMs(),
    });
    state.counters.eligibleKeywordCount = items.length;
    if (items.length === 0) return;

    const batches = chunkItems(items, keywordBatchSize);
    for (const batch of batches) {
      while (deps.isForegroundBusy()) {
        await sleep(FOREGROUND_PAUSE_MS);
      }
      try {
        await withOneRetry(async () => {
          await deps.enrichKeywords(deps.country, batch);
        }, sleep, (error) => deps.isAuthReauthRequiredError?.(error) !== true);
        state.counters.refreshedKeywordCount += batch.length;
      } catch (error) {
        state.counters.failedKeywordCount += batch.length;
        setFailure(error, {
          phase: "startup-keyword-refresh",
          batchSize: batch.length,
          keywordPreview: batch.slice(0, 5).map((item) => item.keyword),
        });
      }
    }
  };

  const run = async (): Promise<void> => {
    state = {
      status: "running",
      startedAt: new Date(nowMs()).toISOString(),
      finishedAt: null,
      lastError: null,
      requiresReauthentication: false,
      counters: initialCounters(),
    };

    await refreshKeywordsInBatches();

    state = {
      ...state,
      status: state.lastError ? "failed" : "completed",
      finishedAt: new Date(nowMs()).toISOString(),
    };
  };

  return {
    start: () => {
      if (runPromise) return;
      runPromise = run()
        .catch((error) => {
          setFailure(error, { phase: "startup-refresh-unhandled" });
          state = {
            ...state,
            status: "failed",
            finishedAt: new Date(nowMs()).toISOString(),
          };
        })
        .finally(() => {
          runPromise = null;
        });
    },
    getState: () => ({
      ...state,
      counters: { ...state.counters },
    }),
  };
}
