import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { jest } from "@jest/globals";
import { getKeyword, upsertKeywords } from "../../db/aso-keywords";
import { listKeywordFailures } from "../../db/aso-keyword-failures";
import { createAppKeyword, listByApp } from "../../db/app-keywords";
import { closeDbForTests } from "../../db/store";
import {
  refreshAsoKeywordOrderLocal,
  lookupAsoCacheLocal,
  enrichAsoKeywordsLocal,
} from "./aso-local-cache-service";
import { asoPopularityService } from "./aso-popularity-service";
import {
  keywordPipelineService,
} from "./keyword-pipeline-service";

jest.mock("./aso-local-cache-service", () => ({
  lookupAsoCacheLocal: jest.fn(async () => ({ hits: [], misses: [] })),
  enrichAsoKeywordsLocal: jest.fn(async () => ({ items: [], failedKeywords: [] })),
  refreshAsoKeywordOrderLocal: jest.fn(),
}));

jest.mock("./aso-popularity-service", () => ({
  asoPopularityService: {
    fetchKeywordPopularities: jest.fn(async () => ({})),
    fetchKeywordPopularitiesWithFailures: jest.fn(async () => ({
      popularities: {},
      failedKeywords: [],
    })),
  },
  summarizeFailedPopularityKeywords: jest.fn(() => null),
}));

