import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, Input } from "./ui-react";
import { DEFAULT_RESEARCH_APP_ID } from "../shared/aso-research";
import {
  APP_STORE_ICON_IMAGE_URL,
  DEFAULT_ASO_COUNTRY,
  apiGet,
  apiWrite,
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
  getIconUrl,
  getNumberDelta,
  roundTo,
  toActionableErrorMessage,
} from "./app-helpers";
import {
  ASO_MAX_KEYWORDS,
  ASO_MAX_KEYWORDS_PER_REQUEST_ERROR,
} from "../shared/aso-keyword-limits";
import { useFiltersSort, type SortDir, type SortKey } from "./hooks/use-filters-sort";
import { useSelection } from "./hooks/use-selection";
import { sanitizeKeywords } from "../domain/keywords/policy";
import { useAuthFlow } from "./hooks/use-auth-flow";
import { useAddAppSearch } from "./hooks/use-add-app-search";
import { StatusBanners } from "./components/status-banners";
import { AuthDialog } from "./components/auth-dialog";
import { KeywordActionMenu } from "./components/keyword-action-menu";
import { AddAppDialog } from "./components/add-app-dialog";

type AppKind = "owned" | "research";

type AppItem = {
  id: string;
  kind: AppKind;
  name: string;
  averageUserRating?: number | null;
  userRatingCount?: number | null;
  previousAverageUserRating?: number | null;
  previousUserRatingCount?: number | null;
  icon?: Record<string, unknown>;
  expiresAt?: string | null;
  lastFetchedAt?: string | null;
  previousFetchedAt?: string | null;
  lastKeywordAddedAt?: string | null;
};
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
  popularity: number | null;
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
  keywordStatus: "ok" | "pending" | "failed";
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
const SORT_LABEL_BY_KEY: Record<SortKey, string> = {
  keyword: "Keyword",
  popularity: "Popularity",
  difficulty: "Difficulty",
  appCount: "App Count",
  rank: "Rank",
  change: "Change",
  updatedAt: "Updated",
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
const SIDEBAR_SELECTION_CONTROL_SELECTOR = ".app-id-copy-target, .app-id-copy-icon";

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

function isSidebarSelectionControlTarget(target: EventTarget | null): boolean {
  if (target instanceof Element) {
    return target.closest(SIDEBAR_SELECTION_CONTROL_SELECTOR) !== null;
  }
  if (target instanceof Node) {
    return target.parentElement?.closest(SIDEBAR_SELECTION_CONTROL_SELECTOR) != null;
  }
  return false;
}

export function App() {
  const [apps, setApps] = useState<AppItem[]>([]);
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
  const [isAddingApp, setIsAddingApp] = useState(false);
  const [topAppsKeyword, setTopAppsKeyword] = useState<string | null>(null);
  const [topAppsRows, setTopAppsRows] = useState<TopAppRow[]>([]);
  const [topAppsLoading, setTopAppsLoading] = useState(false);
  const [topAppsError, setTopAppsError] = useState("");
  const [startupRefreshState, setStartupRefreshState] =
    useState<StartupRefreshStatusPayload | null>(null);
  const [displayLocale] = useState(() => getBrowserLocale());
  const isInitializedRef = useRef(false);
  const addKeywordsInputRef = useRef<HTMLInputElement | null>(null);
  const keywordLoadRequestIdRef = useRef(0);
  const selectedAppIdRef = useRef(selectedAppId);
  const autoRetryInFlightRef = useRef(false);
  const startupAppSyncAtRef = useRef<string | null>(null);

  const appById = useMemo(
    () => new Map(apps.map((app) => [app.id, app])),
    [apps]
  );
  const selectedApp = appById.get(selectedAppId);
  const selectedAppName =
    selectedApp?.name ??
    (selectedAppId === DEFAULT_RESEARCH_APP_ID ? "Research" : selectedAppId);
  const isSelectedAppResearch = selectedApp?.kind === "research";
  const showRankingColumns = !isSelectedAppResearch;
  const {
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
  } = useFiltersSort({
    keywords,
    showRankingColumns,
  });
  const {
    selectedKeywords,
    setSelectedKeywords,
    setSelectionAnchor,
    onSelectRow: onSelectKeywordRow,
  } = useSelection({
    keywords,
    filteredRows,
  });
  const {
    authModalOpen,
    authStatus,
    authStatusError,
    isStartingAuth,
    pendingAddContext,
    setPendingAddContext,
    openAuthModalForPendingAdd,
    startReauthentication,
    authCheckLoadingText,
    authStatusLabel,
    canStartReauth,
    showReauthButton,
  } = useAuthFlow({
    isAddingKeywords,
  });
  const {
    isAddAppPopoverOpen,
    addAppSearchTerm,
    addAppSearchInputRef,
    addAppSearchError,
    addAppSearchWarning,
    isAddAppSearching,
    selectedAddCandidates,
    selectedAddCandidateList,
    trimmedAddAppSearchTerm,
    addAppCandidates,
    setAddAppSearchTerm,
    openAddAppPopover,
    closeAddAppPopover,
    toggleAddCandidateSelection,
    removeSelectedCandidates,
  } = useAddAppSearch();
  const researchApps = apps.filter((app) => app.kind === "research");
  const ownedApps = apps.filter((app) => app.kind === "owned");
  const existingOwnedAppIds = useMemo(
    () => new Set(ownedApps.map((app) => app.id)),
    [ownedApps]
  );
  const emptyStateText =
    keywords.length === 0
      ? "No keywords yet for this app."
      : "No keywords match the current search/filters.";

  const loadApps = useCallback(async (): Promise<AppItem[]> => {
    const list = await apiGet<AppItem[]>(`/api/apps`);
    setApps(list);
    return list;
  }, []);

  const loadKeywords = useCallback(async (appId: string) => {
    const requestId = ++keywordLoadRequestIdRef.current;
    const data = await apiGet<KeywordItem[]>(
      `/api/aso/keywords?country=${DEFAULT_ASO_COUNTRY}&appId=${encodeURIComponent(appId)}`
    );
    if (requestId !== keywordLoadRequestIdRef.current) return;
    const rows = data.map((item) => {
      const p = (item.positions ?? []).find((x) => x.appId === appId);
      const keywordStatus =
        item.keywordStatus ?? (item.difficultyScore == null ? "pending" : "ok");
      return {
        keyword: item.keyword,
        popularity: item.popularity ?? 0,
        difficultyScore: item.difficultyScore,
        appCount: item.appCount,
        updatedAt: item.updatedAt,
        previousPosition: p?.previousPosition ?? null,
        currentPosition: p?.currentPosition ?? null,
        keywordStatus,
      } satisfies Row;
    });
    setKeywords(rows);
    setFailedKeywordCount(rows.filter((row) => row.keywordStatus === "failed").length);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        setLoadingText("Loading dashboard...");
        const list = await loadApps();
        setHasCachedData(true);
        let activeAppId = selectedAppIdRef.current;
        if (
          activeAppId === DEFAULT_RESEARCH_APP_ID &&
          !list.some((a) => a.id === activeAppId)
        ) {
          const firstResearch = list.find((a) => a.kind === "research");
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
    () => keywords.some((row) => row.keywordStatus === "pending"),
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

  const selectSidebarApp = useCallback((appId: string) => {
    if (selectedAppId === appId) return;
    setSelectedAppId(appId);
    setSelectedKeywords(new Set());
    setSelectionAnchor(null);
  }, [selectedAppId, setSelectionAnchor]);

  const onSidebarAppClickCapture = useCallback(
    (event: React.MouseEvent<HTMLElement>, appId: string) => {
      if (isSidebarSelectionControlTarget(event.target)) return;
      selectSidebarApp(appId);
    },
    [selectSidebarApp]
  );

  useEffect(() => {
    if (!hasPendingDifficulty) return;
    const id = window.setInterval(() => {
      void loadKeywords(selectedAppId).catch(() => {});
    }, 3000);
    return () => window.clearInterval(id);
  }, [hasPendingDifficulty, loadKeywords, selectedAppId]);

  const onSelectRow = (
    rowKeyword: string,
    rowIndex: number,
    event: React.MouseEvent<HTMLTableRowElement>
  ) => {
    setKeywordActionMenu(null);
    onSelectKeywordRow(rowKeyword, rowIndex, event);
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

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      const element = target;
      const tag = element.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return true;
      if (element.isContentEditable) return true;
      return element.closest("[contenteditable='true']") != null;
    };
    const getVisibleSelectedKeywords = (): string[] =>
      filteredRows
        .map((row) => row.keyword)
        .filter((keyword) => selectedKeywords.has(keyword));

    const onCopy = (event: ClipboardEvent) => {
      if (isEditableTarget(event.target)) return;
      const selected = getVisibleSelectedKeywords();
      if (selected.length === 0) return;
      const payload = selected.join(",");
      event.preventDefault();
      if (event.clipboardData) {
        event.clipboardData.setData("text/plain", payload);
        setErrorText("");
        setSuccessText(
          `Copied ${selected.length} keyword${selected.length === 1 ? "" : "s"} as comma-separated text.`
        );
        return;
      }
      void onContextCopy(selected);
    };

    const onPaste = (event: ClipboardEvent) => {
      if (isEditableTarget(event.target)) return;
      const pasted = event.clipboardData?.getData("text")?.trim() ?? "";
      if (!pasted) return;
      event.preventDefault();
      setAddInput((prev) => {
        const existing = prev.trim();
        if (!existing) return pasted;
        return existing.endsWith(",") ? `${existing} ${pasted}` : `${existing}, ${pasted}`;
      });
      addKeywordsInputRef.current?.focus();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.repeat) return;
      const isDeleteKey =
        event.key === "Delete" ||
        event.key === "Del" ||
        event.key === "Backspace" ||
        event.code === "Delete" ||
        event.code === "Backspace" ||
        event.keyCode === 46 ||
        event.keyCode === 8;
      if (!isDeleteKey) return;
      const selected = getVisibleSelectedKeywords();
      if (selected.length === 0) return;
      if (isEditableTarget(event.target)) {
        const active = event.target as HTMLInputElement | HTMLTextAreaElement;
        const tag = active?.tagName?.toLowerCase();
        if (tag === "input" || tag === "textarea") {
          const value = typeof active.value === "string" ? active.value : "";
          const hasTextSelection =
            typeof active.selectionStart === "number" &&
            typeof active.selectionEnd === "number" &&
            active.selectionEnd > active.selectionStart;
          if (value.length > 0 || hasTextSelection) return;
        }
      }
      event.preventDefault();
      void onContextDelete(selected);
    };

    document.addEventListener("copy", onCopy);
    document.addEventListener("paste", onPaste);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("paste", onPaste);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [filteredRows, onContextCopy, onContextDelete, selectedKeywords]);

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
    const normalizedKeywords = sanitizeKeywords(addInput.split(","));

    if (normalizedKeywords.length === 0) {
      setErrorText("Please add at least one keyword.");
      return;
    }
    if (normalizedKeywords.length > ASO_MAX_KEYWORDS) {
      setErrorText(ASO_MAX_KEYWORDS_PER_REQUEST_ERROR);
      return;
    }

    const existingKeywords = new Set(keywords.map((row) => row.keyword.trim().toLowerCase()));
    const kwsToAdd = normalizedKeywords.filter((keyword) => !existingKeywords.has(keyword));

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
      const retriedLabel = `Retried ${result.retriedCount} failed keyword${result.retriedCount === 1 ? "" : "s"}`;
      if (result.failedCount === 0) {
        setSuccessText(`${retriedLabel}: ${result.succeededCount} succeeded.`);
      } else if (result.succeededCount === 0) {
        setSuccessText(`${retriedLabel}: none succeeded, ${result.failedCount} still failed.`);
      } else {
        setSuccessText(
          `${retriedLabel}: ${result.succeededCount} succeeded, ${result.failedCount} still failed.`
        );
      }
    } catch (error) {
      setErrorText(toActionableErrorMessage(error, "Failed to retry failed keywords"));
    } finally {
      setIsRetryingFailedKeywords(false);
      setLoadingText("");
    }
  }, [failedKeywordCount, loadKeywords, selectedAppId]);

  useEffect(() => {
    if (authStatus !== "succeeded") return;
    if (!pendingAddContext) return;
    if (autoRetryInFlightRef.current) return;

    autoRetryInFlightRef.current = true;
    void submitKeywords(pendingAddContext.keywords).finally(() => {
      autoRetryInFlightRef.current = false;
    });
  }, [authStatus, pendingAddContext, submitKeywords]);

  const onAddApp = async (event: React.FormEvent) => {
    event.preventDefault();
    if (selectedAddCandidateList.length === 0) {
      setErrorText("Select at least one app or research name.");
      return;
    }

    try {
      setErrorText("");
      setSuccessText("");
      setIsAddingApp(true);
      setLoadingText(
        `Adding ${selectedAddCandidateList.length} item${selectedAddCandidateList.length === 1 ? "" : "s"}...`
      );
      const addedIds: string[] = [];
      const succeededKeys: string[] = [];
      const failedErrors: unknown[] = [];

      for (const candidate of selectedAddCandidateList) {
        try {
          if (candidate.type === "app") {
            const appId = (candidate.appId ?? "").trim();
            if (!/^\d+$/.test(appId)) {
              throw new Error("App ID must be numeric.");
            }
            const added = await apiWrite<AddedAppPayload>("POST", "/api/apps", {
              type: "app",
              appId,
            });
            addedIds.push(added.id);
            succeededKeys.push(candidate.key);
            continue;
          }

          const name = (candidate.name ?? "").trim();
          if (!name) {
            throw new Error("Research name is required.");
          }
          const added = await apiWrite<AddedAppPayload>("POST", "/api/apps", {
            type: "research",
            name,
          });
          addedIds.push(added.id);
          succeededKeys.push(candidate.key);
        } catch (error) {
          failedErrors.push(error);
        }
      }

      const list = await loadApps();
      const selectedAddedId = [...addedIds].reverse().find((id) =>
        list.some((app) => app.id === id)
      );
      if (selectedAddedId) {
        setSelectedAppId(selectedAddedId);
        await loadKeywords(selectedAddedId);
      } else {
        await loadKeywords(selectedAppIdRef.current);
      }

      if (failedErrors.length === 0) {
        setSuccessText(`Added ${addedIds.length} item${addedIds.length === 1 ? "" : "s"}.`);
        closeAddAppPopover();
      } else {
        removeSelectedCandidates(succeededKeys);
        const failureText = toActionableErrorMessage(
          failedErrors[0],
          "Failed to add selected items"
        );
        if (addedIds.length > 0) {
          setErrorText(
            `Added ${addedIds.length} item${addedIds.length === 1 ? "" : "s"}, ${failedErrors.length} failed. ${failureText}`
          );
        } else {
          setErrorText(failureText);
        }
      }
    } catch (error) {
      setErrorText(toActionableErrorMessage(error, "Failed to add selected items"));
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

  const renderSortLabel = (key: SortKey) => {
    const isActive = sortBy === key;
    return (
      <span className={`sort-label ${isActive ? "active" : ""}`}>
        <span>{SORT_LABEL_BY_KEY[key]}</span>
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
      <div
        className={`filter-dropdown ${isOpen ? "open" : ""}`}
        onClick={(event) => event.stopPropagation()}
      >
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

  const effectiveLoadingText = loadingText || authCheckLoadingText;
  const showLoading = effectiveLoadingText !== "";
  const isColdStart = isInitialLoad && !hasCachedData;
  const isAnyAppMutationInFlight = isAddingApp;
  const isAddKeywordsBusy = isAddingKeywords || authCheckLoadingText !== "";
  const showError = !showLoading && errorText !== "";
  const showSuccess = !showLoading && !showError && successText !== "";
  const addButtonLabel = isCompactLayout ? "Add" : "Add Keywords";
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
            <div className="sidebar-brand">
              <img src="/aso-sidebar-icon.png" alt="" className="sidebar-brand-icon" aria-hidden="true" />
              <h1>ASO Dashboard</h1>
            </div>
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
          <p className="sidebar-subtitle"></p>
          <div className="sidebar-actions">
            <Button
              id="add-app-toggle"
              type="button"
              aria-expanded={isAddAppPopoverOpen}
              aria-label="Add app"
              onClick={openAddAppPopover}
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
                onClickCapture={(event) =>
                  onSidebarAppClickCapture(event, DEFAULT_RESEARCH_APP_ID)
                }
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
                  onClickCapture={(event) => onSidebarAppClickCapture(event, app.id)}
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
              const iconUrl = getIconUrl({
                appId: app.id,
                name: app.name,
                icon: app.icon,
              });
              const initials = app.name.slice(0, 2).toUpperCase();
              const hasRatingSnapshot =
                typeof app.averageUserRating === "number" ||
                typeof app.userRatingCount === "number";
              const ratingValue =
                typeof app.averageUserRating === "number"
                  ? formatRatingValue(app.averageUserRating, displayLocale)
                  : "-";
              const ratingsCount =
                typeof app.userRatingCount === "number"
                  ? formatCount(app.userRatingCount, displayLocale)
                  : "-";
              const ratingDelta = getNumberDelta(
                app.averageUserRating,
                app.previousAverageUserRating
              );
              const ratingsCountDelta = getNumberDelta(
                app.userRatingCount,
                app.previousUserRatingCount
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
                  onClickCapture={(event) => onSidebarAppClickCapture(event, app.id)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    selectSidebarApp(app.id);
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
              ref={addKeywordsInputRef}
              id="add-keywords"
              type="text"
              placeholder="Add keywords (comma-separated)"
              value={addInput}
              onChange={(e) => setAddInput(e.target.value)}
            />
            <Button id="add-submit" type="submit" disabled={isAddKeywordsBusy || isColdStart}>
              <span className={`add-submit-label ${isAddKeywordsBusy ? "is-loading" : ""}`}>{addButtonLabel}</span>
              <span className={`button-loading-spinner ${isAddKeywordsBusy ? "visible" : ""}`} aria-hidden="true" />
            </Button>
            {failedKeywordCount > 0 ? (
              <Button
                id="retry-failed-submit"
                className="retry-failed-button"
                type="button"
                variant="ghost"
                disabled={isRetryingFailedKeywords || isColdStart}
                onClick={() => {
                  void onRetryFailedKeywords();
                }}
              >
                {isRetryingFailedKeywords
                  ? "Retrying Failed..."
                  : `Retry Failed (${failedKeywordCount})`}
              </Button>
            ) : null}
            <StatusBanners
              showLoading={showLoading}
              loadingText={effectiveLoadingText}
              showError={showError}
              errorText={errorText}
              showSuccess={showSuccess}
              successText={successText}
            />
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
                    aria-sort={sortBy === "keyword" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
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
                        {renderSortLabel("keyword")}
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
                    aria-sort={sortBy === "popularity" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                    onClick={() => onSortHeader("popularity")}
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
                        {renderSortLabel("popularity")}
                      </button>
                      {renderFilterDropdown("popularity", "Popularity")}
                    </div>
                  </th>
                  <th
                    className={`num col-middle sortable ${sortBy === "difficulty" ? "active" : ""}`}
                    data-sort-key="difficulty"
                    aria-sort={sortBy === "difficulty" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                    onClick={() => onSortHeader("difficulty")}
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
                        {renderSortLabel("difficulty")}
                      </button>
                      {renderFilterDropdown("difficulty", "Difficulty")}
                    </div>
                  </th>
                  <th
                    className={`num col-middle sortable ${sortBy === "appCount" ? "active" : ""}`}
                    data-sort-key="appCount"
                    aria-sort={sortBy === "appCount" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                    onClick={() => onSortHeader("appCount")}
                  >
                    {renderSortLabel("appCount")}
                  </th>
                  {showRankingColumns ? (
                    <>
                      <th
                        className={`num col-middle sortable ${sortBy === "rank" ? "active" : ""}`}
                        data-sort-key="rank"
                        aria-sort={sortBy === "rank" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                        onClick={() => onSortHeader("rank")}
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
                            {renderSortLabel("rank")}
                          </button>
                          {renderFilterDropdown("rank", "Rank")}
                        </div>
                      </th>
                      <th
                        className={`col-middle sortable ${sortBy === "change" ? "active" : ""}`}
                        data-sort-key="change"
                        aria-sort={sortBy === "change" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                        onClick={() => onSortHeader("change")}
                      >
                        {renderSortLabel("change")}
                      </th>
                    </>
                  ) : null}
                  <th
                    className={`sortable ${sortBy === "updatedAt" ? "active" : ""}`}
                    data-sort-key="updatedAt"
                    aria-sort={sortBy === "updatedAt" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                    onClick={() => onSortHeader("updatedAt")}
                  >
                    {renderSortLabel("updatedAt")}
                  </th>
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
                      <td className="num col-middle">{row.popularity > 0 ? row.popularity : "-"}</td>
                      <td className="num col-middle">
                        {row.keywordStatus === "failed"
                          ? "-"
                          : row.difficultyScore == null
                            ? "Calculating..."
                            : Math.round(row.difficultyScore)}
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
                        </>
                      ) : null}
                      <td className="updated-value">
                        {formatDate(row.updatedAt, displayLocale)}
                      </td>
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
        </Card>
      </main>
      {keywordActionMenu ? (
        <KeywordActionMenu
          x={keywordActionMenu.x}
          y={keywordActionMenu.y}
          onCopy={() => {
            void onContextAction("copy");
          }}
          onDelete={() => {
            void onContextAction("delete");
          }}
        />
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
      <AddAppDialog
        open={isAddAppPopoverOpen}
        onClose={closeAddAppPopover}
        onSubmit={onAddApp}
        searchTerm={addAppSearchTerm}
        onSearchTermChange={setAddAppSearchTerm}
        inputRef={addAppSearchInputRef}
        candidates={addAppCandidates}
        selectedCandidates={selectedAddCandidates}
        onToggleCandidateSelection={toggleAddCandidateSelection}
        selectedCount={selectedAddCandidateList.length}
        isSearching={isAddAppSearching}
        searchError={addAppSearchError}
        searchWarning={addAppSearchWarning}
        trimmedSearchTerm={trimmedAddAppSearchTerm}
        isBusy={isAnyAppMutationInFlight}
        isColdStart={isColdStart}
        isOwnedAppId={(appId) => existingOwnedAppIds.has(appId)}
      />
      <AuthDialog
        open={authModalOpen}
        statusLabel={authStatusLabel}
        statusError={authStatusError}
        showReauthButton={showReauthButton}
        canStartReauth={canStartReauth}
        isStartingAuth={isStartingAuth}
        onStartReauthentication={() => {
          void startReauthentication();
        }}
      />
    </div>
  );
}
