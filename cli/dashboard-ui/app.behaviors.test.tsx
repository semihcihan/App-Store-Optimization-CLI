/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "./App";
import { DEFAULT_RESEARCH_APP_ID } from "../shared/aso-research";
import type { PackageUpdateStatus } from "../shared/package-update";

type AppKind = "owned" | "research";
type AppRow = {
  id: string;
  name: string;
  kind?: AppKind;
  [key: string]: unknown;
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function setupMatchMediaMock(): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: jest.fn().mockImplementation(() => ({
      matches: false,
      media: "",
      onchange: null,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      addListener: jest.fn(),
      removeListener: jest.fn(),
      dispatchEvent: jest.fn(),
    })),
  });
}

function withAppKinds(apps: AppRow[]): Array<AppRow & { kind: AppKind }> {
  return apps.map((app) => {
    const kind =
      app.kind ??
      (app.id === DEFAULT_RESEARCH_APP_ID || app.id.startsWith("research:")
        ? "research"
        : "owned");
    return {
      ...app,
      kind,
    };
  });
}

function getKeywordStatus(item: {
  keywordStatus?: string;
  difficultyScore?: number | null;
}): "ok" | "pending" | "failed" {
  if (item.keywordStatus === "failed") return "failed";
  if (item.keywordStatus === "pending") return "pending";
  if (item.keywordStatus === "ok") return "ok";
  return item.difficultyScore == null ? "pending" : "ok";
}

function getCurrentPosition(item: { positions?: unknown[] }, appId: string): number | null {
  const position = (item.positions ?? [])
    .map((value) => value as { appId?: string; currentPosition?: number | null })
    .find((value) => value.appId === appId);
  return position?.currentPosition ?? null;
}

function getPreviousPosition(item: { positions?: unknown[] }, appId: string): number | null {
  const position = (item.positions ?? [])
    .map((value) => value as { appId?: string; previousPosition?: number | null })
    .find((value) => value.appId === appId);
  return position?.previousPosition ?? null;
}

