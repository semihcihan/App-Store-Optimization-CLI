import { jest } from "@jest/globals";
import { enrichKeyword } from "./aso-enrichment-service";
import { asoAppleGet } from "./aso-apple-client";
import { fetchAppStoreLookupAppDocs } from "./aso-app-doc-service";

jest.mock("./aso-apple-client", () => ({
  asoAppleGet: jest.fn(),
}));

jest.mock("./aso-app-doc-service", () => ({
  fetchAppStoreLookupAppDocs: jest.fn(),
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

function buildSearchHtml(): string {
  return `<html><body><script id="serialized-server-data">${JSON.stringify({
    data: [
      {
        data: {
          shelves: [
            {
              contentType: "searchResult",
              items: [
                {
                  lockup: {
                    adamId: "1",
                    title: "App 1",
                    subtitle: "Sub 1",
                    rating: 4.7,
                    ratingCount: "130K",
                  },
                },
                {
                  lockup: {
                    adamId: "2",
                    title: "App 2",
                    subtitle: "Sub 2",
                    rating: 4.6,
                    ratingCount: "12K",
                  },
                },
                {
                  lockup: {
                    adamId: "3",
                    title: "App 3",
                    subtitle: "Sub 3",
                    rating: 4.5,
                    ratingCount: "3.5K",
                  },
                },
                {
                  lockup: {
                    adamId: "4",
                    title: "App 4",
                    subtitle: "Sub 4",
                    rating: 4.4,
                    ratingCount: "890",
                  },
                },
                {
                  lockup: {
                    adamId: "5",
                    title: "App 5",
                    subtitle: "Sub 5",
                    rating: 4.3,
                    ratingCount: "1.2K",
                  },
                },
              ],
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
});
