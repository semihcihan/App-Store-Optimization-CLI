import { PassThrough } from "stream";
import { jest } from "@jest/globals";
import {
  deleteOwnedAppById,
  getOwnedAppById,
  listOwnedApps,
  upsertOwnedApps,
  upsertOwnedAppSnapshots,
} from "../db/owned-apps";
import {
  deleteAppKeywords,
  deleteAppKeywordsByAppId,
  getAppLastKeywordAddedAtMap,
  listAllAppKeywords,
  setAppKeywordFavorite,
} from "../db/app-keywords";
import { listAppKeywordPositionHistory } from "../db/app-keyword-position-history";
import { getKeyword, listKeywords } from "../db/aso-keywords";
import {
  getKeywordFailures,
} from "../db/aso-keyword-failures";
import {
  getCompetitorAppDocs,
  upsertCompetitorAppDocs,
} from "../db/aso-apps";
import {
  getAsoAppDocsLocal,
  refreshAsoKeywordOrderLocal,
} from "../services/keywords/aso-local-cache-service";
import { getDb } from "../db/store";
import { asoAuthService } from "../services/auth/aso-auth-service";
import { keywordPipelineService } from "../services/keywords/keyword-pipeline-service";
import { isAsoAuthReauthRequiredError } from "../services/keywords/aso-popularity-service";
import { fetchOwnedAppSnapshotsFromApi } from "./owned-app-details";
import { createServerRequestHandler } from "./server";
import { DEFAULT_RESEARCH_APP_ID } from "../shared/aso-research";
import { logger } from "../utils/logger";

jest.mock("../db/owned-apps", () => ({
  deleteOwnedAppById: jest.fn(() => 0),
  getOwnedAppById: jest.fn(() => null),
  listOwnedApps: jest.fn(() => []),
  upsertOwnedApps: jest.fn(),
  upsertOwnedAppSnapshots: jest.fn(),
}));

jest.mock("../db/app-keywords", () => ({
  listAllAppKeywords: jest.fn(() => []),
  listByApp: jest.fn(() => []),
  createAppKeywords: jest.fn(),
  deleteAppKeywords: jest.fn(() => 0),
  deleteAppKeywordsByAppId: jest.fn(() => 0),
  getAppLastKeywordAddedAtMap: jest.fn(() => new Map()),
  setAppKeywordFavorite: jest.fn(() => true),
}));

jest.mock("../db/app-keyword-position-history", () => ({
  listAppKeywordPositionHistory: jest.fn(() => []),
}));

jest.mock("../db/aso-keywords", () => ({
  listKeywords: jest.fn(() => []),
  getKeyword: jest.fn(() => null),
  upsertKeywords: jest.fn(),
}));

jest.mock("../db/aso-apps", () => ({
  getCompetitorAppDocs: jest.fn(() => []),
  upsertCompetitorAppDocs: jest.fn(),
}));

jest.mock("../db/aso-keyword-failures", () => ({
  listKeywordFailuresForApp: jest.fn(() => []),
  getKeywordFailures: jest.fn(() => []),
  deleteKeywordFailures: jest.fn(() => 0),
  upsertKeywordFailures: jest.fn(),
}));

