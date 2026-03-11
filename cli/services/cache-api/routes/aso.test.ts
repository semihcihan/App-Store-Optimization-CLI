import { jest } from "@jest/globals";
import { enrichAsoKeywords } from "./aso";
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
        appCount: 20,
        keywordIncluded: 2,
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
          expiresAt: "2025-01-02T00:00:00.000Z",
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
    expect(result.map((item) => item.keyword)).toEqual(items.map((item) => item.keyword));
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
});
