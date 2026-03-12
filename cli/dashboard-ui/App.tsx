import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, Input } from "./ui-react";
import {
  DEFAULT_RESEARCH_APP_ID,
  isResearchAppId,
} from "../services/keywords/aso-research";
import {
  APP_STORE_ICON_IMAGE_URL,
  DEFAULT_ASO_COUNTRY,
  apiGet,
  apiWrite,
  authFlowErrorMessage,
  buildAppStoreUrl,
  buildTopAppRows,
  copyTextToClipboard,
  formatCalendarDate,
  formatCount,
  formatDate,
  formatRatingValue,
  formatSignedNumber,
  getBrowserLocale,
  getChange,
  getDashboardApiErrorCode,
  getIconUrl,
  getNumberDelta,
  isAuthFlowErrorCode,
  roundTo,
  toActionableErrorMessage,
} from "./app-helpers";

type AppItem = { id: string; name: string; lastKeywordAddedAt?: string | null };
type ManualAddType = "app" | "research";
type AppDoc = {
  appId: string;
  name: string;
  subtitle?: string;
  averageUserRating?: number | null;
  userRatingCount?: number | null;
  previousAverageUserRating?: number | null;
  previousUserRatingCount?: number | null;
  releaseDate?: string | null;
  currentVersionReleaseDate?: string | null;
  icon?: Record<string, unknown>;
  iconArtwork?: { url?: string; [key: string]: unknown };
  artworkUrl100?: string;
  artworkUrl512?: string;
};
type KeywordItem = {
  keyword: string;
  popularity: number;
  difficultyScore: number | null;
  appCount: number | null;
  updatedAt?: string;
  keywordStatus?: "ok" | "pending" | "failed";
  orderedAppIds?: string[];
  positions?: Array<{ appId: string; previousPosition: number | null; currentPosition: number | null }>;
};
type KeywordDetails = {
  keyword: string;
  appDocs: AppDoc[];
};

type SortKey = "keyword" | "popularity" | "difficulty" | "appCount" | "rank" | "change" | "updatedAt";
type SortDir = "asc" | "desc";
type FilterMenuKey = "popularity" | "difficulty" | "rank";
type KeywordActionMenuState = {
  x: number;
  y: number;
  keywords: string[];
};

type Row = {
  keyword: string;
  popularity: number;
  difficultyScore: number | null;
  appCount: number | null;
  updatedAt?: string;
  previousPosition: number | null;
  currentPosition: number | null;
};
type TopAppRow = AppDoc & {
  rank: number;
};

const DEFAULT_SORT_DIRECTION_BY_KEY: Record<SortKey, SortDir> = {
  keyword: "asc",
  popularity: "desc",
  difficulty: "desc",
  appCount: "desc",
  rank: "asc",
  change: "asc",
  updatedAt: "desc",
};

