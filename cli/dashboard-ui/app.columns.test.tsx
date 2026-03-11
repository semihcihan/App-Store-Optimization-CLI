/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { App } from "./App";
import { DEFAULT_RESEARCH_APP_ID } from "../services/keywords/aso-research";

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

  it("hides rank, change, and updated columns for research apps", async () => {
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
    expect(screen.queryByRole("columnheader", { name: "Updated" })).not.toBeInTheDocument();
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
});
