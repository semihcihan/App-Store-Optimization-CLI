import { PassThrough } from "stream";
import { jest } from "@jest/globals";
import { createAppKeywords, listByApp } from "../db/app-keywords";
import { keywordPipelineService } from "../services/keywords/keyword-pipeline-service";
import { createServerRequestHandler } from "./server";
import { logger } from "../utils/logger";

jest.mock("../db/owned-apps", () => ({
  getOwnedAppById: jest.fn(() => null),
  listOwnedApps: jest.fn(() => []),
  listOwnedAppIdsByKind: jest.fn(() => []),
  upsertOwnedApps: jest.fn(),
  upsertOwnedAppSnapshots: jest.fn(),
}));

jest.mock("../db/aso-keywords", () => ({
  listKeywords: jest.fn(() => []),
  getKeyword: jest.fn(() => null),
}));

jest.mock("../db/aso-apps", () => ({
  getCompetitorAppDocs: jest.fn(() => []),
  upsertCompetitorAppDocs: jest.fn(),
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

jest.mock("../services/keywords/keyword-pipeline-service", () => ({
  keywordPipelineService: {
    normalizeKeywords: jest.fn((input: string[]) =>
      Array.from(new Set(input.map((item) => item.trim().toLowerCase()).filter(Boolean)))
    ),
    runPopularityStage: jest.fn(),
    enrichAndPersist: jest.fn(),
    persistBackgroundEnrichmentCrashFailures: jest.fn(),
    refreshOrder: jest.fn(),
    retryFailed: jest.fn(),
    refreshStartup: jest.fn(async () => []),
  },
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
  const mockLogger = jest.mocked(logger);
  const mockListByApp = jest.mocked(listByApp);
  const mockCreateAppKeywords = jest.mocked(createAppKeywords);
  const mockFetchKeywordStage = jest.mocked(
    keywordPipelineService.runPopularityStage
  );
  const mockEnrichKeywords = jest.mocked(keywordPipelineService.enrichAndPersist);
  const mockPersistBackgroundEnrichmentCrashFailures = jest.mocked(
    keywordPipelineService.persistBackgroundEnrichmentCrashFailures
  );
  const mockRefreshOrder = jest.mocked(keywordPipelineService.refreshOrder);
  const mockRetryFailed = jest.mocked(keywordPipelineService.retryFailed);

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
    mockPersistBackgroundEnrichmentCrashFailures.mockImplementation(() => {});
    mockRefreshOrder.mockResolvedValue([]);
    mockRetryFailed.mockResolvedValue({
      retriedCount: 0,
      succeededCount: 0,
      failedCount: 0,
    });
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
    expect(mockLogger.debug).toHaveBeenCalledWith(
      "[aso-dashboard] request",
      expect.objectContaining({
        method: "POST",
        path: "/api/aso/keywords",
      })
    );
  });

  it("marks pending enrichment items as failed when background enrichment throws", async () => {
    const enrichmentError = new Error("rate limit");
    mockFetchKeywordStage.mockResolvedValue({
      hits: [],
      pendingItems: [{ keyword: "stuck", popularity: 42 }],
      orderRefreshKeywords: [],
      failedKeywords: [],
    });
    mockEnrichKeywords.mockRejectedValue(enrichmentError);

    const response = await requestJson({
      method: "POST",
      path: "/api/aso/keywords",
      body: {
        appId: "app-1",
        country: "US",
        keywords: ["stuck"],
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

    await new Promise((resolve) => setImmediate(resolve));

    expect(mockPersistBackgroundEnrichmentCrashFailures).toHaveBeenCalledWith(
      "US",
      [{ keyword: "stuck", popularity: 42 }],
      enrichmentError
    );
  });

  it("retries failed keywords for selected app", async () => {
    mockRetryFailed.mockResolvedValue({
      retriedCount: 1,
      succeededCount: 1,
      failedCount: 0,
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
    expect(mockRetryFailed).toHaveBeenCalledWith("app-1", "US");
  });
});
