import { jest } from "@jest/globals";
import {
  __resetIncompleteTopDocLookupCooldownForTests,
  enrichKeyword,
  refreshKeywordOrder,
} from "./aso-enrichment-service";
import { asoAppleGet } from "./aso-apple-client";
import { fetchAppStoreLookupAppDocs } from "./aso-app-doc-service";
import { fetchAppStoreAdditionalLocalizations } from "./aso-app-store-details";
import { logger } from "../../../utils/logger";
import { reportAppleContractChange } from "../../keywords/apple-http-trace";

jest.mock("./aso-apple-client", () => ({
  asoAppleGet: jest.fn(),
}));

jest.mock("./aso-app-doc-service", () => ({
  fetchAppStoreLookupAppDocs: jest.fn(),
}));

jest.mock("./aso-app-store-details", () => ({
  fetchAppStoreLocalizedAppData: jest.fn(),
  fetchAppStoreAdditionalLocalizations: jest.fn(),
}));

jest.mock("./aso-keyword-utils", () => ({
  normalizeKeyword: jest.fn((value: string) => value.trim().toLowerCase()),
  normalizeTextForKeywordMatch: jest.fn((value: string) =>
    value.toLowerCase().trim()
  ),
  computeAppExpiryIsoForApp: jest.fn(() => "2099-01-01T00:00:00.000Z"),
}));
jest.mock("../../../utils/logger", () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));
jest.mock("../../keywords/apple-http-trace", () => ({
  reportAppleContractChange: jest.fn(),
}));

const mockedAsoAppleGet = jest.mocked(asoAppleGet);
const mockedFetchAppStoreLookupAppDocs = jest.mocked(fetchAppStoreLookupAppDocs);
const mockedFetchAppStoreAdditionalLocalizations = jest.mocked(
  fetchAppStoreAdditionalLocalizations
);
const mockedLogger = jest.mocked(logger);
const mockedReportAppleContractChange = jest.mocked(reportAppleContractChange);

function buildSearchHtml(): string {
  return buildSearchHtmlForIds(["1", "2", "3", "4", "5"]);
}

function buildSearchHtmlForIds(
  ids: string[],
  tailIds: string[] = [],
  options?: {
    developerNamesById?: Record<string, string>;
    ratingCountById?: Record<string, string | number>;
    kindsById?: Record<string, string>;
    resultTypesById?: Record<string, string>;
    includeNextPage?: boolean;
    shelfContentType?: string;
  }
): string {
  const items = ids.map((id, index) => ({
    ...(options?.kindsById?.[id] ? { $kind: options.kindsById[id] } : {}),
    ...(options?.resultTypesById?.[id]
      ? { resultType: options.resultTypesById[id] }
      : {}),
    lockup: {
      adamId: id,
      title: `App ${id}`,
      subtitle: `Sub ${id}`,
      rating: Math.max(1, 4.9 - index * 0.1),
      ratingCount: String(options?.ratingCountById?.[id] ?? `${(index + 1) * 1000}`),
      ...(options?.developerNamesById?.[id]
        ? { developerName: options.developerNamesById[id] }
        : {}),
    },
  }));
  return `<html><body><script id="serialized-server-data">${JSON.stringify({
    data: [
      {
        data: {
          shelves: [
            {
              contentType: options?.shelfContentType ?? "searchResult",
              items,
            },
          ],
          ...(options?.includeNextPage === false
            ? {}
            : {
                nextPage: {
                  results: tailIds.map((id) => ({ id, type: "apps" })),
                },
              }),
        },
      },
    ],
  })}</script></body></html>`;
}

function buildCompleteCachedTopDocs(
  ids: string[],
  options?: {
    publisherNamesById?: Record<string, string>;
  }
) {
  return ids.map((appId, index) => ({
    appId,
    country: "US",
    name: `Cached ${appId}`,
    averageUserRating: 4.8 - index * 0.1,
    userRatingCount: (index + 1) * 1000,
    releaseDate: "2024-01-01T00:00:00.000Z",
    currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...(options?.publisherNamesById?.[appId]
      ? { publisherName: options.publisherNamesById[appId] }
      : {}),
  }));
}