const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `aso-keyword-service-${process.pid}-${Date.now()}.sqlite`
);

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function cleanDbFiles(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

describe("keyword-pipeline-service", () => {
  const mockRefreshAsoKeywordOrderLocal = jest.mocked(refreshAsoKeywordOrderLocal);
  const mockLookupAsoCacheLocal = jest.mocked(lookupAsoCacheLocal);
  const mockEnrichAsoKeywordsLocal = jest.mocked(enrichAsoKeywordsLocal);
  const mockFetchKeywordPopularitiesWithFailures = jest.mocked(
    asoPopularityService.fetchKeywordPopularitiesWithFailures
  );

  beforeAll(() => {
    process.env.ASO_DB_PATH = TEST_DB_PATH;
  });

  beforeEach(() => {
    closeDbForTests();
    cleanDbFiles();
    jest.clearAllMocks();
    mockLookupAsoCacheLocal.mockResolvedValue({ hits: [], misses: [] });
    mockEnrichAsoKeywordsLocal.mockResolvedValue({
      items: [],
      failedKeywords: [],
    });
    mockFetchKeywordPopularitiesWithFailures.mockResolvedValue({
      popularities: {},
      failedKeywords: [],
    });
  });

  afterAll(() => {
    closeDbForTests();
    cleanDbFiles();
    delete process.env.ASO_DB_PATH;
  });

  it("updates previous positions from old order before order-only refresh upsert", async () => {
    upsertKeywords("US", [
      {
        keyword: "ranked",
        popularity: 50,
        difficultyScore: 10,
        minDifficultyScore: 5,
        appCount: 2,
        keywordMatch: "titleExactPhrase",
        orderedAppIds: ["app-1", "app-2"],
        orderExpiresAt: "2000-01-01T00:00:00.000Z",
        popularityExpiresAt: "2099-01-01T00:00:00.000Z",
      },
    ]);
    createAppKeyword("app-1", "ranked", "US");
    createAppKeyword("app-2", "ranked", "US");

    mockRefreshAsoKeywordOrderLocal.mockResolvedValue({
      keyword: "ranked",
      normalizedKeyword: "ranked",
      appCount: 2,
      orderedAppIds: ["app-2", "app-1"],
    });

    const refreshed = await keywordPipelineService.refreshOrder("US", ["ranked"]);

    expect(refreshed).toHaveLength(1);
    expect(getKeyword("US", "ranked")?.orderedAppIds).toEqual(["app-2", "app-1"]);
    expect(listByApp("app-1", "US")[0]?.previousPosition).toBe(1);
    expect(listByApp("app-2", "US")[0]?.previousPosition).toBe(2);
  });

  it("returns partial success and persists failed keywords", async () => {
    mockLookupAsoCacheLocal.mockResolvedValue({
      hits: [],
      misses: ["good", "bad"],
    });
    mockFetchKeywordPopularitiesWithFailures.mockResolvedValue({
      popularities: {
        good: 40,
      },
      failedKeywords: [
        {
          keyword: "bad",
          stage: "popularity",
          reasonCode: "UPSTREAM_TIMEOUT",
          message: "timeout",
          statusCode: 504,
          retryable: true,
          attempts: 3,
          requestId: "req-1",
        },
      ],
    });
    mockEnrichAsoKeywordsLocal.mockResolvedValue({
      items: [
        {
          keyword: "good",
          normalizedKeyword: "good",
          country: "US",
          popularity: 40,
          difficultyScore: 10,
          minDifficultyScore: 8,
          appCount: 100,
          keywordMatch: "subtitleExactPhrase",
          orderedAppIds: [],
          orderExpiresAt: "2099-01-01T00:00:00.000Z",
          popularityExpiresAt: "2099-01-01T00:00:00.000Z",
        },
      ],
      failedKeywords: [],
    });

    const result = await keywordPipelineService.run("US", ["good", "bad"]);

    expect(result.items.map((item) => item.keyword)).toEqual(["good"]);
    expect(result.failedKeywords).toHaveLength(1);
    expect(result.failedKeywords[0].keyword).toBe("bad");
    const failures = listKeywordFailures("US");
    expect(failures).toHaveLength(1);
    expect(failures[0].keyword).toBe("bad");
  });

  it("clears failed keyword status when retry succeeds", async () => {
    mockLookupAsoCacheLocal.mockResolvedValue({
      hits: [],
      misses: ["bad"],
    });
    mockFetchKeywordPopularitiesWithFailures
      .mockResolvedValueOnce({
        popularities: {},
        failedKeywords: [
          {
            keyword: "bad",
            stage: "popularity",
            reasonCode: "UPSTREAM_ERROR",
            message: "error",
            statusCode: 500,
            retryable: true,
            attempts: 3,
          },
        ],
      })
      .mockResolvedValueOnce({
        popularities: { bad: 55 },
        failedKeywords: [],
      });
    mockEnrichAsoKeywordsLocal.mockResolvedValue({
      items: [
        {
          keyword: "bad",
          normalizedKeyword: "bad",
          country: "US",
          popularity: 55,
          difficultyScore: 15,
          minDifficultyScore: 10,
          appCount: 90,
          keywordMatch: "titleAllWords",
          orderedAppIds: [],
          orderExpiresAt: "2099-01-01T00:00:00.000Z",
          popularityExpiresAt: "2099-01-01T00:00:00.000Z",
        },
      ],
      failedKeywords: [],
    });

    await expect(keywordPipelineService.run("US", ["bad"])).rejects.toThrow(
      "All keywords failed"
    );
    expect(listKeywordFailures("US")).toHaveLength(1);

    const retryResult = await keywordPipelineService.run("US", ["bad"]);
    expect(retryResult.failedKeywords).toHaveLength(0);
    expect(listKeywordFailures("US")).toHaveLength(0);
  });

  it("persists each enriched keyword as soon as that keyword finishes", async () => {
    const firstDone = createDeferred<void>();
    const secondDone = createDeferred<void>();
    let runSettled = false;

    mockEnrichAsoKeywordsLocal.mockImplementation(async (_country, items) => {
      const keyword = items[0]?.keyword;
      if (keyword === "fast") {
        await firstDone.promise;
        upsertKeywords("US", [
          {
            keyword: "fast",
            popularity: 55,
            difficultyScore: 22,
            minDifficultyScore: 15,
            appCount: 120,
            keywordMatch: "titleExactPhrase",
            orderedAppIds: ["app-1"],
            orderExpiresAt: "2099-01-01T00:00:00.000Z",
            popularityExpiresAt: "2099-01-01T00:00:00.000Z",
          },
        ]);
        return {
          items: [
            {
              keyword: "fast",
              normalizedKeyword: "fast",
              country: "US",
              popularity: 55,
              difficultyScore: 22,
              minDifficultyScore: 15,
              appCount: 120,
              keywordMatch: "titleExactPhrase",
              orderedAppIds: ["app-1"],
              orderExpiresAt: "2099-01-01T00:00:00.000Z",
              popularityExpiresAt: "2099-01-01T00:00:00.000Z",
            } as any,
          ],
          failedKeywords: [],
        };
      }
      await secondDone.promise;
      upsertKeywords("US", [
        {
          keyword: "slow",
          popularity: 60,
          difficultyScore: 30,
          minDifficultyScore: 20,
          appCount: 140,
          keywordMatch: "subtitleExactPhrase",
          orderedAppIds: ["app-2"],
          orderExpiresAt: "2099-01-01T00:00:00.000Z",
          popularityExpiresAt: "2099-01-01T00:00:00.000Z",
        },
      ]);
      return {
        items: [
          {
            keyword: "slow",
            normalizedKeyword: "slow",
            country: "US",
            popularity: 60,
            difficultyScore: 30,
            minDifficultyScore: 20,
            appCount: 140,
            keywordMatch: "subtitleExactPhrase",
            orderedAppIds: ["app-2"],
            orderExpiresAt: "2099-01-01T00:00:00.000Z",
            popularityExpiresAt: "2099-01-01T00:00:00.000Z",
          } as any,
        ],
        failedKeywords: [],
      };
    });

    const runPromise = keywordPipelineService
      .enrichAndPersist("US", [
        { keyword: "fast", popularity: 55 },
        { keyword: "slow", popularity: 60 },
      ])
      .then((result) => {
        runSettled = true;
        return result;
      });

    firstDone.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(getKeyword("US", "fast")?.difficultyScore).toBe(22);
    expect(runSettled).toBe(false);

    secondDone.resolve();
    const result = await runPromise;
    expect(result.items.map((item) => item.keyword)).toEqual(["fast", "slow"]);
    expect(result.failedKeywords).toHaveLength(0);
  });

  it("persists failed enrichment keywords before other pending keywords finish", async () => {
    const failureDone = createDeferred<void>();
    const successDone = createDeferred<void>();
    let runSettled = false;

    mockEnrichAsoKeywordsLocal.mockImplementation(async (_country, items) => {
      const keyword = items[0]?.keyword;
      if (keyword === "fail-first") {
        await failureDone.promise;
        return {
          items: [],
          failedKeywords: [
            {
              keyword: "fail-first",
              stage: "enrichment",
              reasonCode: "RATE_LIMITED",
              message: "429",
              statusCode: 429,
              retryable: true,
              attempts: 1,
            } as any,
          ],
        };
      }
      await successDone.promise;
      upsertKeywords("US", [
        {
          keyword: "succeed-later",
          popularity: 65,
          difficultyScore: 34,
          minDifficultyScore: 22,
          appCount: 150,
          keywordMatch: "titleAllWords",
          orderedAppIds: ["app-3"],
          orderExpiresAt: "2099-01-01T00:00:00.000Z",
          popularityExpiresAt: "2099-01-01T00:00:00.000Z",
        },
      ]);
      return {
        items: [
          {
            keyword: "succeed-later",
            normalizedKeyword: "succeed-later",
            country: "US",
            popularity: 65,
            difficultyScore: 34,
            minDifficultyScore: 22,
            appCount: 150,
            keywordMatch: "titleAllWords",
            orderedAppIds: ["app-3"],
            orderExpiresAt: "2099-01-01T00:00:00.000Z",
            popularityExpiresAt: "2099-01-01T00:00:00.000Z",
          } as any,
        ],
        failedKeywords: [],
      };
    });

    const runPromise = keywordPipelineService
      .enrichAndPersist("US", [
        { keyword: "fail-first", popularity: 40 },
        { keyword: "succeed-later", popularity: 65 },
      ])
      .then((result) => {
        runSettled = true;
        return result;
      });

    failureDone.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    const failuresAfterFirst = listKeywordFailures("US");
    expect(failuresAfterFirst.map((entry) => entry.keyword)).toContain("fail-first");
    expect(runSettled).toBe(false);

    successDone.resolve();
    const result = await runPromise;
    expect(result.items.map((item) => item.keyword)).toEqual(["succeed-later"]);
    expect(result.failedKeywords.map((entry) => entry.keyword)).toEqual([
      "fail-first",
    ]);
  });
});
