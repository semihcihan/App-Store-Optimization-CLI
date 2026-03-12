import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { jest } from "@jest/globals";
import { getKeyword, upsertKeywords } from "../../db/aso-keywords";
import { createAppKeyword, listByApp } from "../../db/app-keywords";
import { closeDbForTests } from "../../db/store";
import { refreshAsoKeywordOrderLocal } from "./aso-local-cache-service";
import { refreshAndPersistKeywordOrder } from "./aso-keyword-service";

jest.mock("./aso-local-cache-service", () => ({
  lookupAsoCacheLocal: jest.fn(async () => ({ hits: [], misses: [] })),
  enrichAsoKeywordsLocal: jest.fn(async () => []),
  refreshAsoKeywordOrderLocal: jest.fn(),
}));

jest.mock("./aso-popularity-service", () => ({
  asoPopularityService: {
    fetchKeywordPopularities: jest.fn(async () => ({})),
  },
}));

const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `aso-keyword-service-${process.pid}-${Date.now()}.sqlite`
);

function cleanDbFiles(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

describe("aso-keyword-service", () => {
  const mockRefreshAsoKeywordOrderLocal = jest.mocked(refreshAsoKeywordOrderLocal);

  beforeAll(() => {
    process.env.ASO_DB_PATH = TEST_DB_PATH;
  });

  beforeEach(() => {
    closeDbForTests();
    cleanDbFiles();
    jest.clearAllMocks();
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
        keywordIncluded: 1,
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

    const refreshed = await refreshAndPersistKeywordOrder("US", ["ranked"]);

    expect(refreshed).toHaveLength(1);
    expect(getKeyword("US", "ranked")?.orderedAppIds).toEqual(["app-2", "app-1"]);
    expect(listByApp("app-1", "US")[0]?.previousPosition).toBe(1);
    expect(listByApp("app-2", "US")[0]?.previousPosition).toBe(2);
  });
});