const POPULARITY_OPTIONS = [0, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
const DIFFICULTY_OPTIONS = [0, 5, 10, 20, 30, 40, 50, 70, 100];
const RANK_OPTIONS = [0, 5, 10, 20, 30, 40, 50, 75, 100, 150, 200, 201];

const DEFAULT_MIN_POPULARITY = 0;
const DEFAULT_MAX_DIFFICULTY = 100;
const DEFAULT_MIN_RANK = 0;
const DEFAULT_MAX_RANK = 201;
const TOP_APPS_DIALOG_LIMIT = 10;
const SELECTED_APP_STORAGE_KEY = "aso-dashboard:selected-app-id";
const MOBILE_BREAKPOINT = "(max-width: 980px)";
const STATUS_MESSAGE_TIMEOUT_MS = 4000;
const STARTUP_REFRESH_STATUS_POLL_INTERVAL_SECONDS = 10;

type DashboardAuthStatus = "idle" | "in_progress" | "failed" | "succeeded";

type DashboardAuthStatusPayload = {
  status: DashboardAuthStatus;
  updatedAt: string | null;
  lastError: string | null;
  requiresTerminalAction: boolean;
  canPrompt: boolean;
};

type StartupRefreshStatus = "idle" | "running" | "completed" | "failed";

type StartupRefreshStatusPayload = {
  status: StartupRefreshStatus;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  counters: {
    eligibleKeywordCount: number;
    refreshedKeywordCount: number;
    failedKeywordCount: number;
  };
};

type PendingAddContext = {
  keywords: string[];
};

type AddedAppPayload = {
  id: string;
  name: string;
};

function FilterIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M8 9h8M7 12h5M14 12h3M9 15h8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="13" cy="12" r="1.1" fill="currentColor" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M15 9V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M20 6L9 17l-5-5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function App() {
  const [apps, setApps] = useState<AppItem[]>([]);
  const [appDocsById, setAppDocsById] = useState<Record<string, AppDoc>>({});
  const [selectedAppId, setSelectedAppId] = useState(() => {
    if (typeof window === "undefined") return DEFAULT_RESEARCH_APP_ID;
    try {
      return (
        localStorage.getItem(SELECTED_APP_STORAGE_KEY) || DEFAULT_RESEARCH_APP_ID
      );
    } catch {
      return DEFAULT_RESEARCH_APP_ID;
    }
  });
  const [keywords, setKeywords] = useState<Row[]>([]);
  const [failedKeywordCount, setFailedKeywordCount] = useState(0);
  const [selectedKeywords, setSelectedKeywords] = useState<Set<string>>(new Set());
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);

  const [keywordFilter, setKeywordFilter] = useState("");
  const [maxDifficulty, setMaxDifficulty] = useState(DEFAULT_MAX_DIFFICULTY);
  const [minPopularity, setMinPopularity] = useState(DEFAULT_MIN_POPULARITY);
  const [minRank, setMinRank] = useState(DEFAULT_MIN_RANK);
  const [maxRank, setMaxRank] = useState(DEFAULT_MAX_RANK);
  const [sortBy, setSortBy] = useState<SortKey>("rank");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [openFilterMenu, setOpenFilterMenu] = useState<FilterMenuKey | null>(null);
  const [keywordActionMenu, setKeywordActionMenu] = useState<KeywordActionMenuState | null>(null);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isCompactLayout, setIsCompactLayout] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(MOBILE_BREAKPOINT).matches;
  });
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const [hasCachedData, setHasCachedData] = useState(false);
  const [isAddingKeywords, setIsAddingKeywords] = useState(false);
  const [isRetryingFailedKeywords, setIsRetryingFailedKeywords] = useState(false);
  const [loadingText, setLoadingText] = useState("");
  const [errorText, setErrorText] = useState("");
  const [successText, setSuccessText] = useState("");
  const [copiedAppId, setCopiedAppId] = useState<string | null>(null);
  const [addInput, setAddInput] = useState("");
  const [addAppMode, setAddAppMode] = useState<ManualAddType>("app");
  const [addAppInput, setAddAppInput] = useState("");
  const [isAddingApp, setIsAddingApp] = useState(false);
  const [isAddAppPopoverOpen, setIsAddAppPopoverOpen] = useState(false);
  const [topAppsKeyword, setTopAppsKeyword] = useState<string | null>(null);
  const [topAppsRows, setTopAppsRows] = useState<TopAppRow[]>([]);
  const [topAppsLoading, setTopAppsLoading] = useState(false);
  const [topAppsError, setTopAppsError] = useState("");
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authStatus, setAuthStatus] = useState<DashboardAuthStatus>("idle");
  const [authCanPrompt, setAuthCanPrompt] = useState(true);
  const [authNeedsTerminalAction, setAuthNeedsTerminalAction] = useState(false);
  const [authStatusError, setAuthStatusError] = useState("");
  const [isStartingAuth, setIsStartingAuth] = useState(false);
  const [pendingAddContext, setPendingAddContext] = useState<PendingAddContext | null>(null);
  const [startupRefreshState, setStartupRefreshState] =
    useState<StartupRefreshStatusPayload | null>(null);
  const [displayLocale] = useState(() => getBrowserLocale());
  const isInitializedRef = useRef(false);
  const keywordLoadRequestIdRef = useRef(0);
  const selectedAppIdRef = useRef(selectedAppId);
  const autoRetryInFlightRef = useRef(false);
  const startupAppSyncAtRef = useRef<string | null>(null);

  const selectedAppName =
    apps.find((app) => app.id === selectedAppId)?.name ??
    (isResearchAppId(selectedAppId) ? "Research" : selectedAppId);
  const isSelectedAppResearch = isResearchAppId(selectedAppId);
  const showRankingColumns = !isSelectedAppResearch;
  const researchApps = apps.filter((app) => isResearchAppId(app.id));
  const ownedApps = apps.filter((app) => !isResearchAppId(app.id));
  const emptyStateText =
    keywords.length === 0
      ? "No keywords yet for this app."
      : "No keywords match the current search/filters.";

  const refreshAppDocs = useCallback(async (
    list: AppItem[],
    options?: { forceRefresh?: boolean }
  ): Promise<void> => {
    const owned = list.filter((app) => !isResearchAppId(app.id));
    if (owned.length === 0) {
      setAppDocsById({});
      return;
    }
    const ids = owned.map((a) => a.id).join(",");
    const refreshParam = options?.forceRefresh ? "&refresh=true" : "";
    const docs = await apiGet<AppDoc[]>(
      `/api/aso/apps?country=${DEFAULT_ASO_COUNTRY}&ids=${encodeURIComponent(ids)}${refreshParam}`
    );
    setAppDocsById(Object.fromEntries(docs.map((d) => [d.appId, d])));
  }, []);

  const loadApps = useCallback(async (options?: {
    forceRefreshDocs?: boolean;
    refreshDocsInBackground?: boolean;
  }): Promise<AppItem[]> => {
    const list = await apiGet<AppItem[]>(`/api/apps`);
    setApps(list);
    setAppDocsById((prev) => {
      if (!prev || Object.keys(prev).length === 0) return prev;
      const keepIds = new Set(list.filter((app) => !isResearchAppId(app.id)).map((app) => app.id));
      const nextEntries = Object.entries(prev).filter(([appId]) => keepIds.has(appId));
      return Object.fromEntries(nextEntries);
    });

    const refreshDocsInBackground = options?.refreshDocsInBackground ?? false;
    if (refreshDocsInBackground) {
      void refreshAppDocs(list, { forceRefresh: options?.forceRefreshDocs }).catch(() => {});
    } else {
      await refreshAppDocs(list, { forceRefresh: options?.forceRefreshDocs });
    }
    return list;
  }, [refreshAppDocs]);

  const loadKeywords = useCallback(async (appId: string) => {
    const requestId = ++keywordLoadRequestIdRef.current;
    const data = await apiGet<KeywordItem[]>(
      `/api/aso/keywords?country=${DEFAULT_ASO_COUNTRY}&appId=${encodeURIComponent(appId)}`
    );
    if (requestId !== keywordLoadRequestIdRef.current) return;
    const rows = data.map((item) => {
      const p = (item.positions ?? []).find((x) => x.appId === appId);
      return {
        keyword: item.keyword,
        popularity: item.popularity,
        difficultyScore: item.difficultyScore,
        appCount: item.appCount,
        updatedAt: item.updatedAt,
        previousPosition: p?.previousPosition ?? null,
        currentPosition: p?.currentPosition ?? null,
      } satisfies Row;
    });
    setKeywords(rows);
    setFailedKeywordCount(
      data.filter((item) => item.keywordStatus === "failed").length
    );
    const keep = new Set(rows.map((r) => r.keyword));
    setSelectedKeywords((prev) => {
      const next = new Set(Array.from(prev).filter((kw) => keep.has(kw)));
      return next;
    });
    setSelectionAnchor((prev) => (prev && !keep.has(prev) ? null : prev));
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        setLoadingText("Loading dashboard...");
        const list = await loadApps({ refreshDocsInBackground: true });
        setHasCachedData(true);
        let activeAppId = selectedAppIdRef.current;
        if (
          activeAppId === DEFAULT_RESEARCH_APP_ID &&
          !list.some((a) => a.id === activeAppId)
        ) {
          const firstResearch = list.find((a) => isResearchAppId(a.id));
          if (firstResearch) {
            activeAppId = firstResearch.id;
            setSelectedAppId(firstResearch.id);
          }
        }
        if (activeAppId !== DEFAULT_RESEARCH_APP_ID && !list.some((a) => a.id === activeAppId)) {
          activeAppId = DEFAULT_RESEARCH_APP_ID;
          setSelectedAppId(DEFAULT_RESEARCH_APP_ID);
        }
        await loadKeywords(activeAppId);
      } catch (error) {
        setErrorText(toActionableErrorMessage(error, "Failed to load dashboard"));
      } finally {
        isInitializedRef.current = true;
        setIsInitialLoad(false);
        setLoadingText("");
      }
    })();
  }, [loadApps, loadKeywords]);

  useEffect(() => {
    selectedAppIdRef.current = selectedAppId;
  }, [selectedAppId]);

  useEffect(() => {
    if (!isInitializedRef.current) return;
    void loadKeywords(selectedAppId).catch((error) => {
      setErrorText(toActionableErrorMessage(error, "Failed to load keywords"));
    });
  }, [selectedAppId, loadKeywords]);

  useEffect(() => {
    document.title = `ASO Dashboard - ${selectedAppName}`;
  }, [selectedAppName]);

  useEffect(() => {
    try {
      localStorage.setItem(SELECTED_APP_STORAGE_KEY, selectedAppId);
    } catch {
      // no-op
    }
  }, [selectedAppId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia(MOBILE_BREAKPOINT);
    const update = (event?: MediaQueryListEvent) => {
      setIsCompactLayout(event ? event.matches : media.matches);
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!startupRefreshState) return;
    if (startupRefreshState.status !== "completed") return;
    if (!startupRefreshState.finishedAt) return;
    if (startupAppSyncAtRef.current === startupRefreshState.finishedAt) return;

    startupAppSyncAtRef.current = startupRefreshState.finishedAt;
    void loadApps().catch(() => {});
  }, [startupRefreshState, loadApps]);

  useEffect(() => {
    if (isCompactLayout && sidebarCollapsed) {
      setSidebarCollapsed(false);
    }
  }, [isCompactLayout, sidebarCollapsed]);

  useEffect(() => {
    if (!errorText || loadingText !== "") return;
    const timeout = window.setTimeout(() => setErrorText(""), STATUS_MESSAGE_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [errorText, loadingText]);

  useEffect(() => {
    if (!successText || loadingText !== "") return;
    const timeout = window.setTimeout(() => setSuccessText(""), STATUS_MESSAGE_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [successText, loadingText]);

  useEffect(() => {
    if (!copiedAppId) return;
    const timeout = window.setTimeout(() => setCopiedAppId(null), 1500);
    return () => window.clearTimeout(timeout);
  }, [copiedAppId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setSelectedKeywords(new Set(keywords.map((row) => row.keyword)));
        setSelectionAnchor(keywords.length > 0 ? keywords[0].keyword : null);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [keywords]);

  useEffect(() => {
    if (!openFilterMenu) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".filter-dropdown")) return;
      setOpenFilterMenu(null);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenFilterMenu(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onEscape);
    };
  }, [openFilterMenu]);

  useEffect(() => {
    if (!keywordActionMenu) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".keyword-action-menu")) return;
      setKeywordActionMenu(null);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setKeywordActionMenu(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onEscape);
    };
  }, [keywordActionMenu]);

  useEffect(() => {
    if (!topAppsKeyword) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTopAppsKeyword(null);
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [topAppsKeyword]);

  useEffect(() => {
    let isActive = true;
    let intervalId: number | null = null;

    const pollStatus = async (): Promise<void> => {
      try {
        const data = await apiGet<StartupRefreshStatusPayload>("/api/aso/refresh-status");
        if (!isActive) return;
        setStartupRefreshState(data);
        if (
          intervalId != null &&
          data.status !== "idle" &&
          data.status !== "running"
        ) {
          window.clearInterval(intervalId);
          intervalId = null;
        }
      } catch {
        if (!isActive) return;
      }
    };

    void pollStatus();
    intervalId = window.setInterval(
      () => {
        void pollStatus();
      },
      STARTUP_REFRESH_STATUS_POLL_INTERVAL_SECONDS * 1000
    );

    return () => {
      isActive = false;
      if (intervalId != null) {
        window.clearInterval(intervalId);
      }
    };
  }, []);

  const hasPendingDifficulty = useMemo(
    () => keywords.some((row) => row.difficultyScore == null),
    [keywords]
  );

  const copyAppId = useCallback(async (appId: string) => {
    try {
      await navigator.clipboard.writeText(appId);
      setCopiedAppId(appId);
    } catch {
      setErrorText("Failed to copy app ID.");
    }
  }, []);

  useEffect(() => {
    if (!hasPendingDifficulty) return;
    const id = window.setInterval(() => {
      void loadKeywords(selectedAppId).catch(() => {});
    }, 3000);
    return () => window.clearInterval(id);
  }, [hasPendingDifficulty, loadKeywords, selectedAppId]);

  const filteredRows = useMemo(() => {
    const term = keywordFilter.trim().toLowerCase();
    const hasPopularityMinBound = minPopularity > 0;
    const hasDifficultyMaxBound = maxDifficulty < DEFAULT_MAX_DIFFICULTY;
    const hasRankLowerBound = minRank > 0;
    const hasRankUpperBound = maxRank !== DEFAULT_MAX_RANK;
    const hasRankFilter = showRankingColumns && (hasRankLowerBound || hasRankUpperBound);

    let rows = keywords.filter((row) => {
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
          return compareNullable(a.updatedAt ? new Date(a.updatedAt).getTime() : null, b.updatedAt ? new Date(b.updatedAt).getTime() : null);
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
  }, [keywords, keywordFilter, maxDifficulty, minPopularity, minRank, maxRank, showRankingColumns, sortBy, sortDir]);

  useEffect(() => {
    if (showRankingColumns) return;
    if (sortBy !== "rank" && sortBy !== "change" && sortBy !== "updatedAt") return;
    setSortBy("keyword");
    setSortDir(DEFAULT_SORT_DIRECTION_BY_KEY.keyword);
  }, [showRankingColumns, sortBy]);

  const onSelectRow = (rowKeyword: string, rowIndex: number, event: React.MouseEvent<HTMLTableRowElement>) => {
    setKeywordActionMenu(null);
    if (event.shiftKey && selectionAnchor) {
      const start = filteredRows.findIndex((r) => r.keyword === selectionAnchor);
      if (start >= 0) {
        const [from, to] = start <= rowIndex ? [start, rowIndex] : [rowIndex, start];
        const next = new Set<string>();
        for (let i = from; i <= to; i++) next.add(filteredRows[i].keyword);
        setSelectedKeywords(next);
        return;
      }
    }

    if (event.metaKey || event.ctrlKey) {
      setSelectedKeywords((prev) => {
        const next = new Set(prev);
        if (next.has(rowKeyword)) next.delete(rowKeyword);
        else next.add(rowKeyword);
        return next;
      });
      setSelectionAnchor(rowKeyword);
      return;
    }

    if (selectedKeywords.size === 1 && selectedKeywords.has(rowKeyword)) {
      setSelectedKeywords(new Set());
      setSelectionAnchor(null);
      return;
    }

    setSelectedKeywords(new Set([rowKeyword]));
    setSelectionAnchor(rowKeyword);
  };

  const onContextDelete = async (selected: string[]) => {
    const label = selected.length === 1 ? `\"${selected[0]}\"` : `${selected.length} keywords`;
    if (!window.confirm(`Delete ${label} from ${selectedAppName}?`)) return;

    try {
      setErrorText("");
      setSuccessText("");
      setLoadingText(`Deleting ${selected.length} keyword${selected.length === 1 ? "" : "s"}...`);
      await apiWrite("DELETE", "/api/aso/keywords", {
        appId: selectedAppId,
        keywords: selected,
        country: DEFAULT_ASO_COUNTRY,
      });
      setSelectedKeywords(new Set());
      setSelectionAnchor(null);
      setSuccessText(`Deleted ${selected.length} keyword${selected.length === 1 ? "" : "s"}.`);
      await loadApps();
      await loadKeywords(selectedAppId);
    } catch (error) {
      setErrorText(toActionableErrorMessage(error, "Failed to delete keywords"));
    } finally {
      setLoadingText("");
    }
  };

  const onContextCopy = useCallback(async (selected: string[]) => {
    try {
      setErrorText("");
      setSuccessText("");
      await copyTextToClipboard(selected.join(","));
      setSuccessText(
        `Copied ${selected.length} keyword${selected.length === 1 ? "" : "s"} as comma-separated text.`
      );
    } catch (error) {
      setErrorText(toActionableErrorMessage(error, "Failed to copy keywords"));
    }
  }, []);

  const getContextSelection = useCallback(
    (rowKeyword: string): string[] => {
      if (selectedKeywords.has(rowKeyword) && selectedKeywords.size > 0) {
        return filteredRows
          .map((row) => row.keyword)
          .filter((keyword) => selectedKeywords.has(keyword));
      }
      return [rowKeyword];
    },
    [filteredRows, selectedKeywords]
  );

  const onContextMenuOpen = useCallback(
    (event: React.MouseEvent<HTMLTableRowElement>, rowKeyword: string) => {
      event.preventDefault();
      event.stopPropagation();

      const selected = getContextSelection(rowKeyword);
      setSelectedKeywords(new Set(selected));
      setSelectionAnchor(rowKeyword);
      setOpenFilterMenu(null);

      const menuWidth = 190;
      const menuHeight = 96;
      const padding = 8;
      const maxX = Math.max(padding, window.innerWidth - menuWidth - padding);
      const maxY = Math.max(padding, window.innerHeight - menuHeight - padding);
      const x = Math.min(Math.max(event.clientX, padding), maxX);
      const y = Math.min(Math.max(event.clientY, padding), maxY);
      setKeywordActionMenu({ x, y, keywords: selected });
    },
    [getContextSelection]
  );

  const onContextAction = useCallback(
    async (action: "copy" | "delete") => {
      if (!keywordActionMenu) return;
      const selected = keywordActionMenu.keywords;
      setKeywordActionMenu(null);
      if (action === "copy") {
        await onContextCopy(selected);
        return;
      }
      await onContextDelete(selected);
    },
    [keywordActionMenu, onContextCopy]
  );

  useEffect(() => {
    if (!isStartingAuth && authStatus !== "in_progress") return;
    let isActive = true;
    const pollStatus = async () => {
      try {
        const data = await apiGet<DashboardAuthStatusPayload>("/api/aso/auth/status");
        if (!isActive) return;
        setAuthStatus(data.status);
        setAuthCanPrompt(data.canPrompt);
        setAuthNeedsTerminalAction(Boolean(data.requiresTerminalAction));
        if (data.status === "failed") {
          setAuthStatusError(data.lastError?.trim() || "Reauthentication failed.");
          return;
        }
        if (data.status === "succeeded") {
          setAuthStatusError("");
          return;
        }
      } catch {
        if (!isActive) return;
      }
    };

    void pollStatus();
    const timerId = window.setInterval(() => {
      void pollStatus();
    }, 1500);

    return () => {
      isActive = false;
      window.clearInterval(timerId);
    };
  }, [authStatus, isStartingAuth]);

  const openAuthModalForPendingAdd = useCallback(
    (error: unknown, keywords: string[]): boolean => {
      const errorCode = getDashboardApiErrorCode(error);
      if (!isAuthFlowErrorCode(errorCode)) return false;
      setPendingAddContext({ keywords });
      if (errorCode === "AUTH_IN_PROGRESS") {
        setAuthStatus("in_progress");
        setAuthCanPrompt(true);
        setAuthNeedsTerminalAction(false);
        setAuthStatusError("");
      } else if (errorCode === "TTY_REQUIRED") {
        setAuthStatus("failed");
        setAuthCanPrompt(false);
        setAuthNeedsTerminalAction(true);
        setAuthStatusError(authFlowErrorMessage(errorCode));
      } else {
        setAuthStatus("idle");
        setAuthCanPrompt(true);
        setAuthNeedsTerminalAction(false);
        setAuthStatusError("");
      }
      return true;
    },
    []
  );

  const submitKeywords = useCallback(
    async (kws: string[]): Promise<boolean> => {
      try {
        setIsAddingKeywords(true);
        setErrorText("");
        setSuccessText("");
        setLoadingText(`Adding ${kws.length} keyword${kws.length === 1 ? "" : "s"}...`);
        await apiWrite("POST", "/api/aso/keywords", {
          appId: selectedAppId,
          keywords: kws,
          country: DEFAULT_ASO_COUNTRY,
        });
        setAddInput("");
        setSuccessText("");
        setPendingAddContext(null);
        setAuthNeedsTerminalAction(false);
        setAuthModalOpen(false);
        await loadApps();
        await loadKeywords(selectedAppId);
        return true;
      } catch (error) {
        if (openAuthModalForPendingAdd(error, kws)) return false;
        setErrorText(toActionableErrorMessage(error, "Failed to add keywords"));
        return false;
      } finally {
        setIsAddingKeywords(false);
        setLoadingText("");
      }
    },
    [selectedAppId, loadApps, loadKeywords, openAuthModalForPendingAdd]
  );

  const onAddKeywords = async (event: React.FormEvent) => {
    event.preventDefault();
    const kws = addInput
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean)
      .filter((k, idx, arr) => arr.findIndex((x) => x.toLowerCase() === k.toLowerCase()) === idx);
    const existingKeywords = new Set(keywords.map((row) => row.keyword.trim().toLowerCase()));
    const kwsToAdd = kws.filter((keyword) => !existingKeywords.has(keyword.toLowerCase()));

    if (kws.length === 0) {
      setErrorText("Please add at least one keyword.");
      return;
    }
    if (kws.length > 100) {
      setErrorText("A maximum of 100 keywords is supported per request.");
      return;
    }

    if (kwsToAdd.length === 0) {
      setErrorText("");
      setSuccessText("");
      setAddInput("");
      return;
    }

    await submitKeywords(kwsToAdd);
  };

  const onRetryFailedKeywords = useCallback(async () => {
    if (failedKeywordCount <= 0) return;
    try {
      setIsRetryingFailedKeywords(true);
      setErrorText("");
      setSuccessText("");
      setLoadingText(`Retrying ${failedKeywordCount} failed keyword${failedKeywordCount === 1 ? "" : "s"}...`);
      const result = await apiWrite<{
        retriedCount: number;
        succeededCount: number;
        failedCount: number;
      }>("POST", "/api/aso/keywords/retry-failed", {
        appId: selectedAppId,
        country: DEFAULT_ASO_COUNTRY,
      });
      await loadKeywords(selectedAppId);
      setSuccessText(
        `Retried ${result.retriedCount} failed keywords: ${result.succeededCount} succeeded, ${result.failedCount} still failed.`
      );
    } catch (error) {
      setErrorText(toActionableErrorMessage(error, "Failed to retry failed keywords"));
    } finally {
      setIsRetryingFailedKeywords(false);
      setLoadingText("");
    }
  }, [failedKeywordCount, loadKeywords, selectedAppId]);

  const onStartReauthentication = useCallback(async () => {
    try {
      setIsStartingAuth(true);
      setAuthStatus("in_progress");
      setAuthNeedsTerminalAction(false);
      setAuthStatusError("");
      const data = await apiWrite<DashboardAuthStatusPayload>("POST", "/api/aso/auth/start", {});
      setAuthStatus(data.status);
      setAuthCanPrompt(data.canPrompt);
      setAuthNeedsTerminalAction(Boolean(data.requiresTerminalAction));
    } catch (error) {
      const errorCode = getDashboardApiErrorCode(error);
      if (isAuthFlowErrorCode(errorCode)) {
        setAuthStatusError(authFlowErrorMessage(errorCode));
        if (errorCode === "AUTH_IN_PROGRESS") {
          setAuthStatus("in_progress");
          setAuthCanPrompt(true);
          setAuthNeedsTerminalAction(false);
        } else if (errorCode === "TTY_REQUIRED") {
          setAuthStatus("failed");
          setAuthCanPrompt(false);
          setAuthNeedsTerminalAction(true);
        }
        return;
      }
      setAuthStatus("failed");
      setAuthNeedsTerminalAction(false);
      setAuthStatusError(toActionableErrorMessage(error, "Failed to start reauthentication."));
    } finally {
      setIsStartingAuth(false);
    }
  }, []);

  useEffect(() => {
    if (!pendingAddContext) return;
    if (authStatus !== "idle") return;
    if (!authCanPrompt) return;
    if (isStartingAuth) return;
    void onStartReauthentication();
  }, [
    pendingAddContext,
    authStatus,
    authCanPrompt,
    isStartingAuth,
    onStartReauthentication,
  ]);

  useEffect(() => {
    if (authStatus !== "succeeded") return;
    if (!pendingAddContext) return;
    if (autoRetryInFlightRef.current) return;

    autoRetryInFlightRef.current = true;
    void submitKeywords(pendingAddContext.keywords).finally(() => {
      autoRetryInFlightRef.current = false;
    });
  }, [authStatus, pendingAddContext, submitKeywords]);

  useEffect(() => {
    if (!pendingAddContext) {
      setAuthModalOpen(false);
      return;
    }
    if (!authCanPrompt) {
      setAuthModalOpen(true);
      return;
    }
    if (authStatus === "failed") {
      setAuthModalOpen(true);
      return;
    }
    if (authNeedsTerminalAction) {
      setAuthModalOpen(true);
      return;
    }
    setAuthModalOpen(false);
  }, [pendingAddContext, authCanPrompt, authStatus, authNeedsTerminalAction]);

  const onAddApp = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = addAppInput.trim();
    if (!value) {
      setErrorText(addAppMode === "app" ? "Please provide an app ID." : "Please provide a research name.");
      return;
    }
    if (addAppMode === "app" && !/^\d+$/.test(value)) {
      setErrorText("App ID must be numeric.");
      return;
    }

    try {
      setErrorText("");
      setSuccessText("");
      setIsAddingApp(true);
      setLoadingText(addAppMode === "app" ? "Adding app..." : "Adding research app...");
      const payload = addAppMode === "app"
        ? { type: "app" as const, appId: value }
        : { type: "research" as const, name: value };
      const added = await apiWrite<AddedAppPayload>("POST", "/api/apps", payload);
      const list = await loadApps();
      const addedId = added.id;
      const selected = list.find((app) => app.id === addedId);
      if (selected) {
        setSelectedAppId(selected.id);
        await loadKeywords(selected.id);
      } else {
        await loadKeywords(selectedAppIdRef.current);
      }
      setAddAppInput("");
      setIsAddAppPopoverOpen(false);
      setSuccessText(addAppMode === "app" ? "App added." : "Research app added.");
    } catch (error) {
      setErrorText(toActionableErrorMessage(error, "Failed to add app"));
    } finally {
      setIsAddingApp(false);
      setLoadingText("");
    }
  };

  const onOpenTopApps = async (rowKeyword: string) => {
    setTopAppsKeyword(rowKeyword);
    setTopAppsRows([]);
    setTopAppsError("");
    setTopAppsLoading(true);
    try {
      const data = await apiGet<KeywordDetails>(
        `/api/aso/top-apps?country=${DEFAULT_ASO_COUNTRY}&keyword=${encodeURIComponent(rowKeyword)}&limit=${TOP_APPS_DIALOG_LIMIT}`
      );
      setTopAppsRows(buildTopAppRows(data));
    } catch (error) {
      setTopAppsError(toActionableErrorMessage(error, "Failed to load top apps"));
    } finally {
      setTopAppsLoading(false);
    }
  };

  const onSortHeader = (key: SortKey) => {
    if (sortBy === key) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
      return;
    }
    setSortBy(key);
    setSortDir(DEFAULT_SORT_DIRECTION_BY_KEY[key]);
  };

  const renderSortLabel = (label: string) => {
    return (
      <span className="sort-label">
        <span>{label}</span>
      </span>
    );
  };

  const setPopularityMinValue = (value: number) => {
    setMinPopularity(value);
  };

  const setRankMinValue = (value: number) => {
    setMinRank(value);
    if (value > maxRank) setMaxRank(value);
  };

  const setRankMaxValue = (value: number) => {
    setMaxRank(value);
    if (value < minRank) setMinRank(value);
  };

  const formatRankValue = (value: number) => (value === DEFAULT_MAX_RANK ? "200+" : String(value));

  const rankFilterLabel = useMemo(() => {
    const hasMin = minRank !== DEFAULT_MIN_RANK;
    const hasMax = maxRank !== DEFAULT_MAX_RANK;
    if (!hasMin && !hasMax) return null;
    if (hasMin && hasMax) return `${formatRankValue(minRank)}-${formatRankValue(maxRank)}`;
    if (hasMin) return `>${formatRankValue(minRank)}`;
    return `<${formatRankValue(maxRank)}`;
  }, [minRank, maxRank]);

  const getFilterLabel = (key: FilterMenuKey): string | null => {
    switch (key) {
      case "popularity":
        return minPopularity !== DEFAULT_MIN_POPULARITY ? `>${minPopularity}` : null;
      case "difficulty":
        return maxDifficulty !== DEFAULT_MAX_DIFFICULTY ? `<${maxDifficulty}` : null;
      case "rank":
        return rankFilterLabel;
    }
  };

  const renderFilterMenu = (key: FilterMenuKey) => {
    if (key === "popularity") {
      return (
        <div className="filter-menu-content">
          <p className="filter-menu-label">Minimum popularity</p>
          <div className="filter-options-vertical">
            {POPULARITY_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                className={option === minPopularity ? "active" : ""}
                onClick={() => {
                  if (option === minPopularity) setPopularityMinValue(DEFAULT_MIN_POPULARITY);
                  else setPopularityMinValue(option);
                  setOpenFilterMenu(null);
                }}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      );
    }

    if (key === "difficulty") {
      return (
        <div className="filter-menu-content">
          <p className="filter-menu-label">Maximum difficulty</p>
          <div className="filter-options-vertical">
            {DIFFICULTY_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                className={option === maxDifficulty ? "active" : ""}
                onClick={() => {
                  if (option === maxDifficulty) setMaxDifficulty(DEFAULT_MAX_DIFFICULTY);
                  else setMaxDifficulty(option);
                  setOpenFilterMenu(null);
                }}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      );
    }

    return (
      <div className="filter-menu-content rank-filter-menu">
        <div className="filter-menu-split">
          <div className="filter-menu-section">
            <p className="filter-menu-label">Minimum rank</p>
            <div className="filter-options-vertical">
              {RANK_OPTIONS.map((option) => (
                <button
                  key={`min-${option}`}
                  type="button"
                  className={option === minRank ? "active" : ""}
                  onClick={() => {
                    if (option === minRank) setRankMinValue(DEFAULT_MIN_RANK);
                    else setRankMinValue(option);
                  }}
                >
                  {formatRankValue(option)}
                </button>
              ))}
            </div>
          </div>
          <div className="filter-menu-section">
            <p className="filter-menu-label">Maximum rank</p>
            <div className="filter-options-vertical">
              {RANK_OPTIONS.map((option) => (
                <button
                  key={`max-${option}`}
                  type="button"
                  className={option === maxRank ? "active" : ""}
                  onClick={() => {
                    if (option === maxRank) setRankMaxValue(DEFAULT_MAX_RANK);
                    else setRankMaxValue(option);
                  }}
                >
                  {formatRankValue(option)}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderFilterDropdown = (key: FilterMenuKey, label: string) => {
    const applied = getFilterLabel(key);
    const isOpen = openFilterMenu === key;
    return (
      <div className={`filter-dropdown ${isOpen ? "open" : ""}`}>
        <button
          type="button"
          className={`filter-trigger ${applied ? "active" : ""}`}
          aria-label={`${label} filter`}
          aria-expanded={isOpen}
          onClick={(event) => {
            event.stopPropagation();
            setOpenFilterMenu((prev) => (prev === key ? null : key));
          }}
        >
          {applied ? <span className="filter-trigger-value">{applied}</span> : <FilterIcon />}
        </button>
        {isOpen ? <div className="filter-dropdown-menu">{renderFilterMenu(key)}</div> : null}
      </div>
    );
  };

  const showLoading = loadingText !== "";
  const isColdStart = isInitialLoad && !hasCachedData;
  const isAnyAppMutationInFlight = isAddingApp;
  const showError = !showLoading && errorText !== "";
  const showSuccess = !showLoading && !showError && successText !== "";
  const addButtonLabel = isCompactLayout ? "Add" : "Add Keywords";
  const authStatusLabel =
    !authCanPrompt
      ? "Open dashboard from terminal to authenticate."
      : authNeedsTerminalAction
        ? "Complete reauthentication in the terminal that launched the dashboard."
        : authStatus === "failed"
          ? "Reauthentication failed. Try again."
          : "";
  const canStartReauth = authCanPrompt && !isStartingAuth;
  const showReauthButton = authStatus === "failed" && authCanPrompt;
  const startupRefreshMessage = useMemo(() => {
    if (!startupRefreshState) return null;
    if (startupRefreshState.status === "running") {
      const { eligibleKeywordCount, refreshedKeywordCount } =
        startupRefreshState.counters;
      if (eligibleKeywordCount > 0) {
        return `Refreshing local data in background (${refreshedKeywordCount}/${eligibleKeywordCount} keywords)...`;
      }
      return "Refreshing local data in background...";
    }
    return null;
  }, [startupRefreshState]);
  const hasRankFiltersApplied =
    showRankingColumns &&
    (minRank !== DEFAULT_MIN_RANK || maxRank !== DEFAULT_MAX_RANK);
  const hasFilters =
    keywordFilter.trim() !== "" ||
    maxDifficulty !== DEFAULT_MAX_DIFFICULTY ||
    minPopularity !== DEFAULT_MIN_POPULARITY ||
    hasRankFiltersApplied;

  return (
    <div id="app-shell" className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar ui-card" aria-label="Apps">
        <div className="sidebar-header">
          <div className="sidebar-header-top">
            <h1>ASO Dashboard</h1>
            <Button
              id="toggle-sidebar"
              className={isCompactLayout ? "hidden" : ""}
              variant="outline"
              size="sm"
              type="button"
              aria-label="Toggle sidebar"
              onClick={() => setSidebarCollapsed((prev) => !prev)}
            >
              {sidebarCollapsed ? "»" : "«"}
            </Button>
          </div>
          <p className="sidebar-subtitle">Keyword performance by app</p>
          <div className="sidebar-actions">
            <Button
              id="add-app-toggle"
              type="button"
              aria-expanded={isAddAppPopoverOpen}
              aria-label="Add app"
              onClick={() => setIsAddAppPopoverOpen(true)}
            >
              +
            </Button>
          </div>
        </div>

        <div className="apps-list" role="tablist" aria-label="Applications">
          <section className="apps-section">
            <p className="apps-section-title">Research</p>
            {researchApps.length === 0 ? (
              <button
                className={`app-item ${selectedAppId === DEFAULT_RESEARCH_APP_ID ? "active" : ""}`}
                data-app-id={DEFAULT_RESEARCH_APP_ID}
                role="tab"
                aria-selected={selectedAppId === DEFAULT_RESEARCH_APP_ID}
                onClick={() => {
                  if (selectedAppId === DEFAULT_RESEARCH_APP_ID) return;
                  setSelectedAppId(DEFAULT_RESEARCH_APP_ID);
                  setSelectedKeywords(new Set());
                  setSelectionAnchor(null);
                }}
              >
                <span className="research-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none">
                    <path d="M12 3l2.7 5.3L20 11l-5.3 2.7L12 19l-2.7-5.3L4 11l5.3-2.7L12 3z" strokeWidth="1.6" />
                  </svg>
                </span>
                <span className="app-meta">
                  <span className="app-name">Research</span>
                </span>
              </button>
            ) : null}
            {researchApps.map((app) => {
              const isSelected = selectedAppId === app.id;
              return (
                <button
                  key={app.id}
                  className={`app-item ${isSelected ? "active" : ""}`}
                  data-app-id={app.id}
                  role="tab"
                  aria-selected={isSelected}
                  onClick={() => {
                    if (isSelected) return;
                    setSelectedAppId(app.id);
                    setSelectedKeywords(new Set());
                    setSelectionAnchor(null);
                  }}
                >
                  <span className="research-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none">
                      <path d="M12 3l2.7 5.3L20 11l-5.3 2.7L12 19l-2.7-5.3L4 11l5.3-2.7L12 3z" strokeWidth="1.6" />
                    </svg>
                  </span>
                  <span className="app-meta">
                    <span className="app-name">{app.name}</span>
                  </span>
                </button>
              );
            })}
          </section>

          <section className="apps-section">
            <p className="apps-section-title">Apps</p>
            {ownedApps.map((app) => {
              const isSelected = selectedAppId === app.id;
              const appDoc = appDocsById[app.id];
              const iconUrl = getIconUrl(appDoc);
              const initials = app.name.slice(0, 2).toUpperCase();
              const hasRatingSnapshot = appDoc != null;
              const ratingValue =
                typeof appDoc?.averageUserRating === "number"
                  ? formatRatingValue(appDoc.averageUserRating, displayLocale)
                  : "-";
              const ratingsCount =
                typeof appDoc?.userRatingCount === "number"
                  ? formatCount(appDoc.userRatingCount, displayLocale)
                  : "-";
              const ratingDelta = getNumberDelta(
                appDoc?.averageUserRating,
                appDoc?.previousAverageUserRating
              );
              const ratingsCountDelta = getNumberDelta(
                appDoc?.userRatingCount,
                appDoc?.previousUserRatingCount
              );
              const roundedRatingDelta =
                ratingDelta == null ? null : roundTo(ratingDelta, 1);
              const roundedRatingsCountDelta =
                ratingsCountDelta == null ? null : roundTo(ratingsCountDelta, 0);
              const showRatingDelta =
                roundedRatingDelta != null && roundedRatingDelta !== 0;
              const showRatingsCountDelta =
                roundedRatingsCountDelta != null && roundedRatingsCountDelta !== 0;
              const ratingDeltaLabel = showRatingDelta
                ? formatSignedNumber(roundedRatingDelta as number, displayLocale, 1)
                : "";
              const ratingsCountDeltaLabel = showRatingsCountDelta
                ? formatSignedNumber(
                    roundedRatingsCountDelta as number,
                    displayLocale,
                    0
                  )
                : "";
              const ratingDeltaClass =
                roundedRatingDelta != null && roundedRatingDelta > 0
                  ? "up"
                  : "down";
              const ratingsCountDeltaClass =
                roundedRatingsCountDelta != null && roundedRatingsCountDelta > 0
                  ? "up"
                  : "down";
              return (
                <div
                  key={app.id}
                  className={`app-item ${isSelected ? "active" : ""}`}
                  data-app-id={app.id}
                  role="tab"
                  tabIndex={0}
                  aria-selected={isSelected}
                  onClick={() => {
                    if (isSelected) return;
                    setSelectedAppId(app.id);
                    setSelectedKeywords(new Set());
                    setSelectionAnchor(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    if (isSelected) return;
                    setSelectedAppId(app.id);
                    setSelectedKeywords(new Set());
                    setSelectionAnchor(null);
                  }}
                >
                  {iconUrl ? (
                    <img
                      src={iconUrl}
                      alt=""
                      loading="lazy"
                      onError={(event) => {
                        const img = event.currentTarget;
                        img.style.display = "none";
                        const fallback = img.parentElement?.querySelector(".app-fallback");
                        if (fallback instanceof HTMLElement) fallback.style.display = "inline-flex";
                      }}
                    />
                  ) : null}
                  <span className="app-fallback" style={{ display: iconUrl ? "none" : "inline-flex" }}>
                    {initials}
                  </span>
                  <span className="app-meta">
                    <span className="app-name">{app.name}</span>
                    <span className="app-id-row">
                      {isSelected ? (
                        <button
                          type="button"
                          className="app-id app-id-copy-target"
                          title="Copy app ID"
                          aria-label={`Copy app ID ${app.id}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            void copyAppId(app.id);
                          }}
                        >
                          {app.id}
                        </button>
                      ) : (
                        <span className="app-id">{app.id}</span>
                      )}
                      <button
                        type="button"
                        className={`app-id-copy-icon ${copiedAppId === app.id ? "is-copied" : ""} ${isSelected ? "" : "is-hidden"}`}
                        title={copiedAppId === app.id ? "Copied!" : "Copy app ID"}
                        aria-label={`Copy app ID ${app.id}`}
                        aria-hidden={!isSelected}
                        tabIndex={isSelected ? 0 : -1}
                        onClick={(event) => {
                          event.stopPropagation();
                          void copyAppId(app.id);
                        }}
                      >
                        {copiedAppId === app.id ? <CheckIcon /> : <CopyIcon />}
                      </button>
                    </span>
                    {hasRatingSnapshot ? (
                      <span className="app-rating-summary" aria-label="Rating summary">
                        <span className="app-rating-group">
                          <span className="app-rating-star" aria-hidden="true">
                            ★
                          </span>
                          <span className="app-rating-value">{ratingValue}</span>
                          {showRatingDelta ? (
                            <span className={`delta ${ratingDeltaClass}`}>
                              {ratingDeltaLabel}
                            </span>
                          ) : null}
                        </span>
                        <span className="app-rating-separator" aria-hidden="true">
                          •
                        </span>
                        <span className="app-rating-group">
                          <span className="app-rating-value">{ratingsCount}</span>
                          {showRatingsCountDelta ? (
                            <span className={`delta ${ratingsCountDeltaClass}`}>
                              {ratingsCountDeltaLabel}
                            </span>
                          ) : null}
                        </span>
                      </span>
                    ) : null}
                  </span>
                </div>
              );
            })}
          </section>
        </div>
      </aside>

      <main className="main">
        <Card className="add-card">
          <form id="add-form" className="add-form" onSubmit={onAddKeywords}>
            <Input
              id="add-keywords"
              type="text"
              placeholder="Add keywords (comma-separated)"
              value={addInput}
              onChange={(e) => setAddInput(e.target.value)}
            />
            <Button id="add-submit" type="submit" disabled={isAddingKeywords || isColdStart}>
              <span className={`add-submit-label ${isAddingKeywords ? "is-loading" : ""}`}>{addButtonLabel}</span>
              <span className={`button-loading-spinner ${isAddingKeywords ? "visible" : ""}`} aria-hidden="true" />
            </Button>
            <Button
              id="retry-failed-submit"
              type="button"
              variant="outline"
              disabled={isRetryingFailedKeywords || failedKeywordCount === 0 || isColdStart}
              onClick={() => {
                void onRetryFailedKeywords();
              }}
            >
              {isRetryingFailedKeywords
                ? "Retrying Failed..."
                : `Retry Failed (${failedKeywordCount})`}
            </Button>
            <div className="status-slot" aria-live="polite">
              <p id="loading-text" className={`loading-text ${showLoading ? "visible" : ""}`}>
                {loadingText}
              </p>
              <p id="add-error" className={`error ${showError ? "visible" : ""}`}>
                {errorText}
              </p>
              <p id="add-success" className={`success ${showSuccess ? "visible" : ""}`}>
                {successText}
              </p>
            </div>
          </form>
        </Card>

        <Card className="top-toolbar">
          <p
            className={`startup-refresh-status ${startupRefreshMessage ? "visible" : ""}`}
          >
            {startupRefreshMessage}
          </p>
          <Button
            id="reset-filters"
            className={hasFilters ? "" : "hidden"}
            variant="outline"
            size="sm"
            type="button"
            onClick={() => {
              setKeywordFilter("");
              setMaxDifficulty(DEFAULT_MAX_DIFFICULTY);
              setMinPopularity(DEFAULT_MIN_POPULARITY);
              setMinRank(DEFAULT_MIN_RANK);
              setMaxRank(DEFAULT_MAX_RANK);
            }}
          >
            Reset filters
          </Button>

          <Button
            id="clear-selection"
            className={selectedKeywords.size > 1 ? "" : "hidden"}
            variant="outline"
            size="sm"
            type="button"
            onClick={() => {
              setSelectedKeywords(new Set());
              setSelectionAnchor(null);
            }}
          >
            Clear selection ({selectedKeywords.size})
          </Button>

          <Badge id="stats-pill">
            {filteredRows.length} keyword{filteredRows.length === 1 ? "" : "s"}
          </Badge>
        </Card>

        <Card className="table-card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th
                    className={`col-keyword keyword-filter-th ${sortBy === "keyword" ? "active" : ""}`}
                    data-sort-key="keyword"
                  >
                    <div className="keyword-header">
                      <button
                        type="button"
                        className="column-sort-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onSortHeader("keyword");
                        }}
                      >
                        {renderSortLabel("Keyword")}
                      </button>
                      <Input
                        id="keyword-filter"
                        type="text"
                        placeholder="Search"
                        value={keywordFilter}
                        onChange={(e) => setKeywordFilter(e.target.value)}
                        aria-label="Keyword search"
                      />
                    </div>
                  </th>
                  <th
                    className={`num col-middle sortable ${sortBy === "popularity" ? "active" : ""}`}
                    data-sort-key="popularity"
                  >
                    <div className="column-filter-header">
                      <button
                        type="button"
                        className="column-sort-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onSortHeader("popularity");
                        }}
                      >
                        {renderSortLabel("Popularity")}
                      </button>
                      {renderFilterDropdown("popularity", "Popularity")}
                    </div>
                  </th>
                  <th
                    className={`num col-middle sortable ${sortBy === "difficulty" ? "active" : ""}`}
                    data-sort-key="difficulty"
                  >
                    <div className="column-filter-header">
                      <button
                        type="button"
                        className="column-sort-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onSortHeader("difficulty");
                        }}
                      >
                        {renderSortLabel("Difficulty")}
                      </button>
                      {renderFilterDropdown("difficulty", "Difficulty")}
                    </div>
                  </th>
                  <th
                    className={`num col-middle sortable ${sortBy === "appCount" ? "active" : ""}`}
                    data-sort-key="appCount"
                    onClick={() => onSortHeader("appCount")}
                  >
                    {renderSortLabel("App Count")}
                  </th>
                  {showRankingColumns ? (
                    <>
                      <th
                        className={`num col-middle sortable ${sortBy === "rank" ? "active" : ""}`}
                        data-sort-key="rank"
                      >
                        <div className="column-filter-header">
                          <button
                            type="button"
                            className="column-sort-button"
                            onClick={(event) => {
                              event.stopPropagation();
                              onSortHeader("rank");
                            }}
                          >
                            {renderSortLabel("Rank")}
                          </button>
                          {renderFilterDropdown("rank", "Rank")}
                        </div>
                      </th>
                      <th
                        className={`col-middle sortable ${sortBy === "change" ? "active" : ""}`}
                        data-sort-key="change"
                        onClick={() => onSortHeader("change")}
                      >
                        {renderSortLabel("Change")}
                      </th>
                      <th
                        className={`sortable ${sortBy === "updatedAt" ? "active" : ""}`}
                        data-sort-key="updatedAt"
                        onClick={() => onSortHeader("updatedAt")}
                      >
                        {renderSortLabel("Updated")}
                      </th>
                    </>
                  ) : null}
                </tr>
              </thead>
              <tbody id="keywords-tbody">
                {filteredRows.map((row, index) => {
                  const isSelected = selectedKeywords.has(row.keyword);
                  const change = getChange(row);
                  return (
                    <tr
                      key={row.keyword}
                      className={isSelected ? "selected" : ""}
                      data-keyword={row.keyword}
                      onClick={(event) => onSelectRow(row.keyword, index, event)}
                      onContextMenu={(event) => onContextMenuOpen(event, row.keyword)}
                    >
                      <td className="col-keyword">
                        <div className="keyword-cell-content">
                          <span className="keyword-cell-label">{row.keyword}</span>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="top-apps-trigger"
                            onClick={(event) => {
                              event.stopPropagation();
                              void onOpenTopApps(row.keyword);
                            }}
                          >
                            Top Apps
                          </Button>
                        </div>
                      </td>
                      <td className="num col-middle">{row.popularity ?? "-"}</td>
                      <td className="num col-middle">
                        {row.difficultyScore == null ? "Calculating..." : Math.round(row.difficultyScore)}
                      </td>
                      <td className="num col-middle">{row.appCount ?? "-"}</td>
                      {showRankingColumns ? (
                        <>
                          <td className="num col-middle">{row.currentPosition ?? "-"}</td>
                          <td className="col-middle">
                            {change == null ? (
                              "-"
                            ) : change === 0 ? (
                              <span className="delta same">0</span>
                            ) : change < 0 ? (
                              <span className="delta up">+{Math.abs(change)}</span>
                            ) : (
                              <span className="delta down">-{Math.abs(change)}</span>
                            )}
                          </td>
                          <td className="updated-value">
                            {formatDate(row.updatedAt, displayLocale)}
                          </td>
                        </>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {filteredRows.length === 0 ? (
            <p id="empty-state" className="empty">
              {emptyStateText}
            </p>
          ) : null}
          <p className="table-hint">
            Tip: Click to select, Shift-click for range, Cmd/Ctrl-click to toggle, Cmd/Ctrl+A to select all, right-click for actions.
          </p>
        </Card>
      </main>
      {keywordActionMenu ? (
        <div
          className="keyword-action-menu"
          style={{ left: `${keywordActionMenu.x}px`, top: `${keywordActionMenu.y}px` }}
          role="menu"
          aria-label="Keyword actions"
        >
          <button
            type="button"
            className="keyword-action-item"
            role="menuitem"
            onClick={() => void onContextAction("copy")}
          >
            Copy
          </button>
          <button
            type="button"
            className="keyword-action-item danger"
            role="menuitem"
            onClick={() => void onContextAction("delete")}
          >
            Delete
          </button>
        </div>
      ) : null}
      {topAppsKeyword ? (
        <div
          className="dialog-backdrop"
          onClick={() => setTopAppsKeyword(null)}
          role="presentation"
        >
          <section
            className="dialog-card ui-card top-apps-dialog-card"
            role="dialog"
            aria-modal="true"
            aria-label={`Top apps for ${topAppsKeyword}`}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="dialog-header">
              <h2>Top apps for "{topAppsKeyword}"</h2>
              <button
                type="button"
                className="dialog-close"
                aria-label="Close"
                onClick={() => setTopAppsKeyword(null)}
              >
                ×
              </button>
            </header>
            <div className="dialog-content">
              {topAppsLoading ? <p className="dialog-message">Loading top apps...</p> : null}
              {!topAppsLoading && topAppsError ? <p className="dialog-message error">{topAppsError}</p> : null}
              {!topAppsLoading && !topAppsError && topAppsRows.length === 0 ? (
                <p className="dialog-message">No app data found for this keyword.</p>
              ) : null}
              {!topAppsLoading && !topAppsError && topAppsRows.length > 0 ? (
                <div className="top-apps-list" role="list" aria-label={`Top apps for ${topAppsKeyword}`}>
                  {topAppsRows.map((app) => {
                    const iconUrl = getIconUrl(app);
                    const subtitle = app.subtitle?.trim();
                    const appStoreUrl = buildAppStoreUrl(app.appId, DEFAULT_ASO_COUNTRY);
                    const releaseDate = formatCalendarDate(app.releaseDate, displayLocale) || "-";
                    const lastUpdateDate =
                      formatCalendarDate(app.currentVersionReleaseDate, displayLocale) || "-";
                    const ratingValue =
                      typeof app.averageUserRating === "number"
                        ? new Intl.NumberFormat(displayLocale, {
                            minimumFractionDigits: 1,
                            maximumFractionDigits: 1,
                          }).format(app.averageUserRating)
                        : "-";
                    const metricPairs = [
                      {
                        label: "RATING",
                        value: ratingValue,
                        pairClassName: "top-app-metric-pair-rating",
                      },
                      {
                        label: "RATINGS",
                        value:
                          typeof app.userRatingCount === "number"
                            ? formatCount(app.userRatingCount, displayLocale)
                            : "-",
                      },
                      { label: "FIRST RELEASE", value: releaseDate },
                      { label: "LAST UPDATE", value: lastUpdateDate },
                    ];
                    return (
                      <article className="top-app-row" key={`${topAppsKeyword}-${app.rank}-${app.appId}`} role="listitem">
                        <span className="top-app-order">{app.rank}</span>
                        <div className="top-app-card">
                          <div className="top-app-main">
                            <div className="top-app-media">
                              {iconUrl ? (
                                <img src={iconUrl} alt="" loading="lazy" className="top-app-icon" />
                              ) : (
                                <span className="top-app-icon-fallback">
                                  {(app.name?.trim().charAt(0) || "?").toUpperCase()}
                                </span>
                              )}
                            </div>
                            <div className="top-app-content">
                              <h3 className="top-app-name">{app.name ?? app.appId}</h3>
                              <p className={subtitle ? "top-app-subtitle" : "top-app-subtitle muted"}>
                                {subtitle || "No subtitle available"}
                              </p>
                            </div>
                            <div className="top-app-side">
                              <div className="top-app-metrics-inline" role="group" aria-label="App metrics">
                                {metricPairs.map((metric, index) => (
                                  <div className="top-app-metric-entry" key={metric.label}>
                                    {index > 0 ? (
                                      <span className="top-app-metric-dot" aria-hidden="true">
                                        •
                                      </span>
                                    ) : null}
                                    <div
                                      className={`top-app-metric-pair${metric.pairClassName ? ` ${metric.pairClassName}` : ""}`}
                                    >
                                      <span className="top-app-metric-label">{metric.label}</span>
                                      <span className="top-app-metric-value">{metric.value}</span>
                                    </div>
                                  </div>
                                ))}
                              </div>
                              <div className="top-app-actions">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  className="top-app-store-button"
                                  aria-label="Open in App Store"
                                  onClick={() => window.open(appStoreUrl, "_blank", "noopener,noreferrer")}
                                >
                                  <img src={APP_STORE_ICON_IMAGE_URL} alt="" className="top-app-store-icon-image" />
                                </Button>
                              </div>
                            </div>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
      {isAddAppPopoverOpen ? (
        <div
          className="dialog-backdrop"
          onClick={() => setIsAddAppPopoverOpen(false)}
          role="presentation"
        >
          <section
            className="dialog-card ui-card add-app-dialog-card"
            role="dialog"
            aria-modal="true"
            aria-label="Add app"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="dialog-header">
              <h2>Add App</h2>
              <button
                type="button"
                className="dialog-close"
                aria-label="Close"
                onClick={() => setIsAddAppPopoverOpen(false)}
              >
                ×
              </button>
            </header>
            <div className="dialog-content">
              <form className="add-app-popup-form" onSubmit={onAddApp}>
                <div className="add-app-controls">
                  <select
                    id="add-app-type"
                    value={addAppMode}
                    onChange={(event) => setAddAppMode(event.target.value as ManualAddType)}
                    disabled={isAnyAppMutationInFlight || isColdStart}
                  >
                    <option value="app">App</option>
                    <option value="research">Research</option>
                  </select>
                  <Input
                    id="add-app-input"
                    type="text"
                    placeholder={addAppMode === "app" ? "App ID" : "Research name"}
                    value={addAppInput}
                    onChange={(event) => setAddAppInput(event.target.value)}
                  />
                  <Button id="add-app-submit" type="submit" disabled={isAnyAppMutationInFlight || isColdStart}>
                    {isAddingApp ? "Adding..." : "Add"}
                  </Button>
                </div>
              </form>
            </div>
          </section>
        </div>
      ) : null}
      {authModalOpen ? (
        <div className="dialog-backdrop auth-dialog-backdrop" role="presentation">
          <section className="dialog-card ui-card auth-dialog-card" role="dialog" aria-modal="true" aria-label="Apple reauthentication required">
            <header className="dialog-header">
              <h2>Apple Reauthentication Required</h2>
            </header>
            <div className="dialog-content auth-dialog-content">
              {authStatusLabel ? <p className="dialog-message">{authStatusLabel}</p> : null}
              {authStatusError ? <p className="dialog-message error">{authStatusError}</p> : null}
              <div className="auth-dialog-actions">
                {showReauthButton ? (
                  <Button
                    type="button"
                    className="auth-action-button"
                    onClick={() => {
                      void onStartReauthentication();
                    }}
                    disabled={!canStartReauth}
                  >
                    {isStartingAuth ? "Starting..." : "Reauthenticate"}
                  </Button>
                ) : null}
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
