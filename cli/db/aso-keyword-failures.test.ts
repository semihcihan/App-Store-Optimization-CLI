import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createAppKeyword } from "./app-keywords";
import {
  deleteKeywordFailures,
  getKeywordFailures,
  listKeywordFailures,
  listKeywordFailuresForApp,
  upsertKeywordFailures,
} from "./aso-keyword-failures";
import { closeDbForTests } from "./store";

const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `aso-keyword-failures-${process.pid}-${Date.now()}.sqlite`
);

function cleanDbFiles(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

describe("aso-keyword-failures", () => {
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

  it("upserts/list/deletes failures and resolves by app", () => {
    createAppKeyword("app-1", "alpha", "US");
    createAppKeyword("app-1", "beta", "US");

    upsertKeywordFailures("US", [
      {
        keyword: "alpha",
        stage: "popularity",
        reasonCode: "UPSTREAM_ERROR",
        message: "failed alpha",
        statusCode: 500,
        retryable: true,
        attempts: 3,
        requestId: "req-a",
      },
      {
        keyword: "beta",
        stage: "enrichment",
        reasonCode: "ENRICHMENT_FAILED",
        message: "failed beta",
        statusCode: 504,
        retryable: true,
        attempts: 2,
        requestId: "req-b",
      },
    ]);

    expect(listKeywordFailures("US")).toHaveLength(2);
    expect(getKeywordFailures("US", ["alpha"])).toHaveLength(1);
    expect(listKeywordFailuresForApp("app-1", "US").map((row) => row.keyword)).toEqual([
      "alpha",
      "beta",
    ]);

    const deleted = deleteKeywordFailures("US", ["alpha"]);
    expect(deleted).toBe(1);
    expect(listKeywordFailures("US").map((row) => row.keyword)).toEqual(["beta"]);
  });
});
