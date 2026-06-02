/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App";
import { DEFAULT_RESEARCH_APP_ID } from "../shared/aso-research";

type MockPayload = {
  status: number;
  body: unknown;
};

type AppKind = "owned" | "research";

type AppRow = {
  id: string;
  name: string;
  kind?: AppKind;
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
  apps: AppRow[];
  keywordsByAppId: Record<string, unknown[]>;
};

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

function buildFetchMock(options: FetchMockOptions) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();

    if (method === "GET" && url === "/api/apps") {
      return jsonResponse({
        status: 200,
        body: { success: true, data: withAppKinds(options.apps) },
      });
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
          data: buildKeywordPagedPayloadForQuery(
            options.keywordsByAppId[appId] ?? [],
            appId,
            params
          ),
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
    expect(screen.getByRole("columnheader", { name: /Brand/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Updated" })).toBeInTheDocument();
    expect(
      Array.from(document.querySelectorAll("thead th")).map((header) =>
        header.getAttribute("data-sort-key")
      )
    ).toEqual([
      "keyword",
      "popularity",
      "difficulty",
      "appCount",
      "brand",
      "favorite",
      "updatedAt",
    ]);
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
    expect(screen.getByRole("columnheader", { name: /Brand/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Updated" })).toBeInTheDocument();
    expect(
      Array.from(document.querySelectorAll("thead th")).map((header) =>
        header.getAttribute("data-sort-key")
      )
    ).toEqual([
      "keyword",
      "popularity",
      "difficulty",
      "rank",
      "change",
      "appCount",
      "brand",
      "favorite",
      "updatedAt",
    ]);
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

  it("supports paginated keyword payloads from the dashboard API", async () => {
    localStorage.setItem("aso-dashboard:selected-app-id", "123456789");
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();

      if (method === "GET" && url === "/api/apps") {
        return jsonResponse({
          status: 200,
          body: {
            success: true,
            data: withAppKinds([
              { id: DEFAULT_RESEARCH_APP_ID, name: "Research" },
              { id: "123456789", name: "Owned App" },
            ]),
          },
        });
      }

      if (method === "GET" && url.startsWith("/api/aso/keywords?")) {
        const params = new URLSearchParams(url.split("?")[1] ?? "");
        const page = params.get("page") ?? "1";
        if (page === "2") {
          return jsonResponse({
            status: 200,
            body: {
              success: true,
              data: {
                items: [
                  {
                    keyword: "page-two",
                    popularity: 44,
                    difficultyScore: 21,
                    appCount: 80,
                    updatedAt: "2026-03-10T12:00:00.000Z",
                    positions: [{ appId: "123456789", previousPosition: 7, currentPosition: 6 }],
                  },
                ],
                page: 2,
                pageSize: 1,
                totalCount: 2,
                totalPages: 2,
                hasPrevPage: true,
                hasNextPage: false,
                associatedCount: 2,
                failedCount: 0,
                pendingCount: 0,
              },
            },
          });
        }
        return jsonResponse({
          status: 200,
          body: {
            success: true,
            data: {
              items: [
                {
                  keyword: "page-one",
                  popularity: 50,
                  difficultyScore: 20,
                  appCount: 90,
                  updatedAt: "2026-03-10T11:00:00.000Z",
                  positions: [{ appId: "123456789", previousPosition: 6, currentPosition: 5 }],
                },
              ],
              page: 1,
              pageSize: 1,
              totalCount: 2,
              totalPages: 2,
              hasPrevPage: false,
              hasNextPage: true,
              associatedCount: 2,
              failedCount: 0,
              pendingCount: 0,
            },
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
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    await screen.findByText("page-one");
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await screen.findByText("page-two");
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) => String(call[0]).includes("page=2"))
      ).toBe(true)
    );
  });
});
