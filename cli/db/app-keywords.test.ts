import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  listByApp,
  listAllAppKeywords,
  createAppKeyword,
  createAppKeywords,
  setPreviousPosition,
  getAssociationsForKeyword,
  deleteAppKeywords,
  getAppLastKeywordAddedAtMap,
} from "./app-keywords";
import { closeDbForTests } from "./store";

const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `aso-app-keywords-${process.pid}-${Date.now()}.sqlite`
);

function cleanDbFiles(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

describe("app-keywords", () => {
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

  it("creates and lists keywords for app with normalization", () => {
    createAppKeyword("app1", "  MixedCase  ", "US");
    const rows = listByApp("app1", "US");
    expect(rows).toHaveLength(1);
    expect(rows[0].keyword).toBe("mixedcase");
    expect(rows[0].previousPosition).toBeNull();
  });

  it("does not duplicate same keyword for same app and country", () => {
    createAppKeyword("app1", "dup", "US");
    createAppKeyword("app1", "  DUP  ", "US");
    expect(listByApp("app1", "US")).toHaveLength(1);
  });

  it("creates multiple keywords and filters by country", () => {
    createAppKeywords("app1", ["one", "two"], "US");
    createAppKeywords("app1", ["gb"], "GB");
    expect(listByApp("app1", "US").map((r) => r.keyword).sort()).toEqual([
      "one",
      "two",
    ]);
    expect(listAllAppKeywords("GB").map((r) => r.keyword)).toEqual(["gb"]);
  });

  it("updates previousPosition by app/country/keyword", () => {
    createAppKeyword("app1", "rank", "US");
    setPreviousPosition("  RANK ", "US", "app1", 5);
    const rows = listByApp("app1", "US");
    expect(rows[0].previousPosition).toBe(5);
  });

  it("returns associations for keyword", () => {
    createAppKeyword("app1", "shared", "US");
    createAppKeyword("app2", "shared", "US");
    createAppKeyword("app3", "shared", "GB");
    const rows = getAssociationsForKeyword(" SHARED ", "US");
    expect(rows.map((r) => r.appId).sort()).toEqual(["app1", "app2"]);
  });

  it("deletes app-keyword associations for matching app/country", () => {
    createAppKeywords("app1", ["foo", "bar"], "US");
    createAppKeyword("app2", "foo", "US");
    const removed = deleteAppKeywords("app1", ["foo"], "US");
    expect(removed).toBe(1);
    const app1Rows = listByApp("app1", "US").map((r) => r.keyword);
    expect(app1Rows).toEqual(["bar"]);
    expect(listByApp("app2", "US")).toHaveLength(1);
  });

  it("returns latest addedAt per app", () => {
    createAppKeyword("app1", "a", "US");
    createAppKeyword("app1", "b", "US");
    createAppKeyword("app2", "x", "US");
    const map = getAppLastKeywordAddedAtMap("US");
    expect(map.has("app1")).toBe(true);
    expect(map.has("app2")).toBe(true);
    expect(Number.isNaN(Date.parse(map.get("app1") ?? ""))).toBe(false);
    expect(Number.isNaN(Date.parse(map.get("app2") ?? ""))).toBe(false);
  });
});
