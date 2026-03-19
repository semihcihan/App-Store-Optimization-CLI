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

function buildFetchMock(params: {
  initialApps: AppRow[];
  afterAddApps?: AppRow[];
  keywordsByAppId: Record<string, unknown[]>;
  appDocsById?: Record<string, unknown>;
  topAppsByKeyword?: Record<string, unknown>;
  appSearchByTerm?: Record<string, { appDocs: unknown[] }>;
  onPostApps?: (payload: any) => void;
  onDeleteKeywords?: (payload: any) => void;
  onRetryFailed?: (payload: any) => void;
}) {
  let appsCallCount = 0;
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
        data: params.keywordsByAppId[appId] ?? [],
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
    fireEvent.click(screen.getByRole("button", { name: "Retry Failed (1)" }));

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
    expect(screen.queryByRole("button", { name: /Retry Failed/i })).toBeNull();
  });

  it("opens top apps dialog and supports context delete", async () => {
    let deletedBody: any = null;
    const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);
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
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

    await waitFor(() =>
      expect(deletedBody).toEqual({
        appId: "111",
        keywords: ["meditation"],
        country: "US",
      })
    );
    expect(confirmSpy).toHaveBeenCalled();
  });
});
