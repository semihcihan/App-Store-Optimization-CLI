import { jest } from "@jest/globals";
import { enrichKeyword } from "./aso-enrichment-service";
import { asoAppleGet } from "./aso-apple-client";
import { fetchAppStoreLookupAppDocs } from "./aso-app-doc-service";
import { fetchAppStoreAdditionalLocalizations } from "./aso-app-store-details";

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

const mockedAsoAppleGet = jest.mocked(asoAppleGet);
const mockedFetchAppStoreLookupAppDocs = jest.mocked(fetchAppStoreLookupAppDocs);
const mockedFetchAppStoreAdditionalLocalizations = jest.mocked(
  fetchAppStoreAdditionalLocalizations
);

function buildSearchHtml(): string {
  return buildSearchHtmlForIds(["1", "2", "3", "4", "5"]);
}

function buildSearchHtmlForIds(ids: string[]): string {
  const items = ids.map((id, index) => ({
    lockup: {
      adamId: id,
      title: `App ${id}`,
      subtitle: `Sub ${id}`,
      rating: Math.max(1, 4.9 - index * 0.1),
      ratingCount: `${(index + 1) * 1000}`,
    },
  }));
  return `<html><body><script id="serialized-server-data">${JSON.stringify({
    data: [
      {
        data: {
          shelves: [
            {
              contentType: "searchResult",
              items,
            },
          ],
          nextPage: {
            results: [],
          },
        },
      },
    ],
  })}</script></body></html>`;
}

describe("aso-enrichment-service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedFetchAppStoreAdditionalLocalizations.mockResolvedValue({});
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
                title: "dormir rapido",
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
                title: "app dormir rapido",
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
});
