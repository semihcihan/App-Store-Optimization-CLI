/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "./App";
import { DEFAULT_RESEARCH_APP_ID } from "../shared/aso-research";

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

function buildFetchMock(params: {
  apps: AppRow[];
  keywordsByAppId: Record<string, unknown[]>;
  appDocsById?: Record<string, unknown>;
  topAppsByKeyword?: Record<string, { status: number; body: unknown }>;
  onAddKeywords?: (payload: any) => void;
}) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    if (method === "GET" && url === "/api/apps") {
      return jsonResponse(200, { success: true, data: withAppKinds(params.apps) });
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

    if (method === "POST" && url === "/api/aso/keywords") {
      params.onAddKeywords?.(body);
      return jsonResponse(201, {
        success: true,
        data: { cachedCount: 0, pendingCount: 0, failedCount: 0 },
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
