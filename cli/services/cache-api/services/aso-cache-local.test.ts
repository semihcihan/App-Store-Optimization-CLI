import { LocalAsoCacheRepository } from "./aso-cache-local";
import {
  closeDbForTests,
  getKeyword,
  getCompetitorAppDocs,
  upsertKeywords,
  upsertCompetitorAppDocs,
} from "../../../db";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

describe("aso-cache-local", () => {
  const originalEnv = process.env;
  const testDbPath = path.join(
    os.tmpdir(),
    `aso-cache-repo-${process.pid}-${Date.now()}.sqlite`
  );

  function cleanDbFiles(): void {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.unlinkSync(`${testDbPath}${suffix}`);
      } catch {}
    }
  }

  beforeAll(() => {
    process.env.ASO_DB_PATH = testDbPath;
  });

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.ASO_DB_PATH = testDbPath;
    closeDbForTests();
    cleanDbFiles();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    closeDbForTests();
    cleanDbFiles();
  });

  afterAll(() => {
    closeDbForTests();
    cleanDbFiles();
    delete process.env.ASO_DB_PATH;
    process.env = originalEnv;
  });

  it("upserts keywords and returns cache hits/misses with normalization", async () => {
    process.env.ASO_KEYWORD_ORDER_TTL_HOURS = "1";
    process.env.ASO_POPULARITY_CACHE_TTL_HOURS = "720";
    const repository = new LocalAsoCacheRepository();

    await repository.upsertMany({
      country: "us",
      items: [
        {
          keyword: "  Puzzle ",
          popularity: 55,
          difficultyScore: 20,
          minDifficultyScore: 10,
          appCount: 100,
          keywordIncluded: 40,
          orderedAppIds: ["1", "2"],
        },
      ],
    });

    const result = await repository.getByKeywords({
      country: "US",
      keywords: ["puzzle", "missing"],
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toEqual(
      expect.objectContaining({
        country: "US",
        normalizedKeyword: "puzzle",
        popularity: 55,
      })
    );
    expect(result.misses).toEqual(["missing"]);
  });

  it("preserves createdAt on keyword updates", async () => {
    const repository = new LocalAsoCacheRepository();

    const [first] = await repository.upsertMany({
      country: "US",
      items: [
        {
          keyword: "word",
          popularity: 10,
          difficultyScore: 11,
          minDifficultyScore: 1,
          appCount: 2,
          keywordIncluded: 1,
          orderedAppIds: ["1"],
        },
      ],
    });

    const [second] = await repository.upsertMany({
      country: "US",
      items: [
        {
          keyword: "word",
          popularity: 50,
          difficultyScore: 15,
          minDifficultyScore: 2,
          appCount: 3,
          keywordIncluded: 2,
          orderedAppIds: ["1", "2"],
        },
      ],
    });

    expect(second.createdAt).toBe(first.createdAt);
    expect(Date.parse(second.updatedAt)).toBeGreaterThanOrEqual(
      Date.parse(first.updatedAt)
    );
  });

  it("treats expired keyword rows as cache misses", async () => {
    upsertKeywords("US", [
      {
        keyword: "stale",
        popularity: 33,
        difficultyScore: 12,
        minDifficultyScore: 4,
        appCount: 10,
        keywordIncluded: 2,
        orderedAppIds: ["1"],
        orderExpiresAt: "2000-01-01T00:00:00.000Z",
      },
    ]);
    const repository = new LocalAsoCacheRepository();
    const result = await repository.getByKeywords({
      country: "US",
      keywords: ["stale"],
    });

    expect(result.hits).toEqual([]);
    expect(result.misses).toEqual(["stale"]);
  });

  it("treats popularity-only keyword rows as cache misses", async () => {
    upsertKeywords("US", [
      {
        keyword: "pending",
        popularity: 40,
        difficultyScore: null,
        minDifficultyScore: null,
        appCount: null,
        keywordIncluded: null,
        orderedAppIds: [],
        orderExpiresAt: "2099-01-01T00:00:00.000Z",
      },
    ]);

    const repository = new LocalAsoCacheRepository();
    const result = await repository.getByKeywords({
      country: "US",
      keywords: ["pending"],
    });

    expect(result.hits).toEqual([]);
    expect(result.misses).toEqual(["pending"]);
  });

  it("returns only non-expired app docs", async () => {
    upsertCompetitorAppDocs("US", [
      {
        appId: "fresh",
        name: "Fresh App",
        averageUserRating: 4,
        userRatingCount: 100,
        additionalLocalizations: {
          "es-MX": {
            title: "Fresh App ES",
          },
        },
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      {
        appId: "old",
        name: "Old App",
        averageUserRating: 3,
        userRatingCount: 10,
        expiresAt: "2000-01-01T00:00:00.000Z",
      },
    ]);

    const repository = new LocalAsoCacheRepository();
    const docs = await repository.getAppDocs({
      country: "US",
      appIds: ["fresh", "old", "missing"],
    });

    expect(docs).toEqual([
      expect.objectContaining({
        appId: "fresh",
        country: "US",
        name: "Fresh App",
        additionalLocalizations: {
          "es-MX": {
            title: "Fresh App ES",
          },
        },
      }),
    ]);
  });

  it("does not auto-set expiresAt for app docs without explicit expiry", async () => {
    const repository = new LocalAsoCacheRepository();

    await repository.upsertMany({
      country: "US",
      items: [],
      appDocs: [
        {
          appId: "partial",
          country: "US",
          name: "Partial App",
          averageUserRating: 4.1,
          userRatingCount: 22,
          releaseDate: null,
          currentVersionReleaseDate: null,
        },
      ],
    });

    const stored = getCompetitorAppDocs("US", ["partial"]);
    expect(stored[0]?.expiresAt).toBeUndefined();

    const docs = await repository.getAppDocs({
      country: "US",
      appIds: ["partial"],
    });
    expect(docs).toEqual([]);
  });

  it("writes keyword rows to sqlite via upsertMany", async () => {
    const repository = new LocalAsoCacheRepository();
    await repository.upsertMany({
      country: "US",
      items: [
        {
          keyword: "stored",
          popularity: 44,
          difficultyScore: 22,
          minDifficultyScore: 11,
          appCount: 9,
          keywordIncluded: 2,
          orderedAppIds: ["100"],
        },
      ],
    });
    const stored = getKeyword("US", "stored");
    expect(stored).toEqual(
      expect.objectContaining({
        keyword: "stored",
        popularity: 44,
        difficultyScore: 22,
      })
    );
  });

  it("does not return app docs from other countries", async () => {
    upsertCompetitorAppDocs("GB", [
      {
        appId: "legacy",
        name: "Legacy App",
        averageUserRating: 5,
        userRatingCount: 10,
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    ]);
    const repository = new LocalAsoCacheRepository();
    const docs = await repository.getAppDocs({
      country: "US",
      appIds: ["legacy"],
    });

    expect(docs).toEqual([]);
  });
});
