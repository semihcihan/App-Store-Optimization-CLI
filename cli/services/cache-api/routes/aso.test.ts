import { jest } from "@jest/globals";
import { enrichAsoKeywords } from "../keyword-cache-service";
import { enrichKeyword } from "../services/aso-enrichment-service";

jest.mock("../services/aso-enrichment-service", () => ({
  enrichKeyword: jest.fn(),
}));

const mockEnrichKeyword = jest.mocked(enrichKeyword);

describe("ASO routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ASO_KEYWORD_ENRICHMENT_CONCURRENCY = "4";
  });

  afterEach(() => {
    delete process.env.ASO_KEYWORD_ENRICHMENT_CONCURRENCY;
  });

  it("limits keyword enrichment concurrency and preserves result order", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    mockEnrichKeyword.mockImplementation(async ({ keyword, popularity }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return {
        keyword,
        normalizedKeyword: keyword,
        popularity,
        difficultyScore: 10,
        minDifficultyScore: 5,
        isBrandKeyword: false,
        appCount: 20,
        keywordMatch: "titleAllWords",
        orderedAppIds: [],
        appDocs: [
          {
            appId: `app-${keyword}`,
            country: "US",
            name: `App ${keyword}`,
            averageUserRating: 4.5,
            userRatingCount: 100,
          },
        ],
      };
    });

    const items = Array.from({ length: 10 }, (_, index) => ({
      keyword: `kw-${index}`,
      popularity: 50,
    }));

    const repository = {
      upsertMany: jest.fn(async ({ country, items: enriched }: any) =>
        enriched.map((item: any) => ({
          ...item,
          country,
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
          orderExpiresAt: "2025-01-02T00:00:00.000Z",
        }))
      ),
    };

    const result = await enrichAsoKeywords(
      {
        country: "US",
        items,
      },
      { repository: repository as any }
    );

    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(result.items.map((item) => item.keyword)).toEqual(
      items.map((item) => item.keyword)
    );
    expect(result.failedKeywords).toEqual([]);
    expect(repository.upsertMany).toHaveBeenCalledWith(
      expect.objectContaining({
        appDocs: expect.arrayContaining([
          expect.objectContaining({
            country: "US",
          }),
        ]),
      })
    );
    expect(mockEnrichKeyword).toHaveBeenCalledTimes(10);
  });

  it("isolates per-keyword enrichment failures", async () => {
    mockEnrichKeyword.mockImplementation(async ({ keyword, popularity }) => {
      if (keyword === "bad") {
        throw new Error("upstream timeout");
      }
      return {
        keyword,
        normalizedKeyword: keyword,
        popularity,
        difficultyScore: 10,
        minDifficultyScore: 5,
        isBrandKeyword: false,
        appCount: 20,
        keywordMatch: "titleAllWords",
        orderedAppIds: [],
        appDocs: [],
      };
    });
    const repository = {
      upsertMany: jest.fn(async ({ country, items: enriched }: any) =>
        enriched.map((item: any) => ({
          ...item,
          country,
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
          orderExpiresAt: "2025-01-02T00:00:00.000Z",
        }))
      ),
    };
    const result = await enrichAsoKeywords(
      {
        country: "US",
        items: [
          { keyword: "good", popularity: 50 },
          { keyword: "bad", popularity: 50 },
        ],
      },
      { repository: repository as any }
    );
    expect(result.items.map((item) => item.keyword)).toEqual(["good"]);
    expect(result.failedKeywords).toHaveLength(1);
    expect(result.failedKeywords[0]).toMatchObject({
      keyword: "bad",
      stage: "enrichment",
    });
  });

  it("preserves transient upstream metadata for an enrichment failure", async () => {
    mockEnrichKeyword.mockRejectedValueOnce(
      Object.assign(new Error("Request failed with status code 503"), {
        isAxiosError: true,
        code: "ERR_BAD_RESPONSE",
        response: { status: 503, data: {} },
      })
    );
    const repository = {
      upsertMany: jest.fn(),
    };

    const result = await enrichAsoKeywords(
      {
        country: "US",
        items: [{ keyword: "unavailable", popularity: 50 }],
      },
      { repository: repository as any }
    );

    expect(result.items).toEqual([]);
    expect(result.failedKeywords).toEqual([
      expect.objectContaining({
        keyword: "unavailable",
        stage: "enrichment",
        reasonCode: "ERR_BAD_RESPONSE",
        statusCode: 503,
        retryable: true,
      }),
    ]);
  });

  it("surfaces INSUFFICIENT_DOCS as a retryable per-keyword enrichment failure", async () => {
    mockEnrichKeyword.mockImplementation(async ({ keyword, popularity }) => {
      if (keyword === "needs-retry") {
        const error = new Error("insufficient top docs");
        (error as Error & { code: string; statusCode: number }).code =
          "INSUFFICIENT_DOCS";
        (error as Error & { code: string; statusCode: number }).statusCode = 503;
        throw error;
      }
      return {
        keyword,
        normalizedKeyword: keyword,
        popularity,
        difficultyScore: 10,
        minDifficultyScore: 5,
        isBrandKeyword: false,
        appCount: 20,
        keywordMatch: "titleAllWords",
        orderedAppIds: [],
        appDocs: [],
      };
    });
    const repository = {
      upsertMany: jest.fn(async ({ country, items: enriched }: any) =>
        enriched.map((item: any) => ({
          ...item,
          country,
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
          orderExpiresAt: "2025-01-02T00:00:00.000Z",
        }))
      ),
    };
    const result = await enrichAsoKeywords(
      {
        country: "US",
        items: [
          { keyword: "ok", popularity: 50 },
          { keyword: "needs-retry", popularity: 50 },
        ],
      },
      { repository: repository as any }
    );

    expect(result.items.map((item) => item.keyword)).toEqual(["ok"]);
    expect(result.failedKeywords).toEqual([
      expect.objectContaining({
        keyword: "needs-retry",
        stage: "enrichment",
        reasonCode: "INSUFFICIENT_DOCS",
        retryable: true,
      }),
    ]);
  });
});
