import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  getKeyword,
  listKeywords,
  upsertKeywords,
  getExpiredKeywords,
} from "./aso-keywords";
import { closeDbForTests } from "./store";

const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `aso-aso-keywords-${process.pid}-${Date.now()}.sqlite`
);

function cleanDbFiles(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

describe("aso-keywords", () => {
  beforeAll(() => {
    process.env.ASO_DB_PATH = TEST_DB_PATH;
  });

  beforeEach(() => {
    closeDbForTests();
    cleanDbFiles();
  });

  afterAll(() => {
    closeDbForTests();
    cleanDbFiles();
    delete process.env.ASO_DB_PATH;
  });

  it("returns null when keyword is missing", () => {
    expect(getKeyword("US", "missing")).toBeNull();
  });

  it("inserts and reads keyword by normalized key", () => {
    upsertKeywords("US", [
      {
        keyword: "Mixed",
        popularity: 10,
        difficultyScore: 2,
        minDifficultyScore: 1,
        appCount: 4,
        keywordMatch: "titleExactPhrase",
        orderedAppIds: ["a", "b"],
        orderExpiresAt: "2026-12-31T00:00:00.000Z",
      },
    ]);
    const exact = getKeyword("US", "mixed");
    const normalized = getKeyword("US", "  MIXED  ");
    expect(exact).not.toBeNull();
    expect(normalized?.normalizedKeyword).toBe("mixed");
    expect(normalized?.orderedAppIds).toEqual(["a", "b"]);
  });

  it("lists only the requested country", () => {
    upsertKeywords("US", [
      {
        keyword: "us-keyword",
        popularity: 1,
        difficultyScore: null,
        minDifficultyScore: null,
        appCount: null,
        keywordMatch: null,
        orderedAppIds: [],
        orderExpiresAt: "2026-12-31T00:00:00.000Z",
      },
    ]);
    upsertKeywords("GB", [
      {
        keyword: "gb-keyword",
        popularity: 2,
        difficultyScore: null,
        minDifficultyScore: null,
        appCount: null,
        keywordMatch: null,
        orderedAppIds: [],
        orderExpiresAt: "2026-12-31T00:00:00.000Z",
      },
    ]);
    expect(listKeywords("US").map((k) => k.keyword)).toEqual(["us-keyword"]);
  });

  it("rounds difficulty scores before persisting", () => {
    upsertKeywords("US", [
      {
        keyword: "rounded",
        popularity: 10,
        difficultyScore: 42.6,
        minDifficultyScore: 18.2,
        appCount: 4,
        keywordMatch: "titleExactPhrase",
        orderedAppIds: [],
        orderExpiresAt: "2026-12-31T00:00:00.000Z",
      },
    ]);
    const row = getKeyword("US", "rounded");
    expect(row?.difficultyScore).toBe(43);
    expect(row?.minDifficultyScore).toBe(18);
  });

  it("preserves createdAt while updating existing keyword", () => {
    upsertKeywords("US", [
      {
        keyword: "keep-created",
        popularity: 1,
        difficultyScore: 1,
        minDifficultyScore: 0,
        appCount: 1,
        keywordMatch: "titleExactPhrase",
        orderedAppIds: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        orderExpiresAt: "2026-12-31T00:00:00.000Z",
      },
    ]);
    upsertKeywords("US", [
      {
        keyword: "keep-created",
        popularity: 9,
        difficultyScore: 3,
        minDifficultyScore: 1,
        appCount: 10,
        keywordMatch: "titleAllWords",
        orderedAppIds: ["x"],
        orderExpiresAt: "2026-12-31T00:00:00.000Z",
      },
    ]);
    const row = getKeyword("US", "keep-created");
    expect(row?.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(row?.popularity).toBe(9);
    expect(row?.orderedAppIds).toEqual(["x"]);
  });

  it("returns only expired keywords for the selected country", () => {
    const past = new Date(Date.now() - 5000).toISOString();
    const future = new Date(Date.now() + 86400000).toISOString();
    upsertKeywords("US", [
      {
        keyword: "expired-us",
        popularity: 1,
        difficultyScore: null,
        minDifficultyScore: null,
        appCount: null,
        keywordMatch: null,
        orderedAppIds: [],
        orderExpiresAt: past,
      },
      {
        keyword: "fresh-us",
        popularity: 1,
        difficultyScore: null,
        minDifficultyScore: null,
        appCount: null,
        keywordMatch: null,
        orderedAppIds: [],
        orderExpiresAt: future,
      },
    ]);
    upsertKeywords("GB", [
      {
        keyword: "expired-gb",
        popularity: 1,
        difficultyScore: null,
        minDifficultyScore: null,
        appCount: null,
        keywordMatch: null,
        orderedAppIds: [],
        orderExpiresAt: past,
      },
    ]);
    expect(getExpiredKeywords("US")).toEqual(["expired-us"]);
  });
});
