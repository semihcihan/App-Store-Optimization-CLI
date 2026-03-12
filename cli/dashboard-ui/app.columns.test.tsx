/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { App } from "./App";
import { DEFAULT_RESEARCH_APP_ID } from "../shared/aso-research";

type MockPayload = {
  status: number;
  body: unknown;
};

function jsonResponse(payload: MockPayload) {
  return {
    ok: payload.status >= 200 && payload.status < 300,
    status: payload.status,
    json: async () => payload.body,
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

type FetchMockOptions = {
  apps: Array<{ id: string; name: string }>;
  keywordsByAppId: Record<string, unknown[]>;
};

function buildFetchMock(options: FetchMockOptions) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();

    if (method === "GET" && url === "/api/apps") {
      return jsonResponse({ status: 200, body: { success: true, data: options.apps } });
    }

    if (method === "GET" && url.startsWith("/api/aso/apps?")) {
      return jsonResponse({ status: 200, body: { success: true, data: [] } });
    }

    if (method === "GET" && url.startsWith("/api/aso/keywords?")) {
      const params = new URLSearchParams(url.split("?")[1] ?? "");
      const appId = params.get("appId") ?? "";
      return jsonResponse({
        status: 200,
        body: {
          success: true,
          data: options.keywordsByAppId[appId] ?? [],
        },
      });
    }

    if (method === "GET" && url === "/api/aso/refresh-status") {
      return jsonResponse({
        status: 200,
        body: {
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
        },
      });
    }

    throw new Error(`Unhandled fetch: ${method} ${url}`);
  });
}

describe("dashboard keyword columns", () => {
  beforeEach(() => {
    setupMatchMediaMock();
    localStorage.clear();
  });

  it("hides rank and change columns but shows updated column for research apps", async () => {
    const fetchMock = buildFetchMock({
      apps: [{ id: DEFAULT_RESEARCH_APP_ID, name: "Research" }],
      keywordsByAppId: {
        [DEFAULT_RESEARCH_APP_ID]: [
          {
            keyword: "research-term",
            popularity: 50,
            difficultyScore: 32,
            appCount: 120,
            updatedAt: "2026-03-10T10:00:00.000Z",
            positions: [],
          },
        ],
      },
    });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    await screen.findByText("research-term");

    expect(screen.queryByRole("columnheader", { name: "Rank" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Change" })).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Updated" })).toBeInTheDocument();
  });

  it("shows rank, change, and updated columns for owned apps", async () => {
    localStorage.setItem("aso-dashboard:selected-app-id", "123456789");

    const fetchMock = buildFetchMock({
      apps: [
        { id: DEFAULT_RESEARCH_APP_ID, name: "Research" },
        { id: "123456789", name: "Owned App" },
      ],
      keywordsByAppId: {
        "123456789": [
          {
            keyword: "owned-term",
            popularity: 72,
            difficultyScore: 40,
            appCount: 88,
            updatedAt: "2026-03-10T11:00:00.000Z",
            positions: [{ appId: "123456789", previousPosition: 8, currentPosition: 5 }],
          },
        ],
      },
    });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    await screen.findByText("owned-term");

    expect(screen.getByRole("columnheader", { name: "Rank" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Change" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Updated" })).toBeInTheDocument();
  });

  it("uses global persisted sort when dashboard opens", async () => {
    localStorage.setItem("aso-dashboard:selected-app-id", "123456789");
    localStorage.setItem(
      "aso-dashboard:keyword-sort",
      JSON.stringify({ key: "popularity", dir: "asc" })
    );

    const fetchMock = buildFetchMock({
      apps: [
        { id: DEFAULT_RESEARCH_APP_ID, name: "Research" },
        { id: "123456789", name: "Owned App" },
      ],
      keywordsByAppId: {
        "123456789": [
          {
            keyword: "high-pop",
            popularity: 80,
            difficultyScore: 31,
            appCount: 71,
            updatedAt: "2026-03-10T10:00:00.000Z",
            positions: [{ appId: "123456789", previousPosition: 8, currentPosition: 4 }],
          },
          {
            keyword: "low-pop",
            popularity: 10,
            difficultyScore: 25,
            appCount: 64,
            updatedAt: "2026-03-10T11:00:00.000Z",
            positions: [{ appId: "123456789", previousPosition: 10, currentPosition: 7 }],
          },
        ],
      },
    });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);
    await screen.findByText("high-pop");
    await screen.findByText("low-pop");

    const rows = Array.from(document.querySelectorAll("#keywords-tbody tr"));
    expect(rows[0]).toHaveAttribute("data-keyword", "low-pop");
    expect(screen.getByRole("columnheader", { name: "Popularity" })).toHaveAttribute(
      "aria-sort",
      "ascending"
    );
  });

  it("falls back to updated desc when stored sort key is invalid", async () => {
    localStorage.setItem("aso-dashboard:selected-app-id", "123456789");
    localStorage.setItem(
      "aso-dashboard:keyword-sort",
      JSON.stringify({ key: "invalid", dir: "asc" })
    );

    const fetchMock = buildFetchMock({
      apps: [
        { id: DEFAULT_RESEARCH_APP_ID, name: "Research" },
        { id: "123456789", name: "Owned App" },
      ],
      keywordsByAppId: {
        "123456789": [
          {
            keyword: "older",
            popularity: 20,
            difficultyScore: 33,
            appCount: 72,
            updatedAt: "2026-03-10T09:00:00.000Z",
            positions: [{ appId: "123456789", previousPosition: 9, currentPosition: 6 }],
          },
          {
            keyword: "newer",
            popularity: 30,
            difficultyScore: 27,
            appCount: 67,
            updatedAt: "2026-03-10T12:00:00.000Z",
            positions: [{ appId: "123456789", previousPosition: 11, currentPosition: 8 }],
          },
        ],
      },
    });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);
    await screen.findByText("older");
    await screen.findByText("newer");

    const rows = Array.from(document.querySelectorAll("#keywords-tbody tr"));
    expect(rows[0]).toHaveAttribute("data-keyword", "newer");
    expect(screen.getByRole("columnheader", { name: "Updated" })).toHaveAttribute(
      "aria-sort",
      "descending"
    );
  });

  it("falls back to updated desc when stored sort column is unavailable", async () => {
    localStorage.setItem(
      "aso-dashboard:keyword-sort",
      JSON.stringify({ key: "rank", dir: "asc" })
    );

    const fetchMock = buildFetchMock({
      apps: [{ id: DEFAULT_RESEARCH_APP_ID, name: "Research" }],
      keywordsByAppId: {
        [DEFAULT_RESEARCH_APP_ID]: [
          {
            keyword: "older",
            popularity: 40,
            difficultyScore: 22,
            appCount: 101,
            updatedAt: "2026-03-10T08:00:00.000Z",
            positions: [],
          },
          {
            keyword: "newer",
            popularity: 45,
            difficultyScore: 27,
            appCount: 120,
            updatedAt: "2026-03-10T15:00:00.000Z",
            positions: [],
          },
        ],
      },
    });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);
    await screen.findByText("older");
    await screen.findByText("newer");

    const rows = Array.from(document.querySelectorAll("#keywords-tbody tr"));
    expect(rows[0]).toHaveAttribute("data-keyword", "newer");
    expect(screen.getByRole("columnheader", { name: "Updated" })).toHaveAttribute(
      "aria-sort",
      "descending"
    );
  });
});
