import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { closeDbForTests } from "./store";
import { createAppKeywords, setPreviousPosition } from "./app-keywords";
import { upsertKeywords } from "./aso-keywords";
import { listUnionKeywords, getCompareMatrix } from "./app-compare";

const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `aso-app-compare-${process.pid}-${Date.now()}.sqlite`
);

function cleanDbFiles(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

function seedResearchedKeyword(
  country: string,
  keyword: string,
  orderedAppIds: string[],
  overrides: { popularity?: number; difficulty?: number | null } = {}
): void {
  upsertKeywords(country, [
    {
      keyword,
      popularity: overrides.popularity ?? 50,
      difficultyScore: overrides.difficulty ?? 40,
      minDifficultyScore: null,
      appCount: orderedAppIds.length,
      keywordMatch: null,
      orderedAppIds,
      orderExpiresAt: "2099-01-01T00:00:00.000Z",
    },
  ]);
}

describe("app-compare", () => {
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

  describe("listUnionKeywords", () => {
    it("returns the union of tracked keywords across the requested apps", () => {
      createAppKeywords("app1", ["shared", "only1"], "US");
      createAppKeywords("app2", ["shared", "only2"], "US");
      seedResearchedKeyword("US", "shared", ["app1", "app2"], {
        popularity: 80,
      });
      seedResearchedKeyword("US", "only1", ["app1"], { popularity: 40 });
      seedResearchedKeyword("US", "only2", ["app2"], { popularity: 60 });

      const rows = listUnionKeywords(["app1", "app2"], "US");
      const byKeyword = new Map(rows.map((r) => [r.keyword, r]));
      expect(byKeyword.size).toBe(3);
      const shared = byKeyword.get("shared");
      expect(shared?.trackedCount).toBe(2);
      expect(shared?.trackedByAppIds.slice().sort()).toEqual(["app1", "app2"]);
      expect(shared?.popularity).toBe(80);
      expect(shared?.isResearched).toBe(true);
      const only1 = byKeyword.get("only1");
      expect(only1?.trackedCount).toBe(1);
      expect(only1?.trackedByAppIds).toEqual(["app1"]);
    });

    it("orders by tracked count desc, then popularity desc", () => {
      createAppKeywords("app1", ["broad", "solo"], "US");
      createAppKeywords("app2", ["broad"], "US");
      seedResearchedKeyword("US", "broad", ["app1", "app2"], {
        popularity: 30,
      });
      seedResearchedKeyword("US", "solo", ["app1"], { popularity: 90 });

      const rows = listUnionKeywords(["app1", "app2"], "US");
      expect(rows[0].keyword).toBe("broad");
      expect(rows[1].keyword).toBe("solo");
    });

    it("marks keywords without aso_keywords row as not researched", () => {
      createAppKeywords("app1", ["pending"], "US");
      const rows = listUnionKeywords(["app1"], "US");
      expect(rows).toHaveLength(1);
      expect(rows[0].keyword).toBe("pending");
      expect(rows[0].isResearched).toBe(false);
      expect(rows[0].popularity).toBeNull();
      expect(rows[0].difficulty).toBeNull();
    });

    it("scopes to country and ignores app_ids not requested", () => {
      createAppKeywords("app1", ["scoped"], "US");
      createAppKeywords("app2", ["scoped"], "US");
      createAppKeywords("app1", ["scoped"], "GB");
      const rows = listUnionKeywords(["app1"], "US");
      expect(rows).toHaveLength(1);
      expect(rows[0].trackedByAppIds).toEqual(["app1"]);
    });

    it("dedupes appId inputs and returns empty for empty input", () => {
      createAppKeywords("app1", ["dup"], "US");
      const deduped = listUnionKeywords(["app1", "app1", "", "  "], "US");
      expect(deduped).toHaveLength(1);
      expect(deduped[0].trackedByAppIds).toEqual(["app1"]);
      expect(listUnionKeywords([], "US")).toEqual([]);
    });
  });

  describe("getCompareMatrix", () => {
    it("computes rank for apps even when they do not track the keyword", () => {
      createAppKeywords("app1", ["halal"], "US");
      seedResearchedKeyword("US", "halal", ["app1", "app2"], {
        popularity: 70,
      });
      const rows = getCompareMatrix(["app1", "app2"], ["halal"], "US");
      const byApp = new Map(rows.map((r) => [r.appId, r]));
      expect(byApp.get("app1")?.currentPosition).toBe(1);
      expect(byApp.get("app1")?.isTracked).toBe(true);
      expect(byApp.get("app2")?.currentPosition).toBe(2);
      expect(byApp.get("app2")?.isTracked).toBe(false);
      expect(byApp.get("app1")?.isResearched).toBe(true);
    });

    it("returns null currentPosition when app is outside top 200 / not in ordered list", () => {
      createAppKeywords("app1", ["kw"], "US");
      seedResearchedKeyword("US", "kw", ["appX"], { popularity: 10 });
      const rows = getCompareMatrix(["app1"], ["kw"], "US");
      expect(rows[0].currentPosition).toBeNull();
      expect(rows[0].isResearched).toBe(true);
    });

    it("marks not_researched when aso_keywords has no row", () => {
      createAppKeywords("app1", ["pending"], "US");
      const rows = getCompareMatrix(["app1"], ["pending"], "US");
      expect(rows[0].isResearched).toBe(false);
      expect(rows[0].currentPosition).toBeNull();
      expect(rows[0].isTracked).toBe(true);
    });

    it("includes previous_position when app tracks the keyword", () => {
      createAppKeywords("app1", ["rankkw"], "US");
      setPreviousPosition("rankkw", "US", "app1", 12);
      seedResearchedKeyword("US", "rankkw", ["otherApp", "app1"], {
        popularity: 50,
      });
      const rows = getCompareMatrix(["app1"], ["rankkw"], "US");
      expect(rows[0].previousPosition).toBe(12);
      expect(rows[0].currentPosition).toBe(2);
    });

    it("normalizes keyword input and dedupes", () => {
      createAppKeywords("app1", ["clean"], "US");
      seedResearchedKeyword("US", "clean", ["app1"], { popularity: 42 });
      const rows = getCompareMatrix(
        ["app1", "app1"],
        ["  CLEAN  ", "Clean", "clean"],
        "US"
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].appId).toBe("app1");
      expect(rows[0].normalizedKeyword).toBe("clean");
      expect(rows[0].currentPosition).toBe(1);
    });

    it("returns empty array for empty input", () => {
      expect(getCompareMatrix([], ["kw"], "US")).toEqual([]);
      expect(getCompareMatrix(["app1"], [], "US")).toEqual([]);
    });

    it("handles empty ordered_app_ids gracefully", () => {
      createAppKeywords("app1", ["empty"], "US");
      seedResearchedKeyword("US", "empty", [], { popularity: 5 });
      const rows = getCompareMatrix(["app1"], ["empty"], "US");
      expect(rows[0].currentPosition).toBeNull();
      expect(rows[0].isResearched).toBe(true);
    });
  });
});
