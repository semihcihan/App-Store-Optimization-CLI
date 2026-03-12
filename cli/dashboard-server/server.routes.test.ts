import { PassThrough } from "stream";
import { jest } from "@jest/globals";
import { getAppById, listApps, upsertApps } from "../db/apps";
import {
  deleteAppKeywords,
  getAppLastKeywordAddedAtMap,
  listAllAppKeywords,
} from "../db/app-keywords";
import { getKeyword, listKeywords } from "../db/aso-keywords";
import {
  getKeywordFailures,
  listKeywordFailuresForApp,
} from "../db/aso-keyword-failures";
import {
  getCompetitorAppDocs,
  getOwnedAppDocs,
  upsertCompetitorAppDocs,
  upsertOwnedAppDocs,
} from "../db/aso-apps";
import { getAsoAppDocsLocal } from "../services/keywords/aso-local-cache-service";
import { asoAuthService } from "../services/auth/aso-auth-service";
import { fetchAndPersistKeywordPopularityStage } from "../services/keywords/aso-keyword-service";
import { isAsoAuthReauthRequiredError } from "../services/keywords/aso-popularity-service";
import { createServerRequestHandler } from "./server";
import { DEFAULT_RESEARCH_APP_ID } from "../services/keywords/aso-research";

jest.mock("../db/apps", () => ({
  getAppById: jest.fn(() => null),
  listApps: jest.fn(() => []),
  upsertApps: jest.fn(),
}));

jest.mock("../db/app-keywords", () => ({
  listAllAppKeywords: jest.fn(() => []),
  listByApp: jest.fn(() => []),
  createAppKeywords: jest.fn(),
  deleteAppKeywords: jest.fn(() => 0),
  getAppLastKeywordAddedAtMap: jest.fn(() => new Map()),
}));

jest.mock("../db/aso-keywords", () => ({
  listKeywords: jest.fn(() => []),
  getKeyword: jest.fn(() => null),
  getKeywordFailures: jest.fn(() => []),
}));

jest.mock("../db/aso-apps", () => ({
  getCompetitorAppDocs: jest.fn(() => []),
  getOwnedAppDocs: jest.fn(() => []),
  upsertCompetitorAppDocs: jest.fn(),
  upsertOwnedAppDocs: jest.fn(),
}));

jest.mock("../db/aso-keyword-failures", () => ({
  listKeywordFailuresForApp: jest.fn(() => []),
  getKeywordFailures: jest.fn(() => []),
  deleteKeywordFailures: jest.fn(() => 0),
}));

jest.mock("../services/keywords/aso-keyword-service", () => ({
  normalizeKeywords: jest.fn((input: string[]) =>
    Array.from(new Set(input.map((item) => item.trim().toLowerCase()).filter(Boolean)))
  ),
  fetchAndPersistKeywordPopularityStage: jest.fn(async () => ({
    hits: [],
    pendingItems: [],
    orderRefreshKeywords: [],
    failedKeywords: [],
  })),
  enrichAndPersistKeywords: jest.fn(async () => ({
    items: [],
    failedKeywords: [],
  })),
  refreshAndPersistKeywordOrder: jest.fn(async () => []),
  refreshKeywordsForStartup: jest.fn(async () => []),
}));

jest.mock("../services/auth/aso-auth-service", () => ({
  asoAuthService: {
    reAuthenticate: jest.fn(async () => {}),
  },
}));

jest.mock("../services/keywords/aso-popularity-service", () => ({
  isAsoAuthReauthRequiredError: jest.fn(() => false),
}));

jest.mock("../services/telemetry/error-reporter", () => ({
  reportBugsnagError: jest.fn(),
}));

jest.mock("../services/keywords/aso-local-cache-service", () => ({
  getAsoAppDocsLocal: jest.fn(async () => []),
}));

jest.mock("../utils/logger", () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  },
}));