jest.mock("../services/keywords/keyword-pipeline-service", () => ({
  keywordPipelineService: {
    normalizeKeywords: jest.fn((input: string[]) =>
      Array.from(new Set(input.map((item) => item.trim().toLowerCase()).filter(Boolean)))
    ),
    runPopularityStage: jest.fn(async () => ({
      hits: [],
      pendingItems: [],
      orderRefreshKeywords: [],
      failedKeywords: [],
    })),
    enrichAndPersist: jest.fn(async () => ({
      items: [],
      failedKeywords: [],
    })),
    persistBackgroundEnrichmentCrashFailures: jest.fn(),
    refreshOrder: jest.fn(async () => []),
    retryFailed: jest.fn(async () => ({
      retriedCount: 0,
      succeededCount: 0,
      failedCount: 0,
    })),
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
  refreshAsoKeywordOrderLocal: jest.fn(async () => ({
    keyword: "",
    normalizedKeyword: "",
    appCount: 0,
    orderedAppIds: [],
  })),
}));

jest.mock("../db/store", () => ({
  getDb: jest.fn(() => ({
    prepare: jest.fn(() => ({
      get: jest.fn(() => undefined),
      all: jest.fn(() => []),
    })),
  })),
}));

jest.mock("./owned-app-details", () => ({
  fetchOwnedAppSnapshotsFromApi: jest.fn(async () => []),
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

function createPagedKeywordDbMock(params: {
  summary: { total_count: number; failed_count: number; pending_count: number };
  filteredCount: number;
  rows: unknown[];
  associations?: unknown[];
}) {
  const getResponses: unknown[] = [
    params.summary,
    { total_count: params.filteredCount },
  ];
  const allResponses: unknown[][] = [
    params.rows,
    params.associations ?? [],
  ];
  return {
    prepare: jest.fn(() => ({
      get: jest.fn(() => getResponses.shift()),
      all: jest.fn(() => allResponses.shift() ?? []),
    })),
  };
}

describe("dashboard server routes", () => {
  const mockLogger = jest.mocked(logger);
  const mockGetDb = jest.mocked(getDb);
  const mockGetOwnedAppById = jest.mocked(getOwnedAppById);
  const mockDeleteOwnedAppById = jest.mocked(deleteOwnedAppById);
  const mockListOwnedApps = jest.mocked(listOwnedApps);
  const mockUpsertOwnedApps = jest.mocked(upsertOwnedApps);
  const mockUpsertOwnedAppSnapshots = jest.mocked(upsertOwnedAppSnapshots);
  const mockGetAppLastKeywordAddedAtMap = jest.mocked(getAppLastKeywordAddedAtMap);
  const mockListAppKeywordPositionHistory = jest.mocked(
    listAppKeywordPositionHistory
  );
  const mockListKeywords = jest.mocked(listKeywords);
  const mockListAllAppKeywords = jest.mocked(listAllAppKeywords);
  const mockGetKeywordFailures = jest.mocked(getKeywordFailures);
  const mockDeleteAppKeywords = jest.mocked(deleteAppKeywords);
  const mockDeleteAppKeywordsByAppId = jest.mocked(deleteAppKeywordsByAppId);
  const mockSetAppKeywordFavorite = jest.mocked(setAppKeywordFavorite);
  const mockGetKeyword = jest.mocked(getKeyword);
  const mockGetCompetitorAppDocs = jest.mocked(getCompetitorAppDocs);
  const mockUpsertCompetitorAppDocs = jest.mocked(upsertCompetitorAppDocs);
  const mockFetchOwnedAppSnapshotsFromApi = jest.mocked(fetchOwnedAppSnapshotsFromApi);
  const mockGetAsoAppDocsLocal = jest.mocked(getAsoAppDocsLocal);
  const mockRefreshAsoKeywordOrderLocal = jest.mocked(refreshAsoKeywordOrderLocal);
  const mockReAuthenticate = jest.mocked(asoAuthService.reAuthenticate);
  const mockFetchKeywordStage = jest.mocked(
    keywordPipelineService.runPopularityStage
  );
  const mockRefreshOrder = jest.mocked(keywordPipelineService.refreshOrder);
  const mockRetryFailed = jest.mocked(keywordPipelineService.retryFailed);
  const mockIsAsoAuthReauthRequiredError = jest.mocked(isAsoAuthReauthRequiredError);

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetDb.mockReturnValue({
      prepare: jest.fn(() => ({
        get: jest.fn(() => undefined),
        all: jest.fn(() => []),
      })),
    } as any);
    mockGetOwnedAppById.mockReturnValue(null);
    mockDeleteOwnedAppById.mockReturnValue(0);
    mockListOwnedApps.mockReturnValue([]);
    mockGetAppLastKeywordAddedAtMap.mockReturnValue(new Map());
    mockListKeywords.mockReturnValue([]);
    mockListAllAppKeywords.mockReturnValue([]);
    mockGetKeywordFailures.mockReturnValue([]);
    mockDeleteAppKeywords.mockReturnValue(0);
    mockDeleteAppKeywordsByAppId.mockReturnValue(0);
    mockSetAppKeywordFavorite.mockReturnValue(true);
    mockListAppKeywordPositionHistory.mockReturnValue([]);
    mockGetKeyword.mockReturnValue(null);
    mockGetCompetitorAppDocs.mockReturnValue([]);
    mockFetchOwnedAppSnapshotsFromApi.mockResolvedValue([]);
    mockUpsertOwnedAppSnapshots.mockImplementation(() => {});
    mockGetAsoAppDocsLocal.mockResolvedValue([]);
    mockRefreshAsoKeywordOrderLocal.mockResolvedValue({
      keyword: "",
      normalizedKeyword: "",
      appCount: 0,
      orderedAppIds: [],
    });
    mockReAuthenticate.mockResolvedValue("ok");
    mockFetchKeywordStage.mockResolvedValue({
      hits: [],
      pendingItems: [],
      orderRefreshKeywords: [],
      failedKeywords: [],
      filteredOut: [],
    });
    mockRefreshOrder.mockResolvedValue([]);
    mockRetryFailed.mockResolvedValue({
      retriedCount: 0,
      succeededCount: 0,
      failedCount: 0,
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

  it("starts startup refresh on demand", async () => {
    const response = await request({
      method: "POST",
      path: "/api/aso/refresh/start",
    });

    expect(response.statusCode).toBe(202);
    expect(response.json?.success).toBe(true);
    expect(response.json?.data).toEqual(
      expect.objectContaining({
        status: expect.any(String),
      })
    );
  });

  it("returns apps sorted and ensures default research app", async () => {
    mockListOwnedApps.mockReturnValue([
      { id: "2", kind: "owned", name: "Beta", lastFetchedAt: null } as any,
      { id: "1", kind: "owned", name: "Alpha", lastFetchedAt: null } as any,
    ]);
    mockGetAppLastKeywordAddedAtMap.mockReturnValue(
      new Map([
        ["2", "2026-03-10T00:00:00.000Z"],
        ["1", "2026-03-09T00:00:00.000Z"],
      ])
    );

    const response = await request({ method: "GET", path: "/api/apps" });

    expect(response.statusCode).toBe(200);
    expect(mockUpsertOwnedApps).toHaveBeenCalledWith([
      { id: DEFAULT_RESEARCH_APP_ID, kind: "research", name: "Research" },
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

  it("deletes an app and clears its keyword associations", async () => {
    mockGetOwnedAppById.mockReturnValue({
      id: "123",
      kind: "owned",
      name: "Owned App",
    } as any);
    mockDeleteAppKeywordsByAppId.mockReturnValue(3);
    mockDeleteOwnedAppById.mockReturnValue(1);

    const response = await request({
      method: "DELETE",
      path: "/api/apps",
      body: { appId: "123" },
    });

    expect(response.statusCode).toBe(200);
    expect(mockDeleteAppKeywordsByAppId).toHaveBeenCalledWith("123");
    expect(mockDeleteOwnedAppById).toHaveBeenCalledWith("123");
    expect(response.json).toEqual({
      success: true,
      data: {
        id: "123",
        removedKeywordCount: 3,
      },
    });
  });

  it("rejects deleting the default research app", async () => {
    const response = await request({
      method: "DELETE",
      path: "/api/apps",
      body: { appId: DEFAULT_RESEARCH_APP_ID },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json?.errorCode).toBe("INVALID_REQUEST");
    expect(mockDeleteAppKeywordsByAppId).not.toHaveBeenCalled();
    expect(mockDeleteOwnedAppById).not.toHaveBeenCalled();
  });

  it("rejects oversized JSON payloads", async () => {
    const hugeName = "a".repeat(1024 * 1024 + 10);
    const response = await request({
      method: "POST",
      path: "/api/apps",
      body: { type: "research", name: hugeName },
    });

    expect(response.statusCode).toBe(413);
    expect(response.json).toEqual({
      success: false,
      errorCode: "PAYLOAD_TOO_LARGE",
      error: "Request payload is too large.",
    });
  });

  it("creates research app with slug collision suffix", async () => {
    mockGetOwnedAppById.mockImplementation((id: string) => {
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
    expect(mockUpsertOwnedApps).toHaveBeenCalledWith([
      { id: "research:my-ideas-2", kind: "research", name: "My Ideas" },
    ]);
  });

  it("creates manual app and hydrates name from app docs", async () => {
    mockFetchOwnedAppSnapshotsFromApi.mockResolvedValue([
      {
        id: "123",
        name: "Hydrated Name",
        averageUserRating: 4.4,
        userRatingCount: 100,
        expiresAt: "2099-01-01T00:00:00.000Z",
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
    expect(mockUpsertOwnedApps).toHaveBeenCalledWith([
      { id: "123", kind: "owned", name: "123" },
    ]);
    expect(mockUpsertOwnedAppSnapshots).toHaveBeenCalledWith("US", [
      {
        id: "123",
        name: "Hydrated Name",
        averageUserRating: 4.4,
        userRatingCount: 100,
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("returns auth status and starts dashboard auth without requiring a tty", async () => {
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
    expect(start.statusCode).toBe(202);
    expect(start.json?.data).toEqual(
      expect.objectContaining({
        status: "in_progress",
        pendingPrompt: null,
      })
    );
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

  it("does not treat prompt responses as invalid while auth is between steps", async () => {
    let allowAuthToFinish: (() => void) | null = null;
    mockReAuthenticate.mockImplementation(
      async (options?: any) => {
        await options?.promptHandler?.prompt({
          kind: "verification_code",
          title: "Verification Code Required",
          message: "Enter code",
          digits: 6,
        });
        await new Promise<void>((resolve) => {
          allowAuthToFinish = resolve;
        });
        return "ok";
      }
    );

    const start = await request({
      method: "POST",
      path: "/api/aso/auth/start",
    });
    expect(start.statusCode).toBe(202);

    const firstRespond = await request({
      method: "POST",
      path: "/api/aso/auth/respond",
      body: {
        kind: "verification_code",
        code: "123456",
      },
    });
    expect(firstRespond.statusCode).toBe(202);
    expect(firstRespond.json?.data).toEqual(
      expect.objectContaining({
        status: "in_progress",
      })
    );

    const secondRespond = await request({
      method: "POST",
      path: "/api/aso/auth/respond",
      body: {
        kind: "verification_code",
        code: "123456",
      },
    });
    expect(secondRespond.statusCode).toBe(202);
    expect(secondRespond.json?.data).toEqual(
      expect.objectContaining({
        status: "in_progress",
        pendingPrompt: null,
      })
    );

    const releaseAuth = allowAuthToFinish as (() => void) | null;
    releaseAuth?.();
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("returns keywords with app-specific positions and failure metadata", async () => {
    mockGetDb.mockReturnValue(
      createPagedKeywordDbMock({
        summary: {
          total_count: 1,
          failed_count: 1,
          pending_count: 0,
        },
        filteredCount: 1,
        rows: [
          {
            normalized_keyword: "term",
            keyword: "term",
            popularity: 42,
            difficulty_score: null,
            min_difficulty_score: null,
            is_brand_keyword: null,
            app_count: 10,
            keyword_match: "titleExactPhrase",
            ordered_app_ids: JSON.stringify(["app-1", "app-2"]),
            is_favorite: 0,
            created_at: "2026-03-12T00:00:00.000Z",
            updated_at: "2026-03-12T00:00:00.000Z",
            order_expires_at: "2026-03-13T00:00:00.000Z",
            popularity_expires_at: "2026-03-13T00:00:00.000Z",
            current_position: 2,
            failure_stage: "enrichment",
            failure_reason_code: "FAILED",
            failure_message: "boom",
            failure_status_code: 500,
            failure_retryable: 1,
            failure_attempts: 2,
            failure_request_id: "req-1",
            failure_updated_at: "2026-03-12T00:00:00.000Z",
          },
        ],
        associations: [
          {
            app_id: "app-2",
            keyword: "term",
            previous_position: 4,
          },
        ],
      }) as any
    );

    const response = await request({
      method: "GET",
      path: "/api/aso/keywords?country=US&appId=app-2",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json?.data).toEqual(
      expect.objectContaining({
        page: 1,
        totalCount: 1,
        totalPages: 1,
        associatedCount: 1,
        failedCount: 1,
        pendingCount: 0,
        items: [
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
        ],
      })
    );
    expect(mockLogger.debug).not.toHaveBeenCalled();
  });

  it("returns app-associated failed keywords even when keyword cache row is missing", async () => {
    mockGetDb.mockReturnValue(
      createPagedKeywordDbMock({
        summary: {
          total_count: 1,
          failed_count: 1,
          pending_count: 0,
        },
        filteredCount: 1,
        rows: [
          {
            normalized_keyword: "lost-term",
            keyword: "lost-term",
            popularity: null,
            difficulty_score: null,
            min_difficulty_score: null,
            is_brand_keyword: null,
            app_count: null,
            keyword_match: "none",
            ordered_app_ids: JSON.stringify([]),
            is_favorite: 0,
            created_at: "2026-03-12T00:00:00.000Z",
            updated_at: "2026-03-12T00:00:00.000Z",
            order_expires_at: "2026-03-12T00:00:00.000Z",
            popularity_expires_at: "2026-03-12T00:00:00.000Z",
            current_position: null,
            failure_stage: "popularity",
            failure_reason_code: "FAILED",
            failure_message: "upstream failed",
            failure_status_code: 500,
            failure_retryable: 1,
            failure_attempts: 1,
            failure_request_id: "req-2",
            failure_updated_at: "2026-03-12T00:00:00.000Z",
          },
        ],
        associations: [
          {
            app_id: "app-2",
            keyword: "lost-term",
            previous_position: 3,
          },
        ],
      }) as any
    );

    const response = await request({
      method: "GET",
      path: "/api/aso/keywords?country=US&appId=app-2",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json?.data).toEqual(
      expect.objectContaining({
        page: 1,
        totalCount: 1,
        totalPages: 1,
        associatedCount: 1,
        failedCount: 1,
        pendingCount: 0,
        items: [
          expect.objectContaining({
            keyword: "lost-term",
            popularity: null,
            difficultyScore: null,
            keywordStatus: "failed",
            positions: [
              {
                appId: "app-2",
                previousPosition: 3,
                currentPosition: null,
              },
            ],
            failure: expect.objectContaining({
              stage: "popularity",
              reasonCode: "FAILED",
            }),
          }),
        ],
      })
    );
  });

  it("requires appId for keyword reads", async () => {
    const response = await request({
      method: "GET",
      path: "/api/aso/keywords?country=US",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json).toEqual({
      success: false,
      errorCode: "INVALID_REQUEST",
      error: "Please provide a valid appId.",
    });
  });

  it("returns app keyword position history points", async () => {
    mockListAppKeywordPositionHistory.mockReturnValue([
      {
        appId: "app-2",
        keyword: "term",
        country: "US",
        position: 11,
        capturedAt: "2026-04-10T00:00:00.000Z",
      },
      {
        appId: "app-2",
        keyword: "term",
        country: "US",
        position: 7,
        capturedAt: "2026-04-11T00:00:00.000Z",
      },
    ]);

    const response = await request({
      method: "GET",
      path: "/api/aso/keywords/history?country=US&appId=app-2&keyword=term",
    });

    expect(response.statusCode).toBe(200);
    expect(mockListAppKeywordPositionHistory).toHaveBeenCalledWith(
      "app-2",
      "term",
      "US"
    );
    expect(response.json?.data).toEqual({
      appId: "app-2",
      keyword: "term",
      points: [
        {
          capturedAt: "2026-04-10T00:00:00.000Z",
          position: 11,
        },
        {
          capturedAt: "2026-04-11T00:00:00.000Z",
          position: 7,
        },
      ],
    });
  });

  it("validates history request query params", async () => {
    const response = await request({
      method: "GET",
      path: "/api/aso/keywords/history?country=US&appId=app-2",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json).toEqual({
      success: false,
      errorCode: "INVALID_REQUEST",
      error: "Please provide appId and keyword.",
    });
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

  it("refreshes stale top-app keyword order before reading app docs", async () => {
    mockGetKeyword
      .mockReturnValueOnce({
        keyword: "term",
        orderExpiresAt: "2000-01-01T00:00:00.000Z",
        orderedAppIds: ["old1"],
      } as any)
      .mockReturnValue({
        keyword: "term",
        orderExpiresAt: "2099-01-01T00:00:00.000Z",
        orderedAppIds: ["a1", "a2"],
      } as any);
    mockGetCompetitorAppDocs.mockReturnValue([
      {
        appId: "a1",
        name: "Fresh A1",
        averageUserRating: 4.6,
        userRatingCount: 220,
        releaseDate: "2024-01-01",
        currentVersionReleaseDate: "2026-01-01",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      {
        appId: "a2",
        name: "Fresh A2",
        averageUserRating: 4.1,
        userRatingCount: 110,
        releaseDate: "2024-02-01",
        currentVersionReleaseDate: "2026-02-01",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    ] as any);

    const response = await request({
      method: "GET",
      path: "/api/aso/top-apps?country=US&keyword=term&limit=2",
    });

    expect(response.statusCode).toBe(200);
    expect(mockRefreshOrder).toHaveBeenCalledWith("US", ["term"]);
    expect(mockGetCompetitorAppDocs).toHaveBeenCalledWith("US", ["a1", "a2"]);
  });

  it("does not refresh top-app keyword order when order TTL is fresh", async () => {
    mockGetKeyword.mockReturnValue({
      keyword: "term",
      orderExpiresAt: "2099-01-01T00:00:00.000Z",
      orderedAppIds: ["a1"],
    } as any);
    mockGetCompetitorAppDocs.mockReturnValue([
      {
        appId: "a1",
        name: "Fresh A1",
        averageUserRating: 4.6,
        userRatingCount: 220,
        releaseDate: "2024-01-01",
        currentVersionReleaseDate: "2026-01-01",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    ] as any);

    const response = await request({
      method: "GET",
      path: "/api/aso/top-apps?country=US&keyword=term&limit=1",
    });

    expect(response.statusCode).toBe(200);
    expect(mockRefreshOrder).not.toHaveBeenCalled();
  });

  it("handles percent-containing top-app keywords without throwing", async () => {
    const response = await request({
      method: "GET",
      path: "/api/aso/top-apps?country=US&keyword=%25",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json?.errorCode).toBe("NOT_FOUND");
  });

  it("rehydrates top apps when cached docs are fresh but missing dates", async () => {
    mockGetKeyword.mockReturnValue({
      keyword: "term",
      orderedAppIds: ["a1"],
    } as any);
    mockGetCompetitorAppDocs
      .mockReturnValueOnce([
        {
          appId: "a1",
          name: "Cached A1",
          averageUserRating: 4.2,
          userRatingCount: 200,
          releaseDate: null,
          currentVersionReleaseDate: null,
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      ] as any)
      .mockReturnValue([
        {
          appId: "a1",
          name: "Hydrated A1",
          averageUserRating: 4.6,
          userRatingCount: 320,
          releaseDate: "2024-01-01",
          currentVersionReleaseDate: "2026-01-01",
          expiresAt: "2099-12-31T00:00:00.000Z",
        },
      ] as any);
    mockGetAsoAppDocsLocal.mockResolvedValue([
      {
        appId: "a1",
        country: "US",
        name: "Hydrated A1",
        averageUserRating: 4.6,
        userRatingCount: 320,
        releaseDate: "2024-01-01",
        currentVersionReleaseDate: "2026-01-01",
        expiresAt: "2099-12-31T00:00:00.000Z",
      },
    ] as any);

    const response = await request({
      method: "GET",
      path: "/api/aso/top-apps?country=US&keyword=term&limit=1",
    });

    expect(response.statusCode).toBe(200);
    expect(mockGetAsoAppDocsLocal).toHaveBeenCalledWith("US", ["a1"]);
    expect(mockUpsertCompetitorAppDocs).toHaveBeenCalledWith(
      "US",
      expect.arrayContaining([
        expect.objectContaining({
          appId: "a1",
          releaseDate: "2024-01-01",
          currentVersionReleaseDate: "2026-01-01",
        }),
      ])
    );
  });

  it("searches apps by term and supports numeric app-id lookup", async () => {
    mockRefreshAsoKeywordOrderLocal.mockResolvedValue({
      keyword: "focus",
      normalizedKeyword: "focus",
      appCount: 2,
      orderedAppIds: ["a1", "a2"],
      appDocs: [
        {
          appId: "a1",
          country: "US",
          name: "Focus One",
          icon: { template: "https://example.com/a1/{w}x{h}.{f}" },
        },
        {
          appId: "a2",
          country: "US",
          name: "Focus Two",
          iconArtwork: { url: "https://example.com/a2.png" },
        },
      ],
    } as any);

    const searchByTerm = await request({
      method: "GET",
      path: "/api/aso/apps/search?country=US&term=focus&limit=2",
    });

    expect(searchByTerm.statusCode).toBe(200);
    expect(searchByTerm.json?.data).toEqual({
      term: "focus",
      appDocs: [
        {
          appId: "a1",
          name: "Focus One",
          icon: { template: "https://example.com/a1/{w}x{h}.{f}" },
        },
        {
          appId: "a2",
          name: "Focus Two",
          iconArtwork: { url: "https://example.com/a2.png" },
        },
      ],
    });
    expect(mockRefreshAsoKeywordOrderLocal).toHaveBeenCalledWith("US", "focus");
    expect(mockGetAsoAppDocsLocal).not.toHaveBeenCalled();

    mockRefreshAsoKeywordOrderLocal.mockResolvedValueOnce({
      keyword: "123",
      normalizedKeyword: "123",
      appCount: 0,
      orderedAppIds: [],
      appDocs: [],
    } as any);

    const searchById = await request({
      method: "GET",
      path: "/api/aso/apps/search?country=US&term=123",
    });
    expect(searchById.statusCode).toBe(200);
    expect(searchById.json?.data).toEqual({
      term: "123",
      appDocs: [
        {
          appId: "123",
          name: "123",
        },
      ],
    });
  });

  it("returns no app candidates when only fallback ordered ids are available", async () => {
    mockRefreshAsoKeywordOrderLocal.mockResolvedValue({
      keyword: "focus",
      normalizedKeyword: "focus",
      appCount: 2,
      orderedAppIds: ["a1", "a2"],
      appDocs: [],
    } as any);

    const response = await request({
      method: "GET",
      path: "/api/aso/apps/search?country=US&term=focus&limit=10",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json?.data).toEqual({
      term: "focus",
      appDocs: [],
      warning: "Search failed",
    });
    expect(mockGetAsoAppDocsLocal).not.toHaveBeenCalled();
  });

  it("serves competitor apps endpoint and delete keyword endpoint", async () => {
    const emptyApps = await request({
      method: "GET",
      path: "/api/aso/apps?country=US",
    });
    expect(emptyApps.statusCode).toBe(200);
    expect(emptyApps.json?.data).toEqual([]);

    mockGetCompetitorAppDocs
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
    expect(mockGetAsoAppDocsLocal).toHaveBeenCalledWith("US", ["a1"], {
      forceLookup: true,
    });
    expect(mockUpsertCompetitorAppDocs).toHaveBeenCalled();

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

  it("updates favorite status for a keyword association", async () => {
    mockSetAppKeywordFavorite.mockReturnValue(true);
    const response = await request({
      method: "POST",
      path: "/api/aso/keywords/favorite",
      body: {
        appId: "app-1",
        country: "US",
        keyword: "term",
        isFavorite: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json).toEqual({
      success: true,
      data: {
        appId: "app-1",
        keyword: "term",
        isFavorite: true,
      },
    });
    expect(mockSetAppKeywordFavorite).toHaveBeenCalledWith(
      "app-1",
      "term",
      true,
      "US"
    );
  });

  it("falls back to cached competitor app docs when hydration fails", async () => {
    mockGetCompetitorAppDocs.mockReturnValue([
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

  it("rehydrates competitor app docs when release dates are missing", async () => {
    mockGetCompetitorAppDocs
      .mockReturnValueOnce([
        {
          appId: "a1",
          name: "Cached App",
          averageUserRating: 4.4,
          userRatingCount: 320,
          expiresAt: "2099-01-01T00:00:00.000Z",
          releaseDate: null,
          currentVersionReleaseDate: null,
        },
      ] as any)
      .mockReturnValue([
        {
          appId: "a1",
          name: "Hydrated App",
          averageUserRating: 4.7,
          userRatingCount: 900,
          expiresAt: "2099-12-31T00:00:00.000Z",
          releaseDate: "2025-01-01",
          currentVersionReleaseDate: "2026-01-01",
        },
      ] as any);
    mockGetAsoAppDocsLocal.mockResolvedValueOnce([
      {
        appId: "a1",
        country: "US",
        name: "Hydrated App",
        averageUserRating: 4.7,
        userRatingCount: 900,
        releaseDate: "2025-01-01",
        currentVersionReleaseDate: "2026-01-01",
      },
    ] as any);

    const response = await request({
      method: "GET",
      path: "/api/aso/apps?country=US&ids=a1",
    });

    expect(response.statusCode).toBe(200);
    expect(mockGetAsoAppDocsLocal).toHaveBeenCalledWith("US", ["a1"], {
      forceLookup: true,
    });
    expect(mockUpsertCompetitorAppDocs).toHaveBeenCalled();
    expect(response.json?.data).toEqual([
      expect.objectContaining({
        appId: "a1",
        name: "Hydrated App",
      }),
    ]);
  });

  it("keeps competitor app docs cached when docs are fresh and complete", async () => {
    mockGetCompetitorAppDocs.mockReturnValue([
      {
        appId: "a1",
        name: "Cached App",
        averageUserRating: 4.2,
        userRatingCount: 200,
        expiresAt: "2099-01-01T00:00:00.000Z",
        releaseDate: "2025-01-01",
        currentVersionReleaseDate: "2026-01-01",
      },
    ] as any);

    const response = await request({
      method: "GET",
      path: "/api/aso/apps?country=US&ids=a1",
    });

    expect(response.statusCode).toBe(200);
    expect(mockGetAsoAppDocsLocal).not.toHaveBeenCalled();
    expect(mockUpsertCompetitorAppDocs).not.toHaveBeenCalled();
    expect(response.json?.data).toEqual([
      expect.objectContaining({
        appId: "a1",
        name: "Cached App",
      }),
    ]);
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

  it("maps inaccessible Primary App ID errors to the reconfigure error code", async () => {
    mockFetchKeywordStage.mockRejectedValueOnce(
      new Error(
        "Primary App ID 345345 is not accessible for this Apple Ads account. (messageCode=NO_USER_OWNED_APPS_FOUND_CODE)"
      )
    );

    const response = await request({
      method: "POST",
      path: "/api/aso/keywords",
      body: {
        appId: "app-1",
        country: "US",
        keywords: ["term"],
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json?.errorCode).toBe("PRIMARY_APP_ID_RECONFIGURE_REQUIRED");
  });

  it("returns auth-required for keyword routes when reauth is required", async () => {
    mockIsAsoAuthReauthRequiredError.mockReturnValue(true);
    mockFetchKeywordStage.mockRejectedValue(new Error("session expired"));
    mockRetryFailed.mockRejectedValue(new Error("session expired"));

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