function parseQueryInt(
  value: string | null,
  fallback: number,
  min: number,
  max: number
): number {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

function buildKeywordPagedPayloadForQuery(
  allItems: unknown[],
  appId: string,
  query: URLSearchParams
) {
  const scopedItems = allItems.map((item) => item as Record<string, unknown>);
  const page = parseQueryInt(query.get("page"), 1, 1, Number.MAX_SAFE_INTEGER);
  const pageSize = parseQueryInt(query.get("pageSize"), 100, 1, 500);
  const minPopularity = parseQueryInt(query.get("minPopularity"), 0, 0, 100);
  const maxDifficulty = parseQueryInt(query.get("maxDifficulty"), 100, 0, 100);
  const minRank = parseQueryInt(query.get("minRank"), 0, 0, 201);
  const maxRank = parseQueryInt(query.get("maxRank"), 201, 0, 201);
  const normalizedMinRank = Math.min(minRank, maxRank);
  const normalizedMaxRank = Math.max(minRank, maxRank);
  const keywordTerm = (query.get("keyword") ?? "").trim().toLowerCase();
  const brandFilter = query.get("brand") ?? "all";
  const favoriteFilter = query.get("favorite") ?? "all";
  const sortBy = query.get("sortBy") ?? "updatedAt";
  const sortDir = query.get("sortDir") === "asc" ? "asc" : "desc";

  const filtered = scopedItems.filter((item) => {
    const keyword = String(item.keyword ?? "");
    if (keywordTerm !== "" && !keyword.toLowerCase().includes(keywordTerm)) return false;
    const popularity =
      typeof item.popularity === "number" && Number.isFinite(item.popularity)
        ? item.popularity
        : 0;
    if (minPopularity > 0 && popularity <= minPopularity) return false;

    const difficultyScore =
      typeof item.difficultyScore === "number" && Number.isFinite(item.difficultyScore)
        ? item.difficultyScore
        : null;
    if (maxDifficulty < 100 && difficultyScore != null && difficultyScore >= maxDifficulty) {
      return false;
    }

    if (brandFilter === "brand" && item.isBrandKeyword !== true) return false;
    if (brandFilter === "non_brand" && item.isBrandKeyword !== false) return false;
    if (favoriteFilter === "favorite" && item.isFavorite !== true) return false;
    if (favoriteFilter === "non_favorite" && item.isFavorite === true) return false;

    const hasRankFilter = normalizedMinRank > 0 || normalizedMaxRank < 201;
    if (hasRankFilter) {
      const currentPosition = getCurrentPosition(item, appId);
      if (currentPosition == null) return false;
      if (normalizedMinRank > 0 && currentPosition <= normalizedMinRank) return false;
      if (normalizedMaxRank < 201 && currentPosition >= normalizedMaxRank) return false;
    }

    return true;
  });

  filtered.sort((left, right) => {
    const direction = sortDir === "desc" ? -1 : 1;
    const compareNullable = (a: number | null, b: number | null) => {
      if (a == null && b == null) return 0;
      if (a == null) return 1;
      if (b == null) return -1;
      if (a === b) return 0;
      return a > b ? direction : -direction;
    };
    const compareKeywordAsc = () =>
      String(left.keyword ?? "").localeCompare(String(right.keyword ?? ""), undefined, {
        sensitivity: "base",
      });

    let comparison = 0;
    switch (sortBy) {
      case "keyword": {
        const cmp = String(left.keyword ?? "").localeCompare(String(right.keyword ?? ""), undefined, {
          sensitivity: "base",
        });
        comparison = sortDir === "desc" ? -cmp : cmp;
        break;
      }
      case "popularity":
        comparison = compareNullable(
          typeof left.popularity === "number" ? left.popularity : null,
          typeof right.popularity === "number" ? right.popularity : null
        );
        break;
      case "difficulty":
        comparison = compareNullable(
          typeof left.difficultyScore === "number" ? left.difficultyScore : null,
          typeof right.difficultyScore === "number" ? right.difficultyScore : null
        );
        break;
      case "appCount":
        comparison = compareNullable(
          typeof left.appCount === "number" ? left.appCount : null,
          typeof right.appCount === "number" ? right.appCount : null
        );
        break;
      case "rank":
        comparison = compareNullable(
          getCurrentPosition(left, appId),
          getCurrentPosition(right, appId)
        );
        break;
      case "change": {
        const leftCurrent = getCurrentPosition(left, appId);
        const rightCurrent = getCurrentPosition(right, appId);
        const leftPrevious = getPreviousPosition(left, appId);
        const rightPrevious = getPreviousPosition(right, appId);
        const leftChange =
          leftCurrent == null ? null : leftCurrent - (leftPrevious ?? leftCurrent);
        const rightChange =
          rightCurrent == null ? null : rightCurrent - (rightPrevious ?? rightCurrent);
        comparison = compareNullable(leftChange, rightChange);
        break;
      }
      case "addedAt":
        comparison = compareNullable(
          typeof left.addedAt === "string"
            ? new Date(left.addedAt).getTime()
            : null,
          typeof right.addedAt === "string"
            ? new Date(right.addedAt).getTime()
            : null
        );
        break;
      case "updatedAt":
      default:
        comparison = compareNullable(
          typeof left.updatedAt === "string"
            ? new Date(left.updatedAt).getTime()
            : null,
          typeof right.updatedAt === "string"
            ? new Date(right.updatedAt).getTime()
            : null
        );
        break;
    }
    if (comparison !== 0) return comparison;
    return compareKeywordAsc();
  });

  const associatedCount = scopedItems.length;
  const failedCount = scopedItems.filter((item) => getKeywordStatus(item) === "failed").length;
  const pendingCount = scopedItems.filter((item) => getKeywordStatus(item) === "pending").length;
  const totalCount = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const normalizedPage = Math.min(page, totalPages);
  const offset = (normalizedPage - 1) * pageSize;
  const items = filtered.slice(offset, offset + pageSize);

  return {
    items,
    page: normalizedPage,
    pageSize,
    totalCount,
    totalPages,
    hasPrevPage: normalizedPage > 1,
    hasNextPage: normalizedPage < totalPages,
    associatedCount,
    failedCount,
    pendingCount,
  };
}

function buildFetchMock(params: {
  apps: AppRow[];
  afterAddApps?: AppRow[];
  keywordsByAppId: Record<string, unknown[]>;
  appDocsById?: Record<string, unknown>;
  topAppsByKeyword?: Record<string, { status: number; body: unknown }>;
  onAddKeywords?: (payload: any) => void;
  onSetFavorite?: (payload: any) => void;
  packageUpdate?: PackageUpdateStatus;
}) {
  let appsCallCount = 0;
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    if (method === "GET" && url === "/api/dashboard/version" && params.packageUpdate) {
      return jsonResponse(200, { success: true, data: params.packageUpdate });
    }

    if (method === "GET" && url === "/api/apps") {
      appsCallCount += 1;
      return jsonResponse(200, {
        success: true,
        data: withAppKinds(
          appsCallCount > 1 && params.afterAddApps ? params.afterAddApps : params.apps
        ),
      });
    }

    if (method === "GET" && url.startsWith("/api/aso/apps?")) {
      const query = new URLSearchParams(url.split("?")[1] ?? "");
      const ids = (query.get("ids") ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      const docs = ids
        .map((id) => params.appDocsById?.[id])
        .filter((value): value is unknown => value !== undefined);
      return jsonResponse(200, { success: true, data: docs });
    }

    if (method === "GET" && url.startsWith("/api/aso/keywords?")) {
      const query = new URLSearchParams(url.split("?")[1] ?? "");
      const appId = query.get("appId") ?? "";
      return jsonResponse(200, {
        success: true,
        data: buildKeywordPagedPayloadForQuery(
          params.keywordsByAppId[appId] ?? [],
          appId,
          query
        ),
      });
    }

    if (method === "GET" && url === "/api/aso/refresh-status") {
      return jsonResponse(200, {
        success: true,
        data: {
          status: "idle",
          startedAt: null,
          finishedAt: null,
          lastError: null,
          counters: {
            eligibleKeywordCount: 0,
            refreshedKeywordCount: 0,
            failedKeywordCount: 0,
            appListRefreshAttempted: false,
            appListRefreshSucceeded: false,
          },
        },
      });
    }

    if (method === "POST" && url === "/api/aso/keywords") {
      params.onAddKeywords?.(body);
      return jsonResponse(201, {
        success: true,
        data: { cachedCount: 0, pendingCount: 0, failedCount: 0 },
      });
    }

    if (method === "POST" && url === "/api/aso/keywords/favorite") {
      params.onSetFavorite?.(body);
      const appId = String(body?.appId ?? "");
      const keyword = String(body?.keyword ?? "").trim().toLowerCase();
      const nextIsFavorite = body?.isFavorite === true;
      const scoped = params.keywordsByAppId[appId] ?? [];
      for (const item of scoped) {
        const row = item as Record<string, unknown>;
        const rowKeyword = String(row.keyword ?? "").trim().toLowerCase();
        if (rowKeyword === keyword) {
          row.isFavorite = nextIsFavorite;
        }
      }
      return jsonResponse(200, {
        success: true,
        data: {
          appId,
          keyword,
          isFavorite: nextIsFavorite,
        },
      });
    }

    if (method === "GET" && url.startsWith("/api/aso/top-apps?")) {
      const query = new URLSearchParams(url.split("?")[1] ?? "");
      const keyword = decodeURIComponent(query.get("keyword") ?? "");
      const response = params.topAppsByKeyword?.[keyword];
      if (response) {
        return jsonResponse(response.status, response.body);
      }
      return jsonResponse(200, {
        success: true,
        data: {
          keyword,
          appDocs: [],
        },
      });
    }

    if (method === "DELETE" && url === "/api/aso/keywords") {
      return jsonResponse(200, {
        success: true,
        data: { removedCount: 1 },
      });
    }

    if (method === "POST" && url === "/api/aso/keywords/retry-failed") {
      return jsonResponse(200, {
        success: true,
        data: { retriedCount: 1, succeededCount: 1, failedCount: 0 },
      });
    }

    if (method === "POST" && url === "/api/aso/auth/start") {
      return jsonResponse(202, {
        success: true,
        data: {
          status: "in_progress",
          updatedAt: null,
          lastError: null,
          requiresTerminalAction: false,
          canPrompt: true,
        },
      });
    }

    if (method === "GET" && url === "/api/aso/auth/status") {
      return jsonResponse(200, {
        success: true,
        data: {
          status: "idle",
          updatedAt: null,
          lastError: null,
          requiresTerminalAction: false,
          canPrompt: true,
        },
      });
    }

    throw new Error(`Unhandled fetch: ${method} ${url}`);
  });
}

