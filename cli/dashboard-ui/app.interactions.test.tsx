/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "./App";
import { DEFAULT_RESEARCH_APP_ID } from "../shared/aso-research";

type AppKind = "owned" | "research";
type AppRow = { id: string; name: string; kind?: AppKind };

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

function toKeywordPagedPayload(items: unknown[]) {
  const statuses = items.map((item) => {
    const row = item as { keywordStatus?: string; difficultyScore?: number | null };
    if (row.keywordStatus === "failed") return "failed";
    if (row.keywordStatus === "pending") return "pending";
    if (row.keywordStatus === "ok") return "ok";
    return row.difficultyScore == null ? "pending" : "ok";
  });
  return {
    items,
    page: 1,
    pageSize: 100,
    totalCount: items.length,
    totalPages: 1,
    hasPrevPage: false,
    hasNextPage: false,
    associatedCount: items.length,
    failedCount: statuses.filter((status) => status === "failed").length,
    pendingCount: statuses.filter((status) => status === "pending").length,
  };
}

function buildFetchMock(params: {
  initialApps: AppRow[];
  afterAddApps?: AppRow[];
  keywordsByAppId: Record<string, unknown[]>;
  appDocsById?: Record<string, unknown>;
  topAppsByKeyword?: Record<string, unknown>;
  historyByKeyword?: Record<string, { points: unknown[] }>;
  appSearchByTerm?: Record<string, { appDocs: unknown[] }>;
  dashboardSettings?: {
    includeResearchAppsInKeywordRefresh: boolean;
    refreshMode: "startup" | "manual";
  };
  refreshStatusData?: Record<string, unknown>;
  refreshStatusSequence?: Array<Record<string, unknown>>;
  onGetRefreshStatus?: (callCount: number) => Record<string, unknown>;
  refreshStartData?: Record<string, unknown>;
  refreshStartResponse?: Promise<Response>;
  onPatchDashboardSettings?: (payload: any) => void;
  onPostRefreshStart?: () => void;
  onPostApps?: (payload: any) => void;
  onDeleteApps?: (payload: any) => void;
  onDeleteKeywords?: (payload: any) => void;
  onRetryFailed?: (payload: any) => void;
}) {
  let appsCallCount = 0;
  let dashboardSettings =
    params.dashboardSettings ?? {
      includeResearchAppsInKeywordRefresh: true,
      refreshMode: "startup" as const,
    };
  let refreshStatusCallCount = 0;
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    if (method === "GET" && url === "/api/apps") {
      appsCallCount += 1;
      return jsonResponse(200, {
        success: true,
        data: withAppKinds(
          appsCallCount > 1 && params.afterAddApps
            ? params.afterAddApps
            : params.initialApps
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

    if (method === "GET" && url.startsWith("/api/aso/apps/search?")) {
      const query = new URLSearchParams(url.split("?")[1] ?? "");
      const term = decodeURIComponent(query.get("term") ?? "");
      const payload = params.appSearchByTerm?.[term] ?? { appDocs: [] };
      return jsonResponse(200, {
        success: true,
        data: {
          term,
          appDocs: payload.appDocs,
        },
      });
    }

    if (method === "GET" && url.startsWith("/api/aso/keywords?")) {
      const query = new URLSearchParams(url.split("?")[1] ?? "");
      const appId = query.get("appId") ?? "";
      return jsonResponse(200, {
        success: true,
        data: toKeywordPagedPayload(params.keywordsByAppId[appId] ?? []),
      });
    }

    if (method === "GET" && url.startsWith("/api/aso/keywords/history?")) {
      const query = new URLSearchParams(url.split("?")[1] ?? "");
      const keyword = decodeURIComponent(query.get("keyword") ?? "");
      const appId = query.get("appId") ?? "";
      return jsonResponse(200, {
        success: true,
        data: {
          appId,
          keyword,
          points: params.historyByKeyword?.[keyword]?.points ?? [],
        },
      });
    }

    if (method === "GET" && url === "/api/aso/refresh-status") {
      const defaultRefreshStatus = {
        status: "idle",
        startedAt: null,
        finishedAt: null,
        lastError: null,
        requiresReauthentication: false,
        counters: {
          eligibleKeywordCount: 0,
          refreshedKeywordCount: 0,
          failedKeywordCount: 0,
          appListRefreshAttempted: false,
          appListRefreshSucceeded: false,
        },
      };
      const data =
        params.onGetRefreshStatus?.(refreshStatusCallCount) ??
        params.refreshStatusSequence?.[
          Math.min(refreshStatusCallCount, params.refreshStatusSequence.length - 1)
        ] ??
        params.refreshStatusData ??
        defaultRefreshStatus;
      refreshStatusCallCount += 1;
      return jsonResponse(200, {
        success: true,
        data,
      });
    }

    if (method === "POST" && url === "/api/aso/refresh/start") {
      params.onPostRefreshStart?.();
      if (params.refreshStartResponse) {
        return params.refreshStartResponse;
      }
      return jsonResponse(202, {
        success: true,
        data:
          params.refreshStartData ??
          {
            status: "running",
            startedAt: "2026-06-13T12:00:00.000Z",
            finishedAt: null,
            lastError: null,
            requiresReauthentication: false,
            counters: {
              eligibleKeywordCount: 1,
              refreshedKeywordCount: 0,
              failedKeywordCount: 0,
            },
          },
      });
    }

    if (method === "GET" && url === "/api/dashboard/settings") {
      return jsonResponse(200, {
        success: true,
        data: dashboardSettings,
      });
    }

    if (method === "PATCH" && url === "/api/dashboard/settings") {
      params.onPatchDashboardSettings?.(body);
      dashboardSettings = {
        ...dashboardSettings,
        ...body,
      };
      return jsonResponse(200, {
        success: true,
        data: dashboardSettings,
      });
    }

    if (method === "POST" && url === "/api/apps") {
      params.onPostApps?.(body);
      return jsonResponse(201, {
        success: true,
        data: {
          id: body.type === "app" ? body.appId : "research:new-research",
          name: body.type === "app" ? "Owned App" : body.name,
        },
      });
    }

    if (method === "DELETE" && url === "/api/apps") {
      params.onDeleteApps?.(body);
      return jsonResponse(200, {
        success: true,
        data: {
          id: body.appId,
          removedKeywordCount: 0,
        },
      });
    }

    if (method === "POST" && url === "/api/aso/top-apps") {
      return jsonResponse(500, { success: false, error: "not used" });
    }

    if (method === "GET" && url.startsWith("/api/aso/top-apps?")) {
      const query = new URLSearchParams(url.split("?")[1] ?? "");
      const keyword = decodeURIComponent(query.get("keyword") ?? "");
      return jsonResponse(200, {
        success: true,
        data: params.topAppsByKeyword?.[keyword] ?? { keyword, appDocs: [] },
      });
    }

    if (method === "DELETE" && url === "/api/aso/keywords") {
      params.onDeleteKeywords?.(body);
      return jsonResponse(200, { success: true, data: { removedCount: 1 } });
    }

    if (method === "POST" && url === "/api/aso/keywords/retry-failed") {
      params.onRetryFailed?.(body);
      return jsonResponse(200, {
        success: true,
        data: {
          retriedCount: 1,
          succeededCount: 1,
          failedCount: 0,
        },
      });
    }

    if (method === "POST" && url === "/api/aso/keywords") {
      return jsonResponse(201, {
        success: true,
        data: { cachedCount: 0, pendingCount: 0, failedCount: 0 },
      });
    }

    throw new Error(`Unhandled fetch: ${method} ${url}`);
  });
}

describe("dashboard app interactions", () => {
  beforeEach(() => {
    setupMatchMediaMock();
    localStorage.clear();
  });

  it("adds selected apps from search and sends app payload", async () => {
    let postedPayload: any = null;
    const fetchMock = buildFetchMock({
      initialApps: [{ id: DEFAULT_RESEARCH_APP_ID, name: "Research" }],
      afterAddApps: [
        { id: DEFAULT_RESEARCH_APP_ID, name: "Research" },
        { id: "123", name: "Owned App" },
      ],
      keywordsByAppId: {
        [DEFAULT_RESEARCH_APP_ID]: [],
        "123": [],
      },
      appDocsById: {
        "123": { appId: "123", name: "Owned App", averageUserRating: 4.8, userRatingCount: 12 },
      },
      appSearchByTerm: {
        "123": {
          appDocs: [{ appId: "123", name: "Owned App" }],
        },
      },
      onPostApps: (payload) => {
        postedPayload = payload;
      },
    });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    await screen.findByRole("tab", { name: "Research" });
    expect(
      screen.getByPlaceholderText("Add keywords (comma-separated)")
    ).toHaveClass("onboarding-highlight");
    expect(screen.getByRole("button", { name: "Add app" })).toHaveClass(
      "onboarding-highlight"
    );
    fireEvent.click(screen.getByRole("button", { name: "Add app" }));
    await screen.findByRole("dialog", { name: "Add app" });

    fireEvent.change(
      screen.getByPlaceholderText(
        "Search apps, app IDs, or developer names."
      ),
      {
      target: { value: "123" },
      }
    );
    const appResult = await screen.findByRole("button", { name: /Owned App/i });
    fireEvent.click(appResult);
    fireEvent.click(screen.getByRole("button", { name: "Add Selected (1)" }));

    await waitFor(() => expect(postedPayload).toEqual({ type: "app", appId: "123" }));
    await screen.findByText("Added 1 item.");
    expect(screen.getByText("Owned App")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add app" })).not.toHaveClass(
      "onboarding-highlight"
    );
    expect(
      screen.getByPlaceholderText("Add keywords (comma-separated)")
    ).toHaveClass("onboarding-highlight");
  });

  it("retries failed keywords and shows result", async () => {
    let retryBody: any = null;
    const fetchMock = buildFetchMock({
      initialApps: [
        { id: DEFAULT_RESEARCH_APP_ID, name: "Research" },
        { id: "111", name: "Owned App" },
      ],
      keywordsByAppId: {
        "111": [
          {
            keyword: "failed-term",
            popularity: 55,
            difficultyScore: null,
            appCount: 90,
            keywordStatus: "failed",
            positions: [{ appId: "111", previousPosition: 9, currentPosition: 7 }],
            updatedAt: "2026-03-10T10:00:00.000Z",
          },
        ],
      },
      onRetryFailed: (payload) => {
        retryBody = payload;
      },
    });
    global.fetch = fetchMock as typeof fetch;
    localStorage.setItem("aso-dashboard:selected-app-id", "111");

    render(<App />);

    const failedKeywordCell = await screen.findByText("failed-term");
    const failedRow = failedKeywordCell.closest("tr");
    expect(failedRow).not.toBeNull();
    const cells = within(failedRow as HTMLElement).getAllByRole("cell");
    expect(cells[2]).toHaveTextContent("-");
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh failed keywords (1)" })
    );

    await waitFor(() =>
      expect(retryBody).toEqual({ appId: "111", country: "US" })
    );
    await screen.findByText(
      "Retried 1 failed keyword: 1 succeeded."
    );
  });

  it("hides retry button when there are no failed keywords", async () => {
    const fetchMock = buildFetchMock({
      initialApps: [
        { id: DEFAULT_RESEARCH_APP_ID, name: "Research" },
        { id: "111", name: "Owned App" },
      ],
      keywordsByAppId: {
        "111": [
          {
            keyword: "healthy-term",
            popularity: 55,
            difficultyScore: 45,
            appCount: 90,
            keywordStatus: "ok",
            positions: [{ appId: "111", previousPosition: 9, currentPosition: 7 }],
            updatedAt: "2026-03-10T10:00:00.000Z",
          },
        ],
      },
    });
    global.fetch = fetchMock as typeof fetch;
    localStorage.setItem("aso-dashboard:selected-app-id", "111");

    render(<App />);

    await screen.findByText("healthy-term");
    expect(
      screen.queryByRole("button", { name: /Refresh failed keywords/i })
    ).toBeNull();
  });

  it("opens position history dialog from rank/change cells", async () => {
    const fetchMock = buildFetchMock({
      initialApps: [
        { id: DEFAULT_RESEARCH_APP_ID, name: "Research" },
        { id: "111", name: "Owned App" },
      ],
      keywordsByAppId: {
        "111": [
          {
            keyword: "meditation",
            popularity: 60,
            difficultyScore: 40,
            appCount: 88,
            positions: [{ appId: "111", previousPosition: 6, currentPosition: 4 }],
            updatedAt: "2026-03-10T11:00:00.000Z",
          },
        ],
      },
      historyByKeyword: {
        meditation: {
          points: [
            {
              capturedAt: "2026-03-01T11:00:00.000Z",
              position: 9,
            },
            {
              capturedAt: "2026-03-10T11:00:00.000Z",
              position: 4,
            },
          ],
        },
      },
    });
    global.fetch = fetchMock as typeof fetch;
    localStorage.setItem("aso-dashboard:selected-app-id", "111");

    render(<App />);

    const keywordCell = await screen.findByText("meditation");
    const row = keywordCell.closest("tr") as HTMLElement;
    const rankCell = within(row).getAllByRole("cell")[3];
    const rankTrigger = within(rankCell).getByRole("button", { name: "4" });
    fireEvent.click(rankTrigger);

    const dialog = await screen.findByRole("dialog", {
      name: "Position history for meditation",
    });
    expect(within(dialog).getByText(/Best rank:/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Worst rank:/)).toBeInTheDocument();
  });

  it("opens top apps dialog and supports context delete", async () => {
    let deletedBody: any = null;
    const fetchMock = buildFetchMock({
      initialApps: [
        { id: DEFAULT_RESEARCH_APP_ID, name: "Research" },
        { id: "111", name: "Owned App" },
      ],
      keywordsByAppId: {
        "111": [
          {
            keyword: "meditation",
            popularity: 60,
            difficultyScore: 40,
            appCount: 88,
            positions: [{ appId: "111", previousPosition: 6, currentPosition: 4 }],
            updatedAt: "2026-03-10T11:00:00.000Z",
          },
        ],
      },
      topAppsByKeyword: {
        meditation: {
          keyword: "meditation",
          appDocs: [
            {
              appId: "app1",
              name: "Calm App",
              subtitle: "Breathe",
              averageUserRating: 4.7,
              userRatingCount: 1500,
              releaseDate: "2020-01-01T00:00:00.000Z",
              currentVersionReleaseDate: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
      },
      onDeleteKeywords: (payload) => {
        deletedBody = payload;
      },
    });
    global.fetch = fetchMock as typeof fetch;
    localStorage.setItem("aso-dashboard:selected-app-id", "111");

    render(<App />);

    const keywordCell = await screen.findByText("meditation");
    fireEvent.click(screen.getByRole("button", { name: "Top Apps" }));
    const dialog = await screen.findByRole("dialog", {
      name: 'Top apps for meditation',
    });
    await within(dialog).findByText("Calm App");

    const appStoreLink = within(dialog).getByRole("link", { name: "Open in App Store" });
    expect(appStoreLink).toHaveAttribute("href", expect.stringContaining("apps.apple.com"));
    expect(appStoreLink).toHaveAttribute("target", "_blank");
    expect(appStoreLink).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(appStoreLink).toHaveAttribute("rel", expect.stringContaining("noreferrer"));

    fireEvent.contextMenu(keywordCell.closest("tr") as HTMLElement, {
      clientX: 50,
      clientY: 50,
    });
    const deleteMenuItem = await screen.findByRole("menuitem", { name: "Delete" });
    expect(deleteMenuItem.closest(".keyword-action-menu")).toHaveStyle({
      left: "50px",
      top: "50px",
    });
    fireEvent.click(deleteMenuItem);

    const confirmDialog = await screen.findByRole("dialog", {
      name: "Delete keywords?",
    });
    expect(confirmDialog).toHaveStyle({
      left: "50px",
      top: "50px",
    });
    fireEvent.click(within(confirmDialog).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(deletedBody).toEqual({
        appId: "111",
        keywords: ["meditation"],
        country: "US",
      })
    );
  });

  it("deletes an app from sidebar using right-click action", async () => {
    let deleteAppBody: any = null;
    const fetchMock = buildFetchMock({
      initialApps: [
        { id: DEFAULT_RESEARCH_APP_ID, name: "Research" },
        { id: "111", name: "Owned App" },
      ],
      afterAddApps: [{ id: DEFAULT_RESEARCH_APP_ID, name: "Research" }],
      keywordsByAppId: {
        [DEFAULT_RESEARCH_APP_ID]: [],
        "111": [],
      },
      onDeleteApps: (payload) => {
        deleteAppBody = payload;
      },
    });
    global.fetch = fetchMock as typeof fetch;
    localStorage.setItem("aso-dashboard:selected-app-id", "111");

    render(<App />);

    const appName = await screen.findByText("Owned App");
    fireEvent.contextMenu(appName.closest(".app-item") as HTMLElement, {
      clientX: 72,
      clientY: 90,
    });
    const deleteMenuItem = await screen.findByRole("menuitem", { name: "Delete" });
    expect(deleteMenuItem.closest(".app-action-menu")).toHaveStyle({
      left: "72px",
      top: "90px",
    });
    fireEvent.click(deleteMenuItem);

    const confirmDialog = await screen.findByRole("dialog", {
      name: "Delete app?",
    });
    expect(confirmDialog).toHaveStyle({
      left: "72px",
      top: "90px",
    });
    fireEvent.click(within(confirmDialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleteAppBody).toEqual({ appId: "111" }));
    await screen.findByText('Deleted "Owned App".');
    expect(screen.queryByText("Owned App")).toBeNull();
  });

  it("opens settings and auto-saves refresh settings", async () => {
    const patchCalls: any[] = [];
    const fetchMock = buildFetchMock({
      initialApps: [{ id: DEFAULT_RESEARCH_APP_ID, name: "Research" }],
      keywordsByAppId: {
        [DEFAULT_RESEARCH_APP_ID]: [],
      },
      onPatchDashboardSettings: (payload) => {
        patchCalls.push(payload);
      },
    });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Open settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    const researchSwitch = within(dialog).getByRole("switch", {
      name: "Include research apps on keyword refresh",
    });

    expect(researchSwitch).toHaveAttribute("aria-checked", "true");
    fireEvent.click(researchSwitch);

    await waitFor(() =>
      expect(patchCalls).toContainEqual({
        includeResearchAppsInKeywordRefresh: false,
      })
    );
    expect(researchSwitch).toHaveAttribute("aria-checked", "false");

    fireEvent.click(within(dialog).getByRole("button", { name: "Manual only" }));
    await waitFor(() =>
      expect(patchCalls).toContainEqual({ refreshMode: "manual" })
    );
  });

  it("shows refreshed feedback when manual refresh completes immediately", async () => {
    let refreshStartCount = 0;
    const fetchMock = buildFetchMock({
      initialApps: [{ id: DEFAULT_RESEARCH_APP_ID, name: "Research" }],
      keywordsByAppId: {
        [DEFAULT_RESEARCH_APP_ID]: [],
      },
      dashboardSettings: {
        includeResearchAppsInKeywordRefresh: true,
        refreshMode: "manual",
      },
      onPostRefreshStart: () => {
        refreshStartCount += 1;
      },
      refreshStartData: {
        status: "completed",
        startedAt: "2026-06-13T12:00:00.000Z",
        finishedAt: "2026-06-13T12:00:00.050Z",
        lastError: null,
        requiresReauthentication: false,
        counters: {
          eligibleKeywordCount: 1,
          refreshedKeywordCount: 1,
          failedKeywordCount: 0,
        },
      },
    });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Open settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Refresh Now" }));

    await waitFor(() => expect(refreshStartCount).toBe(1));
    expect(await screen.findByText("Refreshed.")).toBeInTheDocument();
    expect(within(dialog).getByText("Refreshed")).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: "Refreshed" })
    ).toBeNull();
  });

  it("shows refreshing as a label while manual refresh start is pending", async () => {
    let resolveRefreshStart!: (response: Response) => void;
    const refreshStartResponse = new Promise<Response>((resolve) => {
      resolveRefreshStart = resolve;
    });
    const fetchMock = buildFetchMock({
      initialApps: [{ id: DEFAULT_RESEARCH_APP_ID, name: "Research" }],
      keywordsByAppId: {
        [DEFAULT_RESEARCH_APP_ID]: [],
      },
      dashboardSettings: {
        includeResearchAppsInKeywordRefresh: true,
        refreshMode: "manual",
      },
      refreshStartResponse,
    });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Open settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Refresh Now" }));

    expect(await within(dialog).findByText("Refreshing")).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: /Starting/i })
    ).toBeNull();
    expect(
      await screen.findByText("Refreshing local data in background...")
    ).toBeInTheDocument();

    resolveRefreshStart(
      jsonResponse(202, {
        success: true,
        data: {
          status: "completed",
          startedAt: "2026-06-13T12:00:00.000Z",
          finishedAt: "2026-06-13T12:00:00.050Z",
          lastError: null,
          requiresReauthentication: false,
          counters: {
            eligibleKeywordCount: 1,
            refreshedKeywordCount: 1,
            failedKeywordCount: 0,
          },
        },
      })
    );
    expect(await screen.findByText("Refreshed.")).toBeInTheDocument();
  });

  it("ignores stale terminal refresh snapshots while manual refresh start is pending", async () => {
    let resolveRefreshStart!: (response: Response) => void;
    let manualStartRequested = false;
    const refreshStartResponse = new Promise<Response>((resolve) => {
      resolveRefreshStart = resolve;
    });
    const staleCompletedRefresh = {
      status: "completed",
      startedAt: "2026-06-13T11:00:00.000Z",
      finishedAt: "2026-06-13T11:00:00.050Z",
      lastError: null,
      requiresReauthentication: false,
      counters: {
        eligibleKeywordCount: 5,
        refreshedKeywordCount: 5,
        failedKeywordCount: 0,
      },
    };
    const fetchMock = buildFetchMock({
      initialApps: [{ id: DEFAULT_RESEARCH_APP_ID, name: "Research" }],
      keywordsByAppId: {
        [DEFAULT_RESEARCH_APP_ID]: [],
      },
      dashboardSettings: {
        includeResearchAppsInKeywordRefresh: true,
        refreshMode: "manual",
      },
      onPostRefreshStart: () => {
        manualStartRequested = true;
      },
      onGetRefreshStatus: () =>
        manualStartRequested
          ? staleCompletedRefresh
          : {
              status: "idle",
              startedAt: null,
              finishedAt: null,
              lastError: null,
              requiresReauthentication: false,
              counters: {
                eligibleKeywordCount: 0,
                refreshedKeywordCount: 0,
                failedKeywordCount: 0,
              },
            },
      refreshStartResponse,
    });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Open settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Refresh Now" }));

    expect(await within(dialog).findByText("Refreshing")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Refreshed.")).toBeNull();
    expect(within(dialog).queryByText("Refreshed")).toBeNull();
    expect(within(dialog).getByText("Refreshing")).toBeInTheDocument();

    resolveRefreshStart(
      jsonResponse(202, {
        success: true,
        data: {
          status: "failed",
          startedAt: "2026-06-13T12:00:00.000Z",
          finishedAt: "2026-06-13T12:00:00.050Z",
          lastError: "Start failed",
          requiresReauthentication: false,
          counters: {
            eligibleKeywordCount: 0,
            refreshedKeywordCount: 0,
            failedKeywordCount: 0,
          },
        },
      })
    );

    expect(await screen.findByText("Background refresh failed.")).toBeInTheDocument();
    expect(screen.queryByText("Refreshed.")).toBeNull();
  });

  it("collapses and expands the research section", async () => {
    const fetchMock = buildFetchMock({
      initialApps: [
        { id: DEFAULT_RESEARCH_APP_ID, name: "Research" },
        { id: "research:ideas", name: "Ideas" },
      ],
      keywordsByAppId: {
        [DEFAULT_RESEARCH_APP_ID]: [],
        "research:ideas": [],
      },
    });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    await screen.findByRole("tab", { name: "Ideas" });
    fireEvent.click(screen.getByRole("button", { name: "Collapse Research section" }));
    expect(screen.queryByRole("tab", { name: "Ideas" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand Research section" }));
    await screen.findByRole("tab", { name: "Ideas" });
  });
});
