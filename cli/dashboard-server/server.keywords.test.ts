import * as http from "http";
import type { AddressInfo } from "net";
import { jest } from "@jest/globals";
import { createAppKeywords, listByApp } from "../db/app-keywords";
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

function createTestServer(): Promise<http.Server> {
  const server = http.createServer(createServerRequestHandler());
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function requestJson(params: {
  server: http.Server;
  method: string;
  path: string;
  body?: unknown;
}): Promise<{ statusCode: number; body: any }> {
  const address = params.server.address() as AddressInfo;
  const payload = params.body ? JSON.stringify(params.body) : "";

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: address.port,
        path: params.path,
        method: params.method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({
            statusCode: res.statusCode ?? 0,
            body: raw ? JSON.parse(raw) : null,
          });
        });
      }
    );
    req.on("error", reject);
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

  beforeEach(() => {
    jest.clearAllMocks();
    mockListByApp.mockReturnValue([]);
    mockFetchKeywordStage.mockResolvedValue({
      hits: [],
      pendingItems: [],
      orderRefreshKeywords: [],
    });
    mockEnrichKeywords.mockResolvedValue([]);
    mockRefreshOrder.mockResolvedValue([]);
  });

  it("schedules order refresh when stage returns order-only misses", async () => {
    mockFetchKeywordStage.mockResolvedValue({
      hits: [],
      pendingItems: [],
      orderRefreshKeywords: ["order-stale"],
    });

    const server = await createTestServer();
    try {
      const response = await requestJson({
        server,
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
        },
      });
      expect(mockCreateAppKeywords).toHaveBeenCalledWith("app-1", ["order-stale"], "US");
      expect(mockRefreshOrder).toHaveBeenCalledWith("US", ["order-stale"]);
      expect(mockEnrichKeywords).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });
});
