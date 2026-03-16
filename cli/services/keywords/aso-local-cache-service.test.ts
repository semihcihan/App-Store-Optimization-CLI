import { jest } from "@jest/globals";
import {
  enrichAsoKeywords,
  getAsoAppDocs,
  lookupAsoCache,
  refreshKeywordOrder,
} from "../cache-api";
import {
  enrichAsoKeywordsLocal,
  getAsoAppDocsLocal,
  lookupAsoCacheLocal,
  refreshAsoKeywordOrderLocal,
} from "./aso-local-cache-service";

jest.mock("../cache-api", () => ({
  lookupAsoCache: jest.fn(),
  enrichAsoKeywords: jest.fn(),
  getAsoAppDocs: jest.fn(),
  refreshKeywordOrder: jest.fn(),
}));

describe("aso-local-cache-service", () => {
  const mockLookupAsoCache = jest.mocked(lookupAsoCache);
  const mockEnrichAsoKeywords = jest.mocked(enrichAsoKeywords);
  const mockGetAsoAppDocs = jest.mocked(getAsoAppDocs);
  const mockRefreshKeywordOrder = jest.mocked(refreshKeywordOrder);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("forwards lookup requests to cache-api", async () => {
    const expected = { hits: [], misses: ["a"] };
    mockLookupAsoCache.mockResolvedValue(expected as any);

    const result = await lookupAsoCacheLocal("US", ["a"]);

    expect(result).toEqual(expected);
    expect(mockLookupAsoCache).toHaveBeenCalledWith({
      country: "US",
      keywords: ["a"],
    });
  });

  it("forwards enrichment requests to cache-api", async () => {
    const expected = { items: [], failedKeywords: [] };
    mockEnrichAsoKeywords.mockResolvedValue(expected as any);

    const result = await enrichAsoKeywordsLocal("US", [
      { keyword: "term", popularity: 42 },
    ]);

    expect(result).toEqual(expected);
    expect(mockEnrichAsoKeywords).toHaveBeenCalledWith({
      country: "US",
      items: [{ keyword: "term", popularity: 42 }],
    });
  });

  it("forwards app doc requests to cache-api", async () => {
    const expected = [{ appId: "1", country: "US", name: "Example" }];
    mockGetAsoAppDocs.mockResolvedValue(expected as any);

    const result = await getAsoAppDocsLocal("US", ["1"]);

    expect(result).toEqual(expected);
    expect(mockGetAsoAppDocs).toHaveBeenCalledWith({
      country: "US",
      appIds: ["1"],
    });
  });

  it("forwards app doc force-lookup requests to cache-api", async () => {
    const expected = [{ appId: "1", country: "US", name: "Fresh" }];
    mockGetAsoAppDocs.mockResolvedValue(expected as any);

    const result = await getAsoAppDocsLocal("US", ["1"], { forceLookup: true });

    expect(result).toEqual(expected);
    expect(mockGetAsoAppDocs).toHaveBeenCalledWith({
      country: "US",
      appIds: ["1"],
      forceLookup: true,
    });
  });

  it("forwards order-refresh requests to cache-api", async () => {
    const expected = {
      keyword: "term",
      normalizedKeyword: "term",
      appCount: 3,
      orderedAppIds: ["1", "2", "3"],
    };
    mockRefreshKeywordOrder.mockResolvedValue(expected as any);

    const result = await refreshAsoKeywordOrderLocal("US", "term");

    expect(result).toEqual(expected);
    expect(mockRefreshKeywordOrder).toHaveBeenCalledWith({
      country: "US",
      keyword: "term",
    });
  });
});
