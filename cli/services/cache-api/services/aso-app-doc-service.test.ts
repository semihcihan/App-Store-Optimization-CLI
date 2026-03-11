import { jest } from "@jest/globals";
import axios from "axios";
import {
  fetchAppStoreLookupAppDocs,
  getAsoAppDocs,
} from "./aso-app-doc-service";
import type { AsoCacheRepository } from "./aso-types";

jest.mock("axios");
jest.mock("./aso-keyword-utils", () => ({
  computeAppExpiryIsoForApp: jest.fn(() => "2099-12-31T00:00:00.000Z"),
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

function createRepository(
  overrides: Partial<AsoCacheRepository> = {}
): AsoCacheRepository {
  return {
    getByKeywords: (jest.fn(async () => ({ hits: [], misses: [] })) as unknown) as AsoCacheRepository["getByKeywords"],
    upsertMany: (jest.fn(async () => []) as unknown) as AsoCacheRepository["upsertMany"],
    ...overrides,
  };
}

describe("aso-app-doc-service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("maps apps.apple.com payload into app docs and skips missing payloads", async () => {
    mockedAxios.get
      .mockResolvedValueOnce({
        data: {
          storePlatformData: {
            "product-dv": {
              results: {
                "1": {
                  id: "1",
                  name: "One",
                  subtitle: "Sub",
                  releaseDate: "2025-01-01",
                  userRating: { value: 4.5, ratingCount: 100 },
                  artwork: { url: "https://cdn/icon.png" },
                },
              },
            },
          },
          pageData: {
            versionHistory: [{ releaseDate: "2025-01-05T00:00:00Z" }],
          },
        },
      } as never)
      .mockResolvedValueOnce({ data: {} } as never);

    const result = await fetchAppStoreLookupAppDocs({
      country: "US",
      appIds: ["1", "2"],
    });

    expect(result).toEqual([
      {
        appId: "1",
        country: "US",
        name: "One",
        subtitle: "Sub",
        averageUserRating: 4.5,
        userRatingCount: 100,
        releaseDate: "2025-01-01",
        currentVersionReleaseDate: "2025-01-05T00:00:00Z",
        iconArtwork: { url: "https://cdn/icon.png" },
      },
    ]);
    expect(mockedAxios.get).toHaveBeenNthCalledWith(
      1,
      "https://apps.apple.com/app/id1",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Apple-Store-Front": "143441-1,29",
        }),
      })
    );
  });

  it("returns cached docs first, fetches missing docs, and persists them", async () => {
    const repository = createRepository({
      getAppDocs: (jest.fn(async () => [
        {
          appId: "1",
          country: "US",
          name: "Cached",
          averageUserRating: 4,
          userRatingCount: 10,
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      ]) as unknown) as AsoCacheRepository["getAppDocs"],
    });
    mockedAxios.get.mockResolvedValue({
      data: {
        storePlatformData: {
          "product-dv": {
            results: {
              "2": {
                id: "2",
                name: "Fetched",
                subtitle: "Fetched subtitle",
                releaseDate: "2025-01-01",
                userRating: { value: 3.5, ratingCount: 50 },
              },
            },
          },
        },
        pageData: {
          versionHistory: [{ releaseDate: "2025-01-02T00:00:00Z" }],
        },
      },
    } as never);

    const result = await getAsoAppDocs({
      country: "us",
      appIds: ["1", "2", "2", " "],
      repository,
    });

    expect(repository.getAppDocs).toHaveBeenCalledWith({
      country: "US",
      appIds: ["1", "2"],
    });
    expect(repository.upsertMany).toHaveBeenCalledWith({
      country: "US",
      items: [],
      appDocs: [
        expect.objectContaining({
          appId: "2",
          country: "US",
          name: "Fetched",
          expiresAt: "2099-12-31T00:00:00.000Z",
        }),
      ],
    });
    expect(result).toEqual([
      expect.objectContaining({ appId: "1", country: "US", name: "Cached" }),
      expect.objectContaining({ appId: "2", country: "US", name: "Fetched" }),
    ]);
  });

  it("returns empty when repository does not support app docs", async () => {
    const repository = createRepository();

    const result = await getAsoAppDocs({
      country: "US",
      appIds: ["1"],
      repository,
    });

    expect(result).toEqual([]);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it("throws for non-US country", async () => {
    const repository = createRepository({
      getAppDocs: (jest.fn(async () => []) as unknown) as AsoCacheRepository["getAppDocs"],
    });

    await expect(
      getAsoAppDocs({
        country: "TR",
        appIds: ["1"],
        repository,
      })
    ).rejects.toThrow("Only US is supported for now");
  });
});
