import fs from "fs";
import os from "os";
import path from "path";
import { LocalAsoCacheRepository } from "./aso-cache-local";

describe("aso-cache-local", () => {
  const originalEnv = process.env;
  let tempHome: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "aso-cache-local-"));
    jest.spyOn(os, "homedir").mockReturnValue(tempHome);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("upserts keywords and returns cache hits/misses with normalization", async () => {
    process.env.ASO_CACHE_TTL_HOURS = "1";
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

  it("returns keyword hits even when cached expiresAt is in the past", async () => {
    const cachePath = path.join(tempHome, ".aso", "aso-cache.json");
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        keywords: {
          "aso#keyword#stale#country#US": {
            keyword: "stale",
            normalizedKeyword: "stale",
            country: "US",
            popularity: 33,
            difficultyScore: 12,
            minDifficultyScore: 4,
            appCount: 10,
            keywordIncluded: 2,
            orderedAppIds: ["1"],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
            expiresAt: "2000-01-01T00:00:00.000Z",
          },
        },
        appDocs: {},
      }),
      "utf8"
    );

    const repository = new LocalAsoCacheRepository();
    const result = await repository.getByKeywords({
      country: "US",
      keywords: ["stale"],
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toEqual(
      expect.objectContaining({
        keyword: "stale",
        popularity: 33,
      })
    );
    expect(result.misses).toEqual([]);
  });

  it("returns only non-expired app docs", async () => {
    const repository = new LocalAsoCacheRepository();

    await repository.upsertMany({
      country: "US",
      items: [],
      appDocs: [
        {
          appId: "fresh",
          country: "US",
          name: "Fresh App",
          averageUserRating: 4,
          userRatingCount: 100,
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        {
          appId: "old",
          country: "US",
          name: "Old App",
          averageUserRating: 3,
          userRatingCount: 10,
          expiresAt: "2000-01-01T00:00:00.000Z",
        },
      ],
    });

    const docs = await repository.getAppDocs({
      country: "US",
      appIds: ["fresh", "old", "missing"],
    });

    expect(docs).toEqual([
      expect.objectContaining({
        appId: "fresh",
        country: "US",
        name: "Fresh App",
      }),
    ]);
  });

  it("does not return app docs missing explicit country", async () => {
    const cachePath = path.join(tempHome, ".aso", "aso-cache.json");
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        keywords: {},
        appDocs: {
          "aso#app#legacy#country#US": {
            appId: "legacy",
            name: "Legacy App",
            averageUserRating: 5,
            userRatingCount: 10,
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
        },
      }),
      "utf8"
    );

    const repository = new LocalAsoCacheRepository();
    const docs = await repository.getAppDocs({
      country: "US",
      appIds: ["legacy"],
    });

    expect(docs).toEqual([]);
  });
});
