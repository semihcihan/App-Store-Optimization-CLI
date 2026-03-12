import { PassThrough } from "stream";
import { jest } from "@jest/globals";
import { createAppKeywords, listByApp } from "../db/app-keywords";
import {
  listKeywordFailuresForApp,
  deleteKeywordFailures,
} from "../db/aso-keyword-failures";
import {
  enrichAndPersistKeywords,
  fetchAndPersistKeywordPopularityStage,
  refreshAndPersistKeywordOrder,
} from "../services/keywords/aso-keyword-service";
import { createServerRequestHandler } from "./server";

jest.mock("../db/apps", () => ({
  getAppById: jest.fn(() => null),
  listApps: jest.fn(() => []),
  upsertApps: jest.fn(),
}));

jest.mock("../db/aso-keywords", () => ({
  listKeywords: jest.fn(() => []),
  getKeyword: jest.fn(() => null),
}));

jest.mock("../db/aso-apps", () => ({
  getCompetitorAppDocs: jest.fn(() => []),
  getOwnedAppDocs: jest.fn(() => []),
  upsertCompetitorAppDocs: jest.fn(),
  upsertOwnedAppDocs: jest.fn(),
}));

jest.mock("../db/app-keywords", () => ({
  listAllAppKeywords: jest.fn(() => []),
  listByApp: jest.fn(() => []),
  createAppKeywords: jest.fn(),
  deleteAppKeywords: jest.fn(() => 0),
  getAppLastKeywordAddedAtMap: jest.fn(() => new Map()),
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
  fetchAndPersistKeywordPopularityStage: jest.fn(),
  enrichAndPersistKeywords: jest.fn(),
  refreshAndPersistKeywordOrder: jest.fn(),
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

function requestJson(params: {
  method: string;
  path: string;
  body?: unknown;
}): Promise<{ statusCode: number; body: any }> {
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
    const chunks: Buffer[] = [];
    let statusCode = 200;
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
      const raw = Buffer.concat(chunks).toString("utf8");
      resolve({
        statusCode,
        body: raw ? JSON.parse(raw) : null,
      });
    });

    handler(req, res);

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

describe("dashboard server keyword add flow", () => {
  const mockListByApp = jest.mocked(listByApp);
  const mockCreateAppKeywords = jest.mocked(createAppKeywords);
  const mockFetchKeywordStage = jest.mocked(fetchAndPersistKeywordPopularityStage);
  const mockEnrichKeywords = jest.mocked(enrichAndPersistKeywords);
  const mockRefreshOrder = jest.mocked(refreshAndPersistKeywordOrder);
  const mockListKeywordFailuresForApp = jest.mocked(listKeywordFailuresForApp);
  const mockDeleteKeywordFailures = jest.mocked(deleteKeywordFailures);

  beforeEach(() => {
    jest.clearAllMocks();
    mockListByApp.mockReturnValue([]);
    mockFetchKeywordStage.mockResolvedValue({
      hits: [],
      pendingItems: [],
      orderRefreshKeywords: [],
      failedKeywords: [],
    });
    mockEnrichKeywords.mockResolvedValue({
      items: [],
      failedKeywords: [],
    });
    mockRefreshOrder.mockResolvedValue([]);
    mockListKeywordFailuresForApp.mockReturnValue([]);
    mockDeleteKeywordFailures.mockReturnValue(0);
  });

  it("rejects over-limit keyword requests before association lookup and stage calls", async () => {
    const response = await requestJson({
      method: "POST",
      path: "/api/aso/keywords",
      body: {
        appId: "app-1",
        country: "US",
        keywords: Array.from({ length: 300 }, (_, index) => `kw-${index}`),
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      success: false,
      errorCode: "INVALID_REQUEST",
      error: "A maximum of 100 keywords is supported per request.",
    });
    expect(mockListByApp).not.toHaveBeenCalled();
    expect(mockFetchKeywordStage).not.toHaveBeenCalled();
    expect(mockCreateAppKeywords).not.toHaveBeenCalled();
  });

  it("schedules order refresh when stage returns order-only misses", async () => {
    mockFetchKeywordStage.mockResolvedValue({
      hits: [],
      pendingItems: [],
      orderRefreshKeywords: ["order-stale"],
      failedKeywords: [],
    });

    const response = await requestJson({
      method: "POST",
      path: "/api/aso/keywords",
      body: {
        appId: "app-1",
        country: "US",
        keywords: ["Order-Stale"],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.body).toEqual({
      success: true,
      data: {
        cachedCount: 0,
        pendingCount: 1,
        failedCount: 0,
      },
    });
    expect(mockCreateAppKeywords).toHaveBeenCalledWith("app-1", ["order-stale"], "US");
    expect(mockRefreshOrder).toHaveBeenCalledWith("US", ["order-stale"]);
    expect(mockEnrichKeywords).not.toHaveBeenCalled();
  });

  it("retries failed keywords for selected app", async () => {
    mockListKeywordFailuresForApp.mockReturnValue([
      {
        country: "US",
        normalizedKeyword: "bad",
        keyword: "bad",
        status: "failed",
        stage: "enrichment",
        reasonCode: "ENRICHMENT_FAILED",
        message: "failed",
        statusCode: 500,
        retryable: true,
        attempts: 3,
        requestId: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    mockFetchKeywordStage.mockResolvedValue({
      hits: [],
      pendingItems: [{ keyword: "bad", popularity: 30 }],
      orderRefreshKeywords: [],
      failedKeywords: [],
    });
    mockEnrichKeywords.mockResolvedValue({
      items: [
        {
          keyword: "bad",
          popularity: 30,
          difficultyScore: 10,
          minDifficultyScore: 8,
          appCount: 10,
          keywordIncluded: 1,
          orderedAppIds: [],
          orderExpiresAt: "2099-01-01T00:00:00.000Z",
          popularityExpiresAt: "2099-01-01T00:00:00.000Z",
        } as any,
      ],
      failedKeywords: [],
    });

    const response = await requestJson({
      method: "POST",
      path: "/api/aso/keywords/retry-failed",
      body: {
        appId: "app-1",
        country: "US",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      success: true,
      data: {
        retriedCount: 1,
        succeededCount: 1,
        failedCount: 0,
      },
    });
    expect(mockDeleteKeywordFailures).toHaveBeenCalledWith("US", ["bad"]);
  });
});