describe("aso-enrichment-service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetIncompleteTopDocLookupCooldownForTests();
    mockedFetchAppStoreAdditionalLocalizations.mockResolvedValue({});
  });

  it("logs source and result summaries for order refresh", async () => {
    mockedAsoAppleGet.mockResolvedValue({
      data: buildSearchHtmlForIds(["1", "2", "3"]),
    } as never);

    const result = await refreshKeywordOrder({
      keyword: "word game",
      country: "US",
    });

    expect(result.appCount).toBe(3);
    expect(mockedLogger.debug).toHaveBeenCalledWith(
      "[aso-enrichment] order source",
      expect.objectContaining({
        keyword: "word game",
        country: "US",
        mode: "search-page",
      })
    );
    expect(mockedLogger.debug).toHaveBeenCalledWith(
      "[aso-enrichment] order result",
      expect.objectContaining({
        keyword: "word game",
        country: "US",
        mode: "search-page",
        appCount: 3,
      })
    );
  });

  it("keeps primary order and documents when nextPage is missing and uses only the MZSearch count", async () => {
    mockedAsoAppleGet
      .mockResolvedValueOnce({
        data: buildSearchHtmlForIds(["html-1", "html-2"], [], {
          includeNextPage: false,
        }),
      } as never)
      .mockResolvedValueOnce({
        data: {
          pageData: {
            bubbles: [
              {
                name: "software",
                results: [{ id: "1" }, { id: "2" }, { id: "3" }],
              },
            ],
          },
        },
      } as never);

    const result = await refreshKeywordOrder({
      keyword: "dust remover",
      country: "US",
    });

    expect(result).toEqual({
      keyword: "dust remover",
      normalizedKeyword: "dust remover",
      appCount: 3,
      orderedAppIds: ["html-1", "html-2"],
      appDocs: [
        expect.objectContaining({ appId: "html-1", name: "App html-1" }),
        expect.objectContaining({ appId: "html-2", name: "App html-2" }),
      ],
    });
    expect(mockedAsoAppleGet).toHaveBeenNthCalledWith(
      2,
      "https://search.itunes.apple.com/WebObjects/MZSearch.woa/wa/search",
      expect.objectContaining({
        operation: "mzsearch.keyword-order",
        params: {
          clientApplication: "Software",
          term: "dust remover",
        },
      })
    );
    expect(mockedReportAppleContractChange).not.toHaveBeenCalled();
  });

  it("does not allow the MZSearch count below the primary order length", async () => {
    mockedAsoAppleGet
      .mockResolvedValueOnce({
        data: buildSearchHtmlForIds(["html-1", "html-2", "html-3"], [], {
          includeNextPage: false,
        }),
      } as never)
      .mockResolvedValueOnce({
        data: {
          pageData: {
            bubbles: [
              {
                name: "software",
                results: [{ id: "fallback-1" }],
              },
            ],
          },
        },
      } as never);

    const result = await refreshKeywordOrder({
      keyword: "dust remover",
      country: "US",
    });

    expect(result.appCount).toBe(3);
    expect(result.orderedAppIds).toEqual(["html-1", "html-2", "html-3"]);
  });

  it("treats empty MZSearch as unresolved when the primary response contains apps", async () => {
    mockedAsoAppleGet
      .mockResolvedValueOnce({
        data: buildSearchHtmlForIds(["html-1", "html-2"], [], {
          includeNextPage: false,
        }),
      } as never)
      .mockResolvedValueOnce({
        data: {
          pageData: {
            bubbles: [],
          },
        },
      } as never);

    const result = await refreshKeywordOrder({
      keyword: "dust remover",
      country: "US",
    });

    expect(result.appCount).toBeNull();
    expect(result.orderedAppIds).toEqual(["html-1", "html-2"]);
    expect(result.appDocs).toEqual([
      expect.objectContaining({ appId: "html-1" }),
      expect.objectContaining({ appId: "html-2" }),
    ]);
    expect(mockedReportAppleContractChange).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "mzsearch.keyword-order",
        actualSignal:
          "primaryOrderedAppIds=2 primaryAppDocs=2 mzSearchIds=0",
        dedupeKey: "mzsearch-empty-contradicts-primary-results",
      })
    );
  });

  it("allows empty MZSearch to resolve zero when the primary response contains no apps", async () => {
    mockedAsoAppleGet
      .mockResolvedValueOnce({
        data: buildSearchHtmlForIds([]),
      } as never)
      .mockResolvedValueOnce({
        data: {
          pageData: {
            bubbles: [],
          },
        },
      } as never);

    const result = await refreshKeywordOrder({
      keyword: "no results",
      country: "US",
    });

    expect(result).toEqual({
      keyword: "no results",
      normalizedKeyword: "no results",
      appCount: 0,
      orderedAppIds: [],
      appDocs: [],
    });
    expect(mockedReportAppleContractChange).not.toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "mzsearch.keyword-order",
      })
    );
  });

  it("fails enrichment when empty MZSearch cannot corroborate a partial primary count", async () => {
    mockedAsoAppleGet
      .mockResolvedValueOnce({
        data: buildSearchHtmlForIds(["html-1", "html-2"], [], {
          includeNextPage: false,
        }),
      } as never)
      .mockResolvedValueOnce({
        data: {
          pageData: {
            bubbles: [
              {
                name: "software",
                results: [],
              },
            ],
          },
        },
      } as never);

    await expect(
      enrichKeyword({
        keyword: "dust remover",
        country: "US",
        popularity: 50,
      })
    ).rejects.toThrow("Unable to resolve App Store result count");
    expect(mockedReportAppleContractChange).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "mzsearch.keyword-order",
        dedupeKey: "mzsearch-empty-contradicts-primary-results",
      })
    );
  });

  it("uses MZSearch order while retaining primary documents when the primary order is unusable", async () => {
    mockedAsoAppleGet
      .mockResolvedValueOnce({
        data: buildSearchHtmlForIds(["2"], [], {
          includeNextPage: false,
          shelfContentType: "featured",
        }),
      } as never)
      .mockResolvedValueOnce({
        data: {
          pageData: {
            bubbles: [
              {
                name: "software",
                results: [{ id: "1" }, { id: "2" }, { id: "3" }],
              },
            ],
          },
        },
      } as never);

    const result = await refreshKeywordOrder({
      keyword: "dust remover",
      country: "US",
    });

    expect(result.appCount).toBe(3);
    expect(result.orderedAppIds).toEqual(["1", "2", "3"]);
    expect(result.appDocs).toEqual([
      expect.objectContaining({ appId: "2", name: "App 2" }),
    ]);
    expect(mockedReportAppleContractChange).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "appstore.search-page",
        actualSignal: expect.stringContaining("searchResult shelf"),
      })
    );
  });

  it("uses MZSearch for the complete result when the primary response has no usable data", async () => {
    mockedAsoAppleGet
      .mockResolvedValueOnce({
        data: "<html><body>no serialized data</body></html>",
      } as never)
      .mockResolvedValueOnce({
        data: {
          pageData: {
            bubbles: [
              {
                name: "software",
                results: [{ id: "1" }, { id: "2" }, { id: "3" }],
              },
            ],
          },
        },
      } as never);

    const result = await refreshKeywordOrder({
      keyword: "dust remover",
      country: "US",
    });

    expect(result).toEqual({
      keyword: "dust remover",
      normalizedKeyword: "dust remover",
      appCount: 3,
      orderedAppIds: ["1", "2", "3"],
      appDocs: [],
    });
  });

  it("keeps useful primary data unresolved when MZSearch cannot supply the missing count", async () => {
    mockedAsoAppleGet
      .mockResolvedValueOnce({
        data: buildSearchHtmlForIds(["html-1", "html-2"], [], {
          includeNextPage: false,
        }),
      } as never)
      .mockRejectedValueOnce(new Error("MZSearch unavailable"));

    const result = await refreshKeywordOrder({
      keyword: "dust remover",
      country: "US",
    });

    expect(result.appCount).toBeNull();
    expect(result.orderedAppIds).toEqual(["html-1", "html-2"]);
    expect(result.appDocs).toEqual([
      expect.objectContaining({ appId: "html-1" }),
      expect.objectContaining({ appId: "html-2" }),
    ]);
    expect(mockedReportAppleContractChange).not.toHaveBeenCalled();
  });

  it("uses exact lookup rating count for first apps when lookup is used", async () => {
    mockedAsoAppleGet.mockResolvedValue({
      data: buildSearchHtml(),
    } as never);

    mockedFetchAppStoreLookupAppDocs.mockResolvedValue([
      {
        appId: "1",
        country: "US",
        name: "Lookup 1",
        averageUserRating: 4.8,
        userRatingCount: 130123,
        releaseDate: "2022-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      {
        appId: "2",
        country: "US",
        name: "Lookup 2",
        averageUserRating: 4.7,
        userRatingCount: 12100,
        releaseDate: "2021-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      {
        appId: "3",
        country: "US",
        name: "Lookup 3",
        averageUserRating: 4.6,
        userRatingCount: 3600,
        releaseDate: "2020-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      {
        appId: "4",
        country: "US",
        name: "Lookup 4",
        averageUserRating: 4.5,
        userRatingCount: 890,
        releaseDate: "2019-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      {
        appId: "5",
        country: "US",
        name: "Lookup 5",
        averageUserRating: 4.4,
        userRatingCount: 1250,
        releaseDate: "2018-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
    ]);

    const result = await enrichKeyword(
      {
        keyword: "word game",
        country: "US",
        popularity: 66,
      },
      {
        getAppDocs: async () => [],
      }
    );

    expect(result.appDocs[0]).toEqual(
      expect.objectContaining({
        appId: "1",
        country: "US",
        userRatingCount: 130123,
        releaseDate: "2022-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      })
    );
    expect(result.appDocs[1]).toEqual(
      expect.objectContaining({
        appId: "2",
        country: "US",
        userRatingCount: 12100,
      })
    );
    expect(mockedLogger.debug).toHaveBeenCalledWith(
      "[aso-enrichment] enrich source",
      expect.objectContaining({
        keyword: "word game",
        country: "US",
        mode: "search-page",
      })
    );
    expect(mockedLogger.debug).toHaveBeenCalledWith(
      "[aso-enrichment] enrich result",
      expect.objectContaining({
        keyword: "word game",
        country: "US",
        mode: "search-page",
      })
    );
  });

  it("refetches lookup details when cached top app is missing dates", async () => {
    mockedAsoAppleGet.mockResolvedValue({
      data: buildSearchHtmlForIds(["1", "2", "3", "4", "5"]),
    } as never);

    mockedFetchAppStoreLookupAppDocs.mockResolvedValue([
      {
        appId: "1",
        country: "US",
        name: "Lookup 1",
        averageUserRating: 4.8,
        userRatingCount: 1111,
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
    ]);

    const result = await enrichKeyword(
      {
        keyword: "word game",
        country: "US",
        popularity: 66,
      },
      {
        getAppDocs: async () => [
          {
            appId: "1",
            country: "US",
            name: "Cached 1",
            averageUserRating: 4.7,
            userRatingCount: 1000,
            expiresAt: "2099-01-01T00:00:00.000Z",
            releaseDate: null,
            currentVersionReleaseDate: null,
          },
          {
            appId: "2",
            country: "US",
            name: "Cached 2",
            averageUserRating: 4.6,
            userRatingCount: 2000,
            expiresAt: "2099-01-01T00:00:00.000Z",
            releaseDate: "2024-01-01T00:00:00.000Z",
            currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
          },
          {
            appId: "3",
            country: "US",
            name: "Cached 3",
            averageUserRating: 4.5,
            userRatingCount: 3000,
            expiresAt: "2099-01-01T00:00:00.000Z",
            releaseDate: "2024-01-01T00:00:00.000Z",
            currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
          },
          {
            appId: "4",
            country: "US",
            name: "Cached 4",
            averageUserRating: 4.4,
            userRatingCount: 4000,
            expiresAt: "2099-01-01T00:00:00.000Z",
            releaseDate: "2024-01-01T00:00:00.000Z",
            currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
          },
          {
            appId: "5",
            country: "US",
            name: "Cached 5",
            averageUserRating: 4.3,
            userRatingCount: 5000,
            expiresAt: "2099-01-01T00:00:00.000Z",
            releaseDate: "2024-01-01T00:00:00.000Z",
            currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
          },
        ],
      }
    );

    expect(mockedFetchAppStoreLookupAppDocs).toHaveBeenCalledWith(
      expect.objectContaining({
        country: "US",
        appIds: ["1"],
      })
    );
    expect(result.appDocs.find((doc) => doc.appId === "1")).toEqual(
      expect.objectContaining({
        appId: "1",
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      })
    );
  });

  it("applies lookup cooldown for unresolved top-app docs across nearby keywords", async () => {
    mockedAsoAppleGet.mockResolvedValue({
      data: buildSearchHtmlForIds(["1", "2", "3", "4", "5"]),
    } as never);
    mockedFetchAppStoreLookupAppDocs.mockResolvedValue([
      {
        appId: "1",
        country: "US",
        name: "Lookup 1 Missing Dates",
        averageUserRating: 4.8,
        userRatingCount: 1111,
        releaseDate: null,
        currentVersionReleaseDate: null,
      },
    ]);

    const getAppDocs = async () => [
      {
        appId: "1",
        country: "US",
        name: "Cached 1",
        averageUserRating: 4.7,
        userRatingCount: 1000,
        expiresAt: "2099-01-01T00:00:00.000Z",
        releaseDate: null,
        currentVersionReleaseDate: null,
      },
      {
        appId: "2",
        country: "US",
        name: "Cached 2",
        averageUserRating: 4.6,
        userRatingCount: 2000,
        expiresAt: "2099-01-01T00:00:00.000Z",
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      {
        appId: "3",
        country: "US",
        name: "Cached 3",
        averageUserRating: 4.5,
        userRatingCount: 3000,
        expiresAt: "2099-01-01T00:00:00.000Z",
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      {
        appId: "4",
        country: "US",
        name: "Cached 4",
        averageUserRating: 4.4,
        userRatingCount: 4000,
        expiresAt: "2099-01-01T00:00:00.000Z",
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      {
        appId: "5",
        country: "US",
        name: "Cached 5",
        averageUserRating: 4.3,
        userRatingCount: 5000,
        expiresAt: "2099-01-01T00:00:00.000Z",
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
    ];

    await expect(
      enrichKeyword(
        {
          keyword: "word game",
          country: "US",
          popularity: 66,
        },
        { getAppDocs }
      )
    ).rejects.toThrow("Insufficient top-app docs for difficulty scoring");

    expect(mockedFetchAppStoreLookupAppDocs).toHaveBeenCalledTimes(2);

    await expect(
      enrichKeyword(
        {
          keyword: "word game plus",
          country: "US",
          popularity: 66,
        },
        { getAppDocs }
      )
    ).rejects.toThrow("Insufficient top-app docs for difficulty scoring");

    expect(mockedFetchAppStoreLookupAppDocs).toHaveBeenCalledTimes(2);
  });

  it("skips bundle search results when building top app ids for difficulty docs", async () => {
    const bundleId = "1814195639";
    mockedAsoAppleGet.mockResolvedValue({
      data: buildSearchHtmlForIds(
        ["1", "2", bundleId, "3", "4"],
        ["5", "6"],
        {
          kindsById: {
            [bundleId]: "BundleSearchResult",
          },
          resultTypesById: {
            [bundleId]: "bundle",
          },
        }
      ),
    } as never);
    mockedFetchAppStoreLookupAppDocs.mockResolvedValue([
      {
        appId: "1",
        country: "US",
        name: "Lookup 1",
        averageUserRating: 4.8,
        userRatingCount: 1000,
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      {
        appId: "2",
        country: "US",
        name: "Lookup 2",
        averageUserRating: 4.7,
        userRatingCount: 2000,
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      {
        appId: "3",
        country: "US",
        name: "Lookup 3",
        averageUserRating: 4.6,
        userRatingCount: 3000,
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      {
        appId: "4",
        country: "US",
        name: "Lookup 4",
        averageUserRating: 4.5,
        userRatingCount: 4000,
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      {
        appId: "5",
        country: "US",
        name: "Lookup 5",
        averageUserRating: 4.4,
        userRatingCount: 5000,
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
    ]);

    const result = await enrichKeyword(
      {
        keyword: "youtube",
        country: "US",
        popularity: 92,
      },
      {
        getAppDocs: async () => [],
      }
    );

    expect(result.orderedAppIds.slice(0, 5)).toEqual(["1", "2", "3", "4", "5"]);
    expect(result.orderedAppIds).not.toContain(bundleId);
    const lookupCalls = mockedFetchAppStoreLookupAppDocs.mock.calls.map(
      (call) => call[0]
    );
    expect(lookupCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          country: "US",
          appIds: ["1", "2", "3", "4"],
        }),
        expect.objectContaining({
          country: "US",
          appIds: ["5"],
        }),
      ])
    );
    for (const call of lookupCalls) {
      expect(call?.appIds ?? []).not.toContain(bundleId);
    }
  });

  it("matches keywords per localization and does not mix words across localizations", async () => {
    mockedAsoAppleGet.mockResolvedValue({
      data: buildSearchHtmlForIds(["1", "2", "3", "4", "5"]),
    } as never);

    const result = await enrichKeyword(
      {
        keyword: "app dormir",
        country: "US",
        popularity: 66,
      },
      {
        getAppDocs: async () => [
          {
            appId: "1",
            country: "US",
            name: "Cached 1",
            averageUserRating: 4.7,
            userRatingCount: 1000,
            expiresAt: "2099-01-01T00:00:00.000Z",
            releaseDate: "2024-01-01T00:00:00.000Z",
            currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
            additionalLocalizations: {
              "es-MX": {
                name: "dormir rapido",
              },
            },
          },
          {
            appId: "2",
            country: "US",
            name: "Cached 2",
            averageUserRating: 4.6,
            userRatingCount: 2000,
            expiresAt: "2099-01-01T00:00:00.000Z",
            releaseDate: "2024-01-01T00:00:00.000Z",
            currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
            additionalLocalizations: {
              "es-MX": {
                name: "app dormir rapido",
              },
            },
          },
          {
            appId: "3",
            country: "US",
            name: "Cached 3",
            averageUserRating: 4.5,
            userRatingCount: 3000,
            expiresAt: "2099-01-01T00:00:00.000Z",
            releaseDate: "2024-01-01T00:00:00.000Z",
            currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
          },
          {
            appId: "4",
            country: "US",
            name: "Cached 4",
            averageUserRating: 4.4,
            userRatingCount: 4000,
            expiresAt: "2099-01-01T00:00:00.000Z",
            releaseDate: "2024-01-01T00:00:00.000Z",
            currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
          },
          {
            appId: "5",
            country: "US",
            name: "Cached 5",
            averageUserRating: 4.3,
            userRatingCount: 5000,
            expiresAt: "2099-01-01T00:00:00.000Z",
            releaseDate: "2024-01-01T00:00:00.000Z",
            currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
          },
        ],
      }
    );

    expect(result.keywordMatch).toBe("titleExactPhrase");
  });

  it("does not set expiresAt for non-top apps without app-specific lookup", async () => {
    mockedAsoAppleGet.mockResolvedValue({
      data: buildSearchHtmlForIds(["1", "2", "3", "4", "5", "6"]),
    } as never);

    mockedFetchAppStoreLookupAppDocs.mockResolvedValue([
      {
        appId: "1",
        country: "US",
        name: "Lookup 1",
        averageUserRating: 4.8,
        userRatingCount: 1111,
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      {
        appId: "2",
        country: "US",
        name: "Lookup 2",
        averageUserRating: 4.7,
        userRatingCount: 2222,
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      {
        appId: "3",
        country: "US",
        name: "Lookup 3",
        averageUserRating: 4.6,
        userRatingCount: 3333,
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      {
        appId: "4",
        country: "US",
        name: "Lookup 4",
        averageUserRating: 4.5,
        userRatingCount: 4444,
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      {
        appId: "5",
        country: "US",
        name: "Lookup 5",
        averageUserRating: 4.4,
        userRatingCount: 5555,
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
    ]);

    const result = await enrichKeyword(
      {
        keyword: "word game",
        country: "US",
        popularity: 66,
      },
      {
        getAppDocs: async () => [],
      }
    );

    expect(result.appDocs.find((doc) => doc.appId === "6")?.expiresAt).toBeUndefined();
    expect(result.appDocs.find((doc) => doc.appId === "1")?.expiresAt).toBe(
      "2099-01-01T00:00:00.000Z"
    );
  });

  it("backfills missing top docs from cache and lookup when lockups are sparse", async () => {
    mockedAsoAppleGet.mockResolvedValue({
      data: buildSearchHtmlForIds(["1", "2", "3"], ["4", "5", "6"]),
    } as never);

    const lookupById: Record<string, any> = {
      "1": {
        appId: "1",
        country: "US",
        name: "Lookup 1",
        averageUserRating: 4.8,
        userRatingCount: 1111,
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      "2": {
        appId: "2",
        country: "US",
        name: "Lookup 2",
        averageUserRating: 4.7,
        userRatingCount: 2222,
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      "3": {
        appId: "3",
        country: "US",
        name: "Lookup 3",
        averageUserRating: 4.6,
        userRatingCount: 3333,
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
      "5": {
        appId: "5",
        country: "US",
        name: "Lookup 5",
        averageUserRating: 4.4,
        userRatingCount: 5555,
        releaseDate: "2024-01-01T00:00:00.000Z",
        currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
      },
    };
    mockedFetchAppStoreLookupAppDocs.mockImplementation(async ({ appIds }) =>
      appIds.flatMap((id) => (lookupById[id] ? [lookupById[id]] : []))
    );

    const result = await enrichKeyword(
      {
        keyword: "word game",
        country: "US",
        popularity: 66,
      },
      {
        getAppDocs: async (appIds) =>
          appIds.includes("4")
            ? [
                {
                  appId: "4",
                  country: "US",
                  name: "Cached 4",
                  averageUserRating: 4.5,
                  userRatingCount: 4444,
                  releaseDate: "2024-01-01T00:00:00.000Z",
                  currentVersionReleaseDate: "2025-01-01T00:00:00.000Z",
                  expiresAt: "2099-01-01T00:00:00.000Z",
                },
              ]
            : [],
      }
    );

    expect(result.orderedAppIds.slice(0, 5)).toEqual(["1", "2", "3", "4", "5"]);
    const docsForDifficultyCount = result.orderedAppIds
      .slice(0, 5)
      .filter((id) => result.appDocs.some((doc) => doc.appId === id)).length;
    expect(docsForDifficultyCount).toBe(5);
    expect(result.appDocs.find((doc) => doc.appId === "4")).toEqual(
      expect.objectContaining({
        appId: "4",
        name: "Cached 4",
      })
    );
    expect(result.appDocs.find((doc) => doc.appId === "5")).toEqual(
      expect.objectContaining({
        appId: "5",
        name: "Lookup 5",
        expiresAt: "2099-01-01T00:00:00.000Z",
      })
    );
  });

  it("fails with INSUFFICIENT_DOCS when top docs remain missing for competitive keywords", async () => {
    mockedAsoAppleGet.mockResolvedValue({
      data: buildSearchHtmlForIds(["1", "2", "3"], ["4", "5"]),
    } as never);
    mockedFetchAppStoreLookupAppDocs.mockResolvedValue([]);

    await expect(
      enrichKeyword(
        {
          keyword: "word game",
          country: "US",
          popularity: 66,
        },
        {
          getAppDocs: async () => [],
        }
      )
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_DOCS",
      statusCode: 503,
    });
  });

  it("fails with INSUFFICIENT_DOCS when top docs exist but release dates remain missing", async () => {
    mockedAsoAppleGet.mockResolvedValue({
      data: buildSearchHtmlForIds(["1", "2", "3"], ["4", "5"]),
    } as never);
    mockedFetchAppStoreLookupAppDocs.mockResolvedValue([]);

    await expect(
      enrichKeyword(
        {
          keyword: "word game",
          country: "US",
          popularity: 66,
        },
        {
          getAppDocs: async (appIds) =>
            appIds.map((appId) => ({
              appId,
              country: "US",
              name: `Cached ${appId}`,
              averageUserRating: 4.5,
              userRatingCount: 1000,
              releaseDate: null,
              currentVersionReleaseDate: null,
              expiresAt: "2099-01-01T00:00:00.000Z",
            })),
        }
      )
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_DOCS",
      statusCode: 503,
    });
  });

  it("detects brand keyword from search lockup publisher", async () => {
    mockedAsoAppleGet.mockResolvedValue({
      data: buildSearchHtmlForIds(
        ["1", "2", "3", "4", "5"],
        [],
        {
          developerNamesById: {
            "1": "Dream Labs LLC",
          },
          ratingCountById: {
            "1": 1500,
          },
        }
      ),
    } as never);

    const result = await enrichKeyword(
      {
        keyword: "dream labs",
        country: "US",
        popularity: 66,
      },
      {
        getAppDocs: async () => buildCompleteCachedTopDocs(["1", "2", "3", "4", "5"]),
      }
    );

    expect(result.isBrandKeyword).toBe(true);
  });

  it("detects brand keyword from lookup fallback publisher", async () => {
    mockedAsoAppleGet
      .mockResolvedValueOnce({
        data: "<html><body>no serialized data</body></html>",
      } as never)
      .mockResolvedValueOnce({
        data: {
          pageData: {
            bubbles: [
              {
                name: "software",
                results: [
                  { id: "1" },
                  { id: "2" },
                  { id: "3" },
                  { id: "4" },
                  { id: "5" },
                ],
              },
            ],
          },
        },
      } as never);
    mockedFetchAppStoreLookupAppDocs.mockResolvedValue(
      buildCompleteCachedTopDocs(["1", "2", "3", "4", "5"], {
        publisherNamesById: {
          "1": "Acme Studios",
          "2": "Other One",
          "3": "Other Two",
          "4": "Other Three",
          "5": "Other Four",
        },
      }).map((doc) => ({
        ...doc,
        userRatingCount: doc.appId === "1" ? 2000 : doc.userRatingCount,
      }))
    );

    const result = await enrichKeyword({
      keyword: "acme studios",
      country: "US",
      popularity: 66,
    });

    expect(result.isBrandKeyword).toBe(true);
  });

  it("returns non-brand when #1 publisher tokens do not match keyword", async () => {
    mockedAsoAppleGet.mockResolvedValue({
      data: buildSearchHtmlForIds(
        ["1", "2", "3", "4", "5"],
        [],
        {
          developerNamesById: {
            "1": "Different Publisher",
          },
          ratingCountById: {
            "1": 3000,
          },
        }
      ),
    } as never);

    const result = await enrichKeyword(
      {
        keyword: "acme sleep",
        country: "US",
        popularity: 66,
      },
      {
        getAppDocs: async () => buildCompleteCachedTopDocs(["1", "2", "3", "4", "5"]),
      }
    );

    expect(result.isBrandKeyword).toBe(false);
  });

  it("marks weak leader as brand when independent runner-up median ratings are strong", async () => {
    mockedAsoAppleGet.mockResolvedValue({
      data: buildSearchHtmlForIds(
        ["1", "2", "3", "4", "5"],
        [],
        {
          developerNamesById: {
            "1": "Acme Labs",
            "2": "Runner A",
            "3": "Runner B",
            "4": "Runner C",
            "5": "Runner D",
          },
          ratingCountById: {
            "1": 500,
            "2": 12000,
            "3": 15000,
            "4": 20000,
            "5": 8000,
          },
        }
      ),
    } as never);

    const result = await enrichKeyword(
      {
        keyword: "acme labs",
        country: "US",
        popularity: 66,
      },
      {
        getAppDocs: async () => buildCompleteCachedTopDocs(["1", "2", "3", "4", "5"]),
      }
    );

    expect(result.isBrandKeyword).toBe(true);
  });

  it("marks weak leader as non-brand when independent runner-up median ratings are weak", async () => {
    mockedAsoAppleGet.mockResolvedValue({
      data: buildSearchHtmlForIds(
        ["1", "2", "3", "4", "5"],
        [],
        {
          developerNamesById: {
            "1": "Acme Labs",
            "2": "Runner A",
            "3": "Runner B",
            "4": "Runner C",
            "5": "Runner D",
          },
          ratingCountById: {
            "1": 500,
            "2": 1000,
            "3": 2000,
            "4": 5000,
            "5": 7000,
          },
        }
      ),
    } as never);

    const result = await enrichKeyword(
      {
        keyword: "acme labs",
        country: "US",
        popularity: 66,
      },
      {
        getAppDocs: async () => buildCompleteCachedTopDocs(["1", "2", "3", "4", "5"]),
      }
    );

    expect(result.isBrandKeyword).toBe(false);
  });

  it("defaults brand detection to false when publisher metadata is missing", async () => {
    mockedAsoAppleGet.mockResolvedValue({
      data: buildSearchHtmlForIds(["1", "2", "3", "4", "5"]),
    } as never);

    const result = await enrichKeyword(
      {
        keyword: "acme labs",
        country: "US",
        popularity: 66,
      },
      {
        getAppDocs: async () =>
          buildCompleteCachedTopDocs(["1", "2", "3", "4", "5"]).map((doc) => {
            const { publisherName, ...rest } = doc;
            return rest;
          }),
      }
    );

    expect(result.isBrandKeyword).toBe(false);
  });
});