async function request(params: {
  method: string;
  path: string;
  body?: unknown;
}): Promise<{
  statusCode: number;
  json: any | null;
  text: string;
}> {
  const handler = createServerRequestHandler();
  const payload = params.body ? JSON.stringify(params.body) : "";

  return new Promise((resolve) => {
    const req = new PassThrough() as any;
    req.method = params.method;
    req.url = params.path;
    req.headers = {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    };

    const res = new PassThrough() as any;
    let statusCode = 200;
    const chunks: Buffer[] = [];
    res.statusCode = statusCode;
    res.headers = {};
    res.setHeader = (name: string, value: unknown) => {
      res.headers[name.toLowerCase()] = value;
    };
    res.writeHead = (code: number, headers?: Record<string, unknown>) => {
      statusCode = code;
      res.statusCode = code;
      if (headers) {
        for (const [key, value] of Object.entries(headers)) {
          res.headers[key.toLowerCase()] = value;
        }
      }
      return res;
    };

    res.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    res.on("finish", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let json: any | null = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      resolve({ statusCode, json, text });
    });

    handler(req, res);

    if (payload) req.write(payload);
    req.end();
  });
}

describe("dashboard server routes", () => {
  const mockGetAppById = jest.mocked(getAppById);
  const mockListApps = jest.mocked(listApps);
  const mockUpsertApps = jest.mocked(upsertApps);
  const mockGetAppLastKeywordAddedAtMap = jest.mocked(getAppLastKeywordAddedAtMap);
  const mockListKeywords = jest.mocked(listKeywords);
  const mockListAllAppKeywords = jest.mocked(listAllAppKeywords);
  const mockGetKeywordFailures = jest.mocked(getKeywordFailures);
  const mockListKeywordFailuresForApp = jest.mocked(listKeywordFailuresForApp);
  const mockDeleteAppKeywords = jest.mocked(deleteAppKeywords);
  const mockGetKeyword = jest.mocked(getKeyword);
  const mockGetCompetitorAppDocs = jest.mocked(getCompetitorAppDocs);
  const mockUpsertCompetitorAppDocs = jest.mocked(upsertCompetitorAppDocs);
  const mockGetOwnedAppDocs = jest.mocked(getOwnedAppDocs);
  const mockUpsertOwnedAppDocs = jest.mocked(upsertOwnedAppDocs);
  const mockGetAsoAppDocsLocal = jest.mocked(getAsoAppDocsLocal);
  const mockReAuthenticate = jest.mocked(asoAuthService.reAuthenticate);
  const mockFetchKeywordStage = jest.mocked(fetchAndPersistKeywordPopularityStage);
  const mockIsAsoAuthReauthRequiredError = jest.mocked(isAsoAuthReauthRequiredError);

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAppById.mockReturnValue(null);
    mockListApps.mockReturnValue([]);
    mockGetAppLastKeywordAddedAtMap.mockReturnValue(new Map());
    mockListKeywords.mockReturnValue([]);
    mockListAllAppKeywords.mockReturnValue([]);
    mockGetKeywordFailures.mockReturnValue([]);
    mockListKeywordFailuresForApp.mockReturnValue([]);
    mockDeleteAppKeywords.mockReturnValue(0);
    mockGetKeyword.mockReturnValue(null);
    mockGetCompetitorAppDocs.mockReturnValue([]);
    mockGetOwnedAppDocs.mockReturnValue([]);
    mockGetAsoAppDocsLocal.mockResolvedValue([]);
    mockReAuthenticate.mockResolvedValue("ok");
    mockFetchKeywordStage.mockResolvedValue({
      hits: [],
      pendingItems: [],
      orderRefreshKeywords: [],
      failedKeywords: [],
    });
    mockIsAsoAuthReauthRequiredError.mockReturnValue(false);
  });

  it("returns health status", async () => {
    const response = await request({ method: "GET", path: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json).toEqual({ success: true });
  });

  it("returns runtime config payload", async () => {
    const response = await request({
      method: "GET",
      path: "/runtime-config.js",
    });

    expect(response.statusCode).toBe(200);
    expect(response.text).toContain("window.__ASO_DASHBOARD_RUNTIME__");
  });

  it("returns startup refresh status", async () => {
    const response = await request({
      method: "GET",
      path: "/api/aso/refresh-status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json?.success).toBe(true);
    expect(response.json?.data).toEqual(
      expect.objectContaining({
        status: expect.any(String),
      })
    );
  });

  it("returns apps sorted and ensures default research app", async () => {
    mockListApps.mockReturnValue([
      { id: "2", name: "Beta" } as any,
      { id: "1", name: "Alpha" } as any,
    ]);
    mockGetAppLastKeywordAddedAtMap.mockReturnValue(
      new Map([
        ["2", "2026-03-10T00:00:00.000Z"],
        ["1", "2026-03-09T00:00:00.000Z"],
      ])
    );

    const response = await request({ method: "GET", path: "/api/apps" });

    expect(response.statusCode).toBe(200);
    expect(mockUpsertApps).toHaveBeenCalledWith([
      { id: DEFAULT_RESEARCH_APP_ID, name: "Research" },
    ]);
    expect(response.json?.data.map((item: any) => item.id)).toEqual(["2", "1"]);
  });

  it("validates app-creation payloads", async () => {
    const invalidJson = await request({
      method: "POST",
      path: "/api/apps",
      body: "not-an-object" as any,
    });
    expect(invalidJson.statusCode).toBe(400);

    const invalidType = await request({
      method: "POST",
      path: "/api/apps",
      body: { type: "bad" },
    });
    expect(invalidType.statusCode).toBe(400);

    const invalidAppId = await request({
      method: "POST",
      path: "/api/apps",
      body: { type: "app", appId: "abc" },
    });
    expect(invalidAppId.statusCode).toBe(400);

    const missingResearchName = await request({
      method: "POST",
      path: "/api/apps",
      body: { type: "research", name: "  " },
    });
    expect(missingResearchName.statusCode).toBe(400);
  });

  it("creates research app with slug collision suffix", async () => {
    mockGetAppById.mockImplementation((id: string) => {
      if (id === DEFAULT_RESEARCH_APP_ID) return { id, name: "Research" } as any;
      if (id === "research:my-ideas") return { id, name: "My Ideas" } as any;
      return null;
    });

    const response = await request({
      method: "POST",
      path: "/api/apps",
      body: { type: "research", name: "My Ideas" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json).toEqual({
      success: true,
      data: {
        id: "research:my-ideas-2",
        name: "My Ideas",
      },
    });
    expect(mockUpsertApps).toHaveBeenCalledWith([
      { id: "research:my-ideas-2", name: "My Ideas" },
    ]);
  });

  it("creates manual app and hydrates name from app docs", async () => {
    mockGetAsoAppDocsLocal.mockResolvedValue([
      {
        appId: "123",
        country: "US",
        name: "Hydrated Name",
        averageUserRating: 4.4,
        userRatingCount: 100,
      },
    ] as any);

    const response = await request({
      method: "POST",
      path: "/api/apps",
      body: { type: "app", appId: "123" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json).toEqual({
      success: true,
      data: {
        id: "123",
        name: "Hydrated Name",
      },
    });
    expect(mockUpsertOwnedAppDocs).toHaveBeenCalled();
  });

  it("returns auth status and tty-required auth-start error", async () => {
    const status = await request({
      method: "GET",
      path: "/api/aso/auth/status",
    });
    expect(status.statusCode).toBe(200);
    expect(status.json?.data).toEqual(
      expect.objectContaining({
        status: expect.any(String),
        canPrompt: expect.any(Boolean),
      })
    );

    const start = await request({
      method: "POST",
      path: "/api/aso/auth/start",
    });
    expect(start.statusCode).toBe(503);
    expect(start.json?.errorCode).toBe("TTY_REQUIRED");
  });

  it("returns auth-in-progress when auth start is requested concurrently", async () => {
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    let resolveAuth: ((value: string) => void) | null = null;
    mockReAuthenticate.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveAuth = resolve;
        })
    );
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });

    try {
      const first = await request({
        method: "POST",
        path: "/api/aso/auth/start",
      });
      expect(first.statusCode).toBe(202);

      const second = await request({
        method: "POST",
        path: "/api/aso/auth/start",
      });
      expect(second.statusCode).toBe(409);
      expect(second.json?.errorCode).toBe("AUTH_IN_PROGRESS");
    } finally {
      const releaseAuth = resolveAuth as ((value: string) => void) | null;
      if (releaseAuth) {
        releaseAuth("ok");
      }
      await new Promise((resolve) => setImmediate(resolve));
      if (stdinDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      }
      if (stdoutDescriptor) {
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      }
    }
  });

  it("returns keywords with app-specific positions and failure metadata", async () => {
    mockListKeywords.mockReturnValue([
      {
        keyword: "term",
        normalizedKeyword: "term",
        country: "US",
        popularity: 42,
        difficultyScore: null,
        appCount: 10,
        keywordIncluded: 1,
        orderedAppIds: ["app-1", "app-2"],
      },
    ] as any);
    mockListAllAppKeywords.mockReturnValue([
      {
        appId: "app-2",
        keyword: "term",
        country: "US",
        previousPosition: 4,
      },
    ] as any);
    mockGetKeywordFailures.mockReturnValue([
      {
        normalizedKeyword: "term",
        stage: "enrichment",
        reasonCode: "FAILED",
        message: "boom",
        statusCode: 500,
        retryable: true,
        attempts: 2,
        requestId: "req-1",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
    ] as any);

    const response = await request({
      method: "GET",
      path: "/api/aso/keywords?country=US&appId=app-2",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json?.data).toEqual([
      expect.objectContaining({
        keyword: "term",
        keywordStatus: "failed",
        positions: [
          {
            appId: "app-2",
            previousPosition: 4,
            currentPosition: 2,
          },
        ],
        failure: expect.objectContaining({
          reasonCode: "FAILED",
        }),
      }),
    ]);
  });

  it("handles top-apps validation and hydration", async () => {
    const missingKeyword = await request({
      method: "GET",
      path: "/api/aso/top-apps?country=US",
    });
    expect(missingKeyword.statusCode).toBe(400);

    const notFound = await request({
      method: "GET",
      path: "/api/aso/top-apps?country=US&keyword=term",
    });
    expect(notFound.statusCode).toBe(404);

    mockGetKeyword.mockReturnValue({
      keyword: "term",
      orderedAppIds: ["a1", "a2"],
    } as any);
    mockGetCompetitorAppDocs
      .mockReturnValueOnce([
        {
          appId: "a1",
          name: "Old A1",
          averageUserRating: 0,
          userRatingCount: 0,
          expiresAt: "2020-01-01T00:00:00.000Z",
        },
      ] as any)
      .mockReturnValue([
        {
          appId: "a1",
          name: "New A1",
          averageUserRating: 4.5,
          userRatingCount: 120,
        },
        {
          appId: "a2",
          name: "New A2",
          averageUserRating: 4.1,
          userRatingCount: 80,
        },
      ] as any);
    mockGetAsoAppDocsLocal.mockResolvedValue([
      {
        appId: "a1",
        country: "US",
        name: "New A1",
        averageUserRating: 4.5,
        userRatingCount: 120,
      },
      {
        appId: "a2",
        country: "US",
        name: "New A2",
        averageUserRating: 4.1,
        userRatingCount: 80,
      },
    ] as any);

    const hydrated = await request({
      method: "GET",
      path: "/api/aso/top-apps?country=US&keyword=term&limit=2",
    });

    expect(hydrated.statusCode).toBe(200);
    expect(hydrated.json?.data.keyword).toBe("term");
    expect(hydrated.json?.data.appDocs).toHaveLength(2);
    expect(mockUpsertCompetitorAppDocs).toHaveBeenCalled();
  });

  it("serves owned apps endpoint and delete keyword endpoint", async () => {
    const emptyApps = await request({
      method: "GET",
      path: "/api/aso/apps?country=US",
    });
    expect(emptyApps.statusCode).toBe(200);
    expect(emptyApps.json?.data).toEqual([]);

    mockGetOwnedAppDocs
      .mockReturnValueOnce([
        {
          appId: "a1",
          name: "Stale",
          expiresAt: "2020-01-01T00:00:00.000Z",
        },
      ] as any)
      .mockReturnValue([
        {
          appId: "a1",
          name: "Fresh",
        },
      ] as any);
    mockGetAsoAppDocsLocal.mockResolvedValue([
      {
        appId: "a1",
        country: "US",
        name: "Fresh",
        averageUserRating: 4.2,
        userRatingCount: 50,
      },
    ] as any);

    const hydratedApps = await request({
      method: "GET",
      path: "/api/aso/apps?country=US&ids=a1&refresh=true",
    });
    expect(hydratedApps.statusCode).toBe(200);
    expect(hydratedApps.json?.data).toEqual([{ appId: "a1", name: "Fresh" }]);
    expect(mockUpsertOwnedAppDocs).toHaveBeenCalled();

    const deleteInvalid = await request({
      method: "DELETE",
      path: "/api/aso/keywords",
      body: { appId: "app-1", country: "US", keywords: [] },
    });
    expect(deleteInvalid.statusCode).toBe(400);

    mockDeleteAppKeywords.mockReturnValue(2);
    const deleteOk = await request({
      method: "DELETE",
      path: "/api/aso/keywords",
      body: { appId: "app-1", country: "US", keywords: ["one", "two"] },
    });
    expect(deleteOk.statusCode).toBe(200);
    expect(deleteOk.json).toEqual({
      success: true,
      data: { removedCount: 2 },
    });
  });

  it("falls back to cached owned app docs when hydration fails", async () => {
    mockGetOwnedAppDocs.mockReturnValue([
      {
        appId: "a1",
        name: "Cached App",
        expiresAt: "2020-01-01T00:00:00.000Z",
      },
    ] as any);
    mockGetAsoAppDocsLocal.mockRejectedValueOnce(new Error("Network error"));

    const response = await request({
      method: "GET",
      path: "/api/aso/apps?country=US&ids=a1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json).toEqual({
      success: true,
      data: [{ appId: "a1", name: "Cached App", expiresAt: "2020-01-01T00:00:00.000Z" }],
    });
  });

  it("maps add-keywords errors to public API error codes", async () => {
    mockFetchKeywordStage.mockRejectedValueOnce(new Error("Too many requests"));
    const rateLimited = await request({
      method: "POST",
      path: "/api/aso/keywords",
      body: {
        appId: "app-1",
        country: "US",
        keywords: ["term"],
      },
    });
    expect(rateLimited.statusCode).toBe(429);
    expect(rateLimited.json?.errorCode).toBe("RATE_LIMITED");

    mockFetchKeywordStage.mockRejectedValueOnce(new Error("Network unavailable"));
    const networkError = await request({
      method: "POST",
      path: "/api/aso/keywords",
      body: {
        appId: "app-1",
        country: "US",
        keywords: ["term-2"],
      },
    });
    expect(networkError.statusCode).toBe(500);
    expect(networkError.json?.errorCode).toBe("NETWORK_ERROR");
  });

  it("returns auth-required for keyword routes when reauth is required", async () => {
    mockListKeywordFailuresForApp.mockReturnValue([
      {
        keyword: "failed-term",
      } as any,
    ]);
    mockIsAsoAuthReauthRequiredError.mockReturnValue(true);
    mockFetchKeywordStage.mockRejectedValue(new Error("session expired"));

    const addKeywords = await request({
      method: "POST",
      path: "/api/aso/keywords",
      body: {
        appId: "app-1",
        country: "US",
        keywords: ["failed-term"],
      },
    });
    expect(addKeywords.statusCode).toBe(401);
    expect(addKeywords.json?.errorCode).toBe("AUTH_REQUIRED");

    const retryFailed = await request({
      method: "POST",
      path: "/api/aso/keywords/retry-failed",
      body: {
        appId: "app-1",
        country: "US",
      },
    });
    expect(retryFailed.statusCode).toBe(401);
    expect(retryFailed.json?.errorCode).toBe("AUTH_REQUIRED");
  });

  it("maps delete-keywords authorization failures", async () => {
    mockDeleteAppKeywords.mockImplementationOnce(() => {
      throw new Error("forbidden");
    });
    const response = await request({
      method: "DELETE",
      path: "/api/aso/keywords",
      body: {
        appId: "app-1",
        country: "US",
        keywords: ["term"],
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json?.errorCode).toBe("AUTHORIZATION_FAILED");
  });

  it("returns 404 for unknown API routes", async () => {
    const notFoundApi = await request({
      method: "GET",
      path: "/api/unknown-route",
    });
    expect(notFoundApi.statusCode).toBe(404);
    expect(notFoundApi.text).toContain("Not found");
  });
});
