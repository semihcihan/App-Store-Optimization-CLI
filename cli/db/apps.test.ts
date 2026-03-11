import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getAppById, listApps, upsertApps } from "./apps";
import { closeDbForTests } from "./store";

const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `aso-apps-${process.pid}-${Date.now()}.sqlite`
);

function cleanDbFiles(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

describe("apps db", () => {
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

  it("upserts by id without duplicates", () => {
    upsertApps([{ id: "123", name: "First" }]);
    upsertApps([{ id: "123", name: "Second" }]);
    const rows = listApps();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ id: "123", name: "Second" });
  });

  it("returns app by id", () => {
    upsertApps([{ id: "research:ideas", name: "Ideas" }]);
    expect(getAppById("research:ideas")).toEqual({
      id: "research:ideas",
      name: "Ideas",
    });
    expect(getAppById("missing")).toBeNull();
  });
});
