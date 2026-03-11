import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getMetadataValue, setMetadataValue } from "./metadata";
import { closeDbForTests } from "./store";

const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `aso-metadata-${process.pid}-${Date.now()}.sqlite`
);

function cleanDbFiles(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

describe("metadata", () => {
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

  it("returns null for missing keys", () => {
    expect(getMetadataValue("missing")).toBeNull();
  });

  it("stores and updates metadata values", () => {
    setMetadataValue("apps-last-refreshed-at", "2026-01-01T00:00:00.000Z");
    expect(getMetadataValue("apps-last-refreshed-at")).toBe(
      "2026-01-01T00:00:00.000Z"
    );

    setMetadataValue("apps-last-refreshed-at", "2026-01-08T00:00:00.000Z");
    expect(getMetadataValue("apps-last-refreshed-at")).toBe(
      "2026-01-08T00:00:00.000Z"
    );
  });
});
