import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Database from "better-sqlite3";
import {
  listByApp,
  listAllAppKeywords,
  createAppKeyword,
  createAppKeywords,
  setPreviousPosition,
  getAssociationsForKeyword,
  deleteAppKeywords,
  getAppLastKeywordAddedAtMap,
  setAppKeywordFavorite,
  setAppKeywordNotes,
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
    expect(rows[0].isFavorite).toBe(false);
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
    expect(rows.every((row) => row.isFavorite === false)).toBe(true);
  });

  it("sets keyword favorite per app association", () => {
    createAppKeyword("app1", "shared", "US");
    createAppKeyword("app2", "shared", "US");
    const updated = setAppKeywordFavorite("app1", "shared", true, "US");
    expect(updated).toBe(true);

    const app1 = listByApp("app1", "US");
    const app2 = listByApp("app2", "US");
    expect(app1[0]?.isFavorite).toBe(true);
    expect(app2[0]?.isFavorite).toBe(false);
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

  it("persists free text notes per app, keyword, and country across restarts and re-association", () => {
    for (const appId of ["app1", "app2", "research", "research:ideas"]) {
      createAppKeyword(appId, "shared", "US");
    }
    createAppKeyword("app1", "shared", "GB");
    const notes = "  Try this idea 📝\nKeep punctuation, spacing & <text>.  ";
    expect(setAppKeywordNotes("app1", " SHARED ", notes, "US")).toBe(true);
    expect(setAppKeywordNotes("research:ideas", "shared", "Research note", "US")).toBe(true);
    createAppKeywords("app1", ["shared"], "US");
    closeDbForTests();
    expect(listByApp("app1", "US")[0].notes).toBe(notes);
    expect(listByApp("app1", "GB")[0].notes).toBe("");
    expect(listByApp("app2", "US")[0].notes).toBe("");
    expect(listByApp("research", "US")[0].notes).toBe("");
    expect(listAllAppKeywords("US").find((row) => row.appId === "research:ideas")?.notes).toBe("Research note");
    expect(getAssociationsForKeyword("shared").find((row) => row.appId === "app1")?.notes).toBe(notes);
    expect(setAppKeywordNotes("app1", "shared", "", "US")).toBe(true);
    expect(listByApp("app1", "US")[0].notes).toBe("");
    expect(setAppKeywordNotes("missing", "shared", "note", "US")).toBe(false);
  });

  it("migrates existing app-keyword associations without losing their state", () => {
    const legacyDb = new Database(TEST_DB_PATH);
    legacyDb.exec(`
      CREATE TABLE app_keywords (
        app_id TEXT NOT NULL, keyword TEXT NOT NULL, country TEXT NOT NULL,
        is_favorite INTEGER NOT NULL DEFAULT 0, previous_position INTEGER, added_at TEXT,
        PRIMARY KEY (app_id, keyword, country)
      );
      INSERT INTO app_keywords VALUES ('app1', 'legacy', 'US', 1, 8, '2026-01-01');
    `);
    legacyDb.close();
    expect(listByApp("app1")[0]).toMatchObject({
      keyword: "legacy", isFavorite: true, previousPosition: 8, addedAt: "2026-01-01", notes: "",
    });
    expect(setAppKeywordNotes("app1", "legacy", "Migrated note")).toBe(true);
    closeDbForTests();
    expect(listByApp("app1")[0].notes).toBe("Migrated note");
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
