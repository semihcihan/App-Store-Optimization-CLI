import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  getOwnedAppById,
  listOwnedAppIdsByKind,
  listOwnedApps,
  upsertOwnedApps,
  upsertOwnedAppSnapshots,
} from "./owned-apps";
import { closeDbForTests } from "./store";

const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `aso-owned-apps-${process.pid}-${Date.now()}.sqlite`
);

function cleanDbFiles(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

describe("owned-apps", () => {
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

  it("upserts and reads kind-aware owned apps", () => {
    upsertOwnedApps([
      { id: "123", kind: "owned", name: "App 123" },
      { id: "research:ideas", kind: "research", name: "Ideas" },
    ]);

    expect(listOwnedApps().map((row) => ({ id: row.id, kind: row.kind }))).toEqual(
      expect.arrayContaining([
        { id: "123", kind: "owned" },
        { id: "research:ideas", kind: "research" },
      ])
    );
    expect(listOwnedAppIdsByKind("owned")).toEqual(["123"]);
    expect(listOwnedAppIdsByKind("research")).toEqual(["research:ideas"]);
  });

  it("tracks previous rating/count and fetched timestamps on snapshot updates", () => {
    upsertOwnedApps([{ id: "123", kind: "owned", name: "App 123" }]);

    upsertOwnedAppSnapshots([
      {
        id: "123",
        name: "App 123",
        averageUserRating: 4.2,
        userRatingCount: 100,
        fetchedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    upsertOwnedAppSnapshots([
      {
        id: "123",
        name: "App 123",
        averageUserRating: 4.5,
        userRatingCount: 180,
        fetchedAt: "2026-01-02T00:00:00.000Z",
      },
    ]);

    expect(getOwnedAppById("123")).toEqual(
      expect.objectContaining({
        averageUserRating: 4.5,
        userRatingCount: 180,
        previousAverageUserRating: 4.2,
        previousUserRatingCount: 100,
        lastFetchedAt: "2026-01-02T00:00:00.000Z",
        previousFetchedAt: "2026-01-01T00:00:00.000Z",
      })
    );
  });
});