describe("dashboard app behaviors", () => {
  beforeEach(() => {
    setupMatchMediaMock();
    localStorage.clear();
  });

  it("validates add-keyword input without calling API", async () => {
    let addKeywordCallCount = 0;
    const fetchMock = buildFetchMock({
      apps: [{ id: DEFAULT_RESEARCH_APP_ID, name: "Research" }],
      keywordsByAppId: {
        [DEFAULT_RESEARCH_APP_ID]: [
          {
            keyword: "alpha",
            popularity: 20,
            difficultyScore: 10,
            appCount: 40,
            positions: [],
            updatedAt: "2026-03-12T08:00:00.000Z",
          },
        ],
      },
      onAddKeywords: () => {
        addKeywordCallCount += 1;
      },
    });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    await screen.findByText("alpha");
    const input = screen.getByPlaceholderText("Add keywords (comma-separated)");

    fireEvent.click(screen.getByRole("button", { name: "Add Keywords" }));
    expect(await screen.findByText("Please add at least one keyword.")).toBeInTheDocument();

    const tooManyKeywords = Array.from({ length: 300 }, (_, index) => `kw-${index}`).join(",");
    fireEvent.change(input, { target: { value: tooManyKeywords } });
    fireEvent.click(screen.getByRole("button", { name: "Add Keywords" }));
    expect(
      await screen.findByText("A maximum of 100 keywords is supported per request.")
    ).toBeInTheDocument();
    await waitFor(() => expect(addKeywordCallCount).toBe(0));

    fireEvent.change(input, { target: { value: "alpha, Alpha" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Keywords" }));
    await waitFor(() => expect(addKeywordCallCount).toBe(0));
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("clears add-keywords onboarding highlight after first successful add", async () => {
    let postedPayload: any = null;
    const fetchMock = buildFetchMock({
      apps: [{ id: DEFAULT_RESEARCH_APP_ID, name: "Research" }],
      afterAddApps: [
        {
          id: DEFAULT_RESEARCH_APP_ID,
          name: "Research",
          lastKeywordAddedAt: "2026-03-19T09:00:00.000Z",
        },
      ],
      keywordsByAppId: {
        [DEFAULT_RESEARCH_APP_ID]: [],
      },
      onAddKeywords: (payload) => {
        postedPayload = payload;
      },
    });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    const input = await screen.findByPlaceholderText("Add keywords (comma-separated)");
    expect(input).toHaveClass("onboarding-highlight");

    fireEvent.change(input, { target: { value: "new-term" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Keywords" }));

    await waitFor(() =>
      expect(postedPayload).toEqual({
        appId: DEFAULT_RESEARCH_APP_ID,
        keywords: ["new-term"],
        country: "US",
      })
    );
    await waitFor(() => expect(input).not.toHaveClass("onboarding-highlight"));
  });

  it("copies selected keyword from context menu and surfaces copy failures", async () => {
    localStorage.setItem("aso-dashboard:selected-app-id", "111");
    const writeText = jest.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const fetchMock = buildFetchMock({
      apps: [
        { id: DEFAULT_RESEARCH_APP_ID, name: "Research" },
        { id: "111", name: "Owned App" },
      ],
      keywordsByAppId: {
        "111": [
          {
            keyword: "copy-term",
            popularity: 30,
            difficultyScore: 20,
            appCount: 70,
            positions: [{ appId: "111", previousPosition: 5, currentPosition: 4 }],
            updatedAt: "2026-03-12T08:00:00.000Z",
          },
        ],
      },
    });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    const row = (await screen.findByText("copy-term")).closest("tr") as HTMLElement;
    fireEvent.contextMenu(row, { clientX: 25, clientY: 20 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("copy-term"));
    expect(
      await screen.findByText("Copied 1 keyword as comma-separated text.")
    ).toBeInTheDocument();

    writeText.mockRejectedValueOnce(new Error("blocked"));
    fireEvent.contextMenu(row, { clientX: 26, clientY: 21 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy" }));
    expect(await screen.findByText("Failed to copy keywords")).toBeInTheDocument();
  });

  it("copies selected keywords with Cmd/Ctrl+C", async () => {
    localStorage.setItem("aso-dashboard:selected-app-id", "111");
    const fetchMock = buildFetchMock({
      apps: [
        { id: DEFAULT_RESEARCH_APP_ID, name: "Research" },
        { id: "111", name: "Owned App" },
      ],
      keywordsByAppId: {
        "111": [
          {
            keyword: "shortcut-copy",
            popularity: 30,
            difficultyScore: 20,
            appCount: 70,
            positions: [{ appId: "111", previousPosition: 5, currentPosition: 4 }],
            updatedAt: "2026-03-12T08:00:00.000Z",
          },
        ],
      },
    });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    const row = (await screen.findByText("shortcut-copy")).closest("tr") as HTMLElement;
    fireEvent.click(row);
    const setData = jest.fn();
    fireEvent.copy(document, {
      clipboardData: { setData },
    });

    await waitFor(() => expect(setData).toHaveBeenCalledWith("text/plain", "shortcut-copy"));
    expect(
      await screen.findByText("Copied 1 keyword as comma-separated text.")
    ).toBeInTheDocument();
  });

  it.each([false, true])(
    "preserves manual copying in update instructions with selected keywords (clipboard blocked: %s)",
    async (clipboardBlocked) => {
      localStorage.setItem("aso-dashboard:selected-app-id", "111");
      const writeText = jest.fn(async () => {
        if (clipboardBlocked) throw new Error("blocked");
      });
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });
      const updateCommand = "npm install -g aso-cli@latest";
      global.fetch = buildFetchMock({
        apps: [{ id: "111", name: "Owned App" }],
        keywordsByAppId: {
          "111": [{ keyword: "selected-keyword", popularity: 30, difficultyScore: 20 }],
        },
        packageUpdate: {
          currentVersion: "0.19.0",
          latestVersion: "0.20.0",
          updateAvailable: true,
          updateCommand,
        },
      }) as typeof fetch;

      render(<App />);
      const row = (await screen.findByText("selected-keyword")).closest("tr") as HTMLElement;
      fireEvent.click(row);
      expect(row).toHaveClass("selected");
      fireEvent.click(await screen.findByRole("button", { name: "How to update" }));
      if (clipboardBlocked) {
        fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
        expect(await screen.findByText(/Couldn’t copy/)).toBeVisible();
        expect(writeText).toHaveBeenCalledWith(updateCommand);
      }

      const command = within(screen.getByRole("dialog")).getByText(updateCommand);
      const selection = window.getSelection()!;
      const range = document.createRange();
      range.selectNodeContents(command);
      selection.removeAllRanges();
      selection.addRange(range);
      try {
        const setData = jest.fn();
        const copyEvent = createEvent.copy(command, { clipboardData: { setData } });
        fireEvent(command, copyEvent);
        expect(copyEvent.defaultPrevented).toBe(false);
        expect(setData).not.toHaveBeenCalled();
        expect(selection.toString()).toBe(updateCommand);
      } finally {
        selection.removeAllRanges();
      }

      fireEvent.click(screen.getByRole("button", { name: "Close update instructions" }));
      const setData = jest.fn();
      fireEvent.copy(document, { clipboardData: { setData } });
      expect(setData).toHaveBeenCalledWith("text/plain", "selected-keyword");
    }
  );

  it("pastes clipboard text into add-keywords input with Cmd/Ctrl+V outside text fields", async () => {
    localStorage.setItem("aso-dashboard:selected-app-id", "111");
    const fetchMock = buildFetchMock({
      apps: [
        { id: DEFAULT_RESEARCH_APP_ID, name: "Research" },
        { id: "111", name: "Owned App" },
      ],
      keywordsByAppId: {
        "111": [],
      },
    });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    await screen.findByText("No keywords yet for this app.");
    const getData = jest.fn(() => "alpha, beta");
    fireEvent.paste(document, {
      clipboardData: { getData },
    });

    const input = screen.getByPlaceholderText("Add keywords (comma-separated)") as HTMLInputElement;
    await waitFor(() => expect(getData).toHaveBeenCalledWith("text"));
    await waitFor(() => expect(input.value).toBe("alpha, beta"));
  });

  it("deletes selected keywords with Delete key after confirmation", async () => {
    localStorage.setItem("aso-dashboard:selected-app-id", "111");
    const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);
    const fetchMock = buildFetchMock({
      apps: [
        { id: DEFAULT_RESEARCH_APP_ID, name: "Research" },
        { id: "111", name: "Owned App" },
      ],
      keywordsByAppId: {
        "111": [
          {
            keyword: "delete-shortcut",
            popularity: 30,
            difficultyScore: 20,
            appCount: 70,
            positions: [{ appId: "111", previousPosition: 5, currentPosition: 4 }],
            updatedAt: "2026-03-12T08:00:00.000Z",
          },
        ],
      },
    });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    const row = (await screen.findByText("delete-shortcut")).closest("tr") as HTMLElement;
    fireEvent.click(row);
    fireEvent.keyDown(document, { key: "Delete" });

    await waitFor(() =>
      expect(confirmSpy).toHaveBeenCalledWith('Delete "delete-shortcut" from Owned App?')
    );
    expect(await screen.findByText("Deleted 1 keyword.")).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it("applies popularity filter and resets all filters", async () => {
    localStorage.setItem("aso-dashboard:selected-app-id", "111");
    const fetchMock = buildFetchMock({
      apps: [
        { id: DEFAULT_RESEARCH_APP_ID, name: "Research" },
        { id: "111", name: "Owned App" },
      ],
      keywordsByAppId: {
        "111": [
          {
            keyword: "low-pop",
            popularity: 20,
            difficultyScore: 20,
            appCount: 80,
            positions: [{ appId: "111", previousPosition: 12, currentPosition: 10 }],
            updatedAt: "2026-03-12T08:00:00.000Z",
          },
          {
            keyword: "high-pop",
            popularity: 80,
            difficultyScore: 45,
            appCount: 90,
            positions: [{ appId: "111", previousPosition: 20, currentPosition: 14 }],
            updatedAt: "2026-03-12T08:05:00.000Z",
          },
        ],
      },
    });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    await screen.findByText("low-pop");
    await screen.findByText("high-pop");
    fireEvent.click(screen.getByLabelText("Popularity filter"));
    const menu = await screen.findByText("Minimum popularity");
    fireEvent.click(within(menu.closest(".filter-menu-content") as HTMLElement).getByRole("button", { name: "50" }));

    await waitFor(() => {
      expect(screen.queryByText("low-pop")).not.toBeInTheDocument();
      expect(screen.getByText("high-pop")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    await waitFor(() => {
      expect(screen.getByText("low-pop")).toBeInTheDocument();
      expect(screen.getByText("high-pop")).toBeInTheDocument();
    });
  });

  it("applies, persists, and resets brand filter", async () => {
    localStorage.setItem("aso-dashboard:selected-app-id", "111");
    const fetchMock = buildFetchMock({
      apps: [
        { id: DEFAULT_RESEARCH_APP_ID, name: "Research" },
        { id: "111", name: "Owned App" },
      ],
      keywordsByAppId: {
        "111": [
          {
            keyword: "brand-term",
            popularity: 70,
            difficultyScore: 30,
            isBrandKeyword: true,
            appCount: 80,
            positions: [{ appId: "111", previousPosition: 12, currentPosition: 10 }],
            updatedAt: "2026-03-12T08:00:00.000Z",
          },
          {
            keyword: "non-brand-term",
            popularity: 75,
            difficultyScore: 32,
            isBrandKeyword: false,
            appCount: 85,
            positions: [{ appId: "111", previousPosition: 20, currentPosition: 14 }],
            updatedAt: "2026-03-12T08:05:00.000Z",
          },
          {
            keyword: "unknown-term",
            popularity: 60,
            difficultyScore: null,
            isBrandKeyword: null,
            appCount: null,
            positions: [{ appId: "111", previousPosition: null, currentPosition: null }],
            updatedAt: "2026-03-12T08:10:00.000Z",
          },
        ],
      },
    });
    global.fetch = fetchMock as typeof fetch;

    const { unmount } = render(<App />);
    await screen.findByText("brand-term");
    await screen.findByText("non-brand-term");
    await screen.findByText("unknown-term");

    fireEvent.click(screen.getByLabelText("Brand filter"));
    const menu = await screen.findByText("Brand", {
      selector: ".filter-menu-label",
    });
    fireEvent.click(
      within(menu.closest(".filter-menu-content") as HTMLElement).getByRole("button", {
        name: "Brand",
      })
    );

    await waitFor(() => {
      expect(screen.getByText("brand-term")).toBeInTheDocument();
      expect(screen.queryByText("non-brand-term")).not.toBeInTheDocument();
      expect(screen.queryByText("unknown-term")).not.toBeInTheDocument();
    });

    unmount();
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("brand-term")).toBeInTheDocument();
      expect(screen.queryByText("non-brand-term")).not.toBeInTheDocument();
      expect(screen.queryByText("unknown-term")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    await waitFor(() => {
      expect(screen.getByText("brand-term")).toBeInTheDocument();
      expect(screen.getByText("non-brand-term")).toBeInTheDocument();
      expect(screen.getByText("unknown-term")).toBeInTheDocument();
    });
  });

  it("toggles keyword favorites and filters by favorite status", async () => {
    localStorage.setItem("aso-dashboard:selected-app-id", "111");
    let favoritePayload: any = null;
    const fetchMock = buildFetchMock({
      apps: [
        { id: DEFAULT_RESEARCH_APP_ID, name: "Research" },
        { id: "111", name: "Owned App" },
      ],
      keywordsByAppId: {
        "111": [
          {
            keyword: "fav-one",
            popularity: 65,
            difficultyScore: 25,
            isFavorite: false,
            appCount: 80,
            positions: [{ appId: "111", previousPosition: 10, currentPosition: 8 }],
            updatedAt: "2026-03-12T08:00:00.000Z",
          },
          {
            keyword: "fav-two",
            popularity: 72,
            difficultyScore: 31,
            isFavorite: true,
            appCount: 84,
            positions: [{ appId: "111", previousPosition: 12, currentPosition: 9 }],
            updatedAt: "2026-03-12T08:05:00.000Z",
          },
          {
            keyword: "not-fav",
            popularity: 75,
            difficultyScore: 33,
            isFavorite: false,
            appCount: 90,
            positions: [{ appId: "111", previousPosition: 16, currentPosition: 14 }],
            updatedAt: "2026-03-12T08:10:00.000Z",
          },
        ],
      },
      onSetFavorite: (payload) => {
        favoritePayload = payload;
      },
    });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    await screen.findByText("fav-one");
    await screen.findByText("fav-two");
    await screen.findByText("not-fav");

    fireEvent.click(screen.getByRole("button", { name: "Favorite keyword fav-one" }));
    await waitFor(() =>
      expect(favoritePayload).toEqual({
        appId: "111",
        keyword: "fav-one",
        isFavorite: true,
        country: "US",
      })
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Unfavorite keyword fav-one" })
      ).toBeInTheDocument()
    );

    fireEvent.click(screen.getByLabelText("Favorite filter"));
    const menu = await screen.findByText("Favorite", {
      selector: ".filter-menu-label",
    });
    fireEvent.click(
      within(menu.closest(".filter-menu-content") as HTMLElement).getByRole("button", {
        name: "Favorite",
      })
    );

    await waitFor(() => {
      expect(screen.getByText("fav-one")).toBeInTheDocument();
      expect(screen.getByText("fav-two")).toBeInTheDocument();
      expect(screen.queryByText("not-fav")).not.toBeInTheDocument();
    });
  });

  it("keeps numeric filters after remount but clears keyword text search", async () => {
    localStorage.setItem("aso-dashboard:selected-app-id", "111");
    const fetchMock = buildFetchMock({
      apps: [
        { id: DEFAULT_RESEARCH_APP_ID, name: "Research" },
        { id: "111", name: "Owned App" },
      ],
      keywordsByAppId: {
        "111": [
          {
            keyword: "low-pop",
            popularity: 20,
            difficultyScore: 20,
            appCount: 80,
            positions: [{ appId: "111", previousPosition: 12, currentPosition: 10 }],
            updatedAt: "2026-03-12T08:00:00.000Z",
          },
          {
            keyword: "high-pop",
            popularity: 80,
            difficultyScore: 45,
            appCount: 90,
            positions: [{ appId: "111", previousPosition: 20, currentPosition: 14 }],
            updatedAt: "2026-03-12T08:05:00.000Z",
          },
        ],
      },
    });
    global.fetch = fetchMock as typeof fetch;

    const { unmount } = render(<App />);

    await screen.findByText("low-pop");
    await screen.findByText("high-pop");

    fireEvent.click(screen.getByLabelText("Popularity filter"));
    const menu = await screen.findByText("Minimum popularity");
    fireEvent.click(
      within(menu.closest(".filter-menu-content") as HTMLElement).getByRole("button", {
        name: "50",
      })
    );
    fireEvent.change(screen.getByLabelText("Keyword search"), {
      target: { value: "high" },
    });

    await waitFor(() => {
      expect(screen.queryByText("low-pop")).not.toBeInTheDocument();
      expect(screen.getByText("high-pop")).toBeInTheDocument();
      expect(screen.getByLabelText("Keyword search")).toHaveValue("high");
    });

    unmount();
    render(<App />);

    const keywordSearchInput = (await screen.findByLabelText(
      "Keyword search"
    )) as HTMLInputElement;

    await waitFor(() => {
      expect(screen.queryByText("low-pop")).not.toBeInTheDocument();
      expect(screen.getByText("high-pop")).toBeInTheDocument();
      expect(keywordSearchInput.value).toBe("");
    });
  });

  it("renders top-apps empty and error states", async () => {
    localStorage.setItem("aso-dashboard:selected-app-id", "111");
    const fetchMock = buildFetchMock({
      apps: [
        { id: DEFAULT_RESEARCH_APP_ID, name: "Research" },
        { id: "111", name: "Owned App" },
      ],
      keywordsByAppId: {
        "111": [
          {
            keyword: "empty-case",
            popularity: 65,
            difficultyScore: 32,
            appCount: 75,
            positions: [{ appId: "111", previousPosition: 15, currentPosition: 11 }],
            updatedAt: "2026-03-12T08:00:00.000Z",
          },
          {
            keyword: "error-case",
            popularity: 66,
            difficultyScore: 33,
            appCount: 76,
            positions: [{ appId: "111", previousPosition: 16, currentPosition: 12 }],
            updatedAt: "2026-03-12T08:00:00.000Z",
          },
        ],
      },
      topAppsByKeyword: {
        "empty-case": {
          status: 200,
          body: {
            success: true,
            data: { keyword: "empty-case", appDocs: [] },
          },
        },
        "error-case": {
          status: 500,
          body: {
            success: false,
            error: "backend failure",
          },
        },
      },
    });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    await screen.findByText("empty-case");
    fireEvent.click(screen.getAllByRole("button", { name: "Top Apps" })[0]);
    expect(await screen.findByText("No app data found for this keyword.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    fireEvent.click(screen.getAllByRole("button", { name: "Top Apps" })[1]);
    expect(await screen.findByText("Failed to load top apps")).toBeInTheDocument();
  });

  it("selects owned app when clicking sidebar text content", async () => {
    const fetchMock = buildFetchMock({
      apps: [
        { id: DEFAULT_RESEARCH_APP_ID, name: "Research" },
        { id: "111", name: "Owned App" },
      ],
      keywordsByAppId: {
        [DEFAULT_RESEARCH_APP_ID]: [
          {
            keyword: "research-term",
            popularity: 20,
            difficultyScore: 10,
            appCount: 30,
            positions: [],
            updatedAt: "2026-03-12T08:00:00.000Z",
          },
        ],
        "111": [
          {
            keyword: "owned-term",
            popularity: 40,
            difficultyScore: 25,
            appCount: 44,
            positions: [{ appId: "111", previousPosition: 6, currentPosition: 5 }],
            updatedAt: "2026-03-12T08:00:00.000Z",
          },
        ],
      },
      appDocsById: {
        "111": { appId: "111", name: "Owned App" },
      },
    });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    await screen.findByText("research-term");
    fireEvent.click(await screen.findByText("Owned App"));
    expect(await screen.findByText("owned-term")).toBeInTheDocument();
  });

  it("selects owned app via keyboard and copies app id", async () => {
    const writeText = jest.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const fetchMock = buildFetchMock({
      apps: [
        { id: DEFAULT_RESEARCH_APP_ID, name: "Research" },
        {
          id: "111",
          name: "Owned App",
          averageUserRating: 4.5,
          previousAverageUserRating: 4.2,
          userRatingCount: 1200,
          previousUserRatingCount: 1000,
          icon: {
            template: "https://example.com/icon/{w}x{h}.{f}",
          },
        },
      ],
      appDocsById: {
        "111": {
          appId: "111",
          name: "Owned App",
          averageUserRating: 4.5,
          previousAverageUserRating: 4.2,
          userRatingCount: 1200,
          previousUserRatingCount: 1000,
          icon: {
            template: "https://example.com/icon/{w}x{h}.{f}",
          },
        },
      },
      keywordsByAppId: {
        [DEFAULT_RESEARCH_APP_ID]: [],
        "111": [],
      },
    });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    const ownedTab = (await screen.findByText("Owned App")).closest("[role='tab']") as HTMLElement;
    fireEvent.keyDown(ownedTab, { key: "Enter" });
    await screen.findByLabelText("Rating summary");

    fireEvent.click(screen.getAllByRole("button", { name: "Copy app ID 111" })[0]);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("111"));
  });
});
