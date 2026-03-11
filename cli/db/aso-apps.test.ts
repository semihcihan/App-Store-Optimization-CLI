import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  getCompetitorAppDocs,
  getOwnedAppDocs,
  upsertCompetitorAppDocs,
  upsertOwnedAppDocs,
} from "./aso-apps";
import { closeDbForTests } from "./store";

const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `aso-aso-apps-${process.pid}-${Date.now()}.sqlite`
);

function cleanDbFiles(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

describe("aso-apps", () => {
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

  it("stores and reads owned app docs", () => {
    upsertOwnedAppDocs("US", [
      {
        appId: "owned1",
        name: "Owned App",
        subtitle: "Sub",
        averageUserRating: 4.1,
        userRatingCount: 55,
        icon: { color: "blue" },
      },
    ]);
    const docs = getOwnedAppDocs("US", ["owned1"]);
    expect(docs).toHaveLength(1);
    expect(docs[0].name).toBe("Owned App");
    expect(docs[0].country).toBe("US");
    expect(docs[0].icon).toEqual({ color: "blue" });
  });

  it("stores and reads competitor app docs", () => {
    upsertCompetitorAppDocs("US", [
      {
        appId: "comp1",
        name: "Competitor App",
        averageUserRating: 4.7,
        userRatingCount: 500,
      },
    ]);
    const docs = getCompetitorAppDocs("US", ["comp1"]);
    expect(docs).toHaveLength(1);
    expect(docs[0].name).toBe("Competitor App");
    expect(docs[0].country).toBe("US");
  });

  it("keeps owned and competitor buckets isolated for same app id", () => {
    upsertOwnedAppDocs("US", [
      {
        appId: "same-id",
        name: "Owned",
        averageUserRating: 4,
        userRatingCount: 1,
      },
    ]);
    upsertCompetitorAppDocs("US", [
      {
        appId: "same-id",
        name: "Competitor",
        averageUserRating: 5,
        userRatingCount: 2,
      },
    ]);
    expect(getOwnedAppDocs("US", ["same-id"])[0].name).toBe("Owned");
    expect(getCompetitorAppDocs("US", ["same-id"])[0].name).toBe("Competitor");
  });

  it("keeps docs isolated for same app id across countries", () => {
    upsertOwnedAppDocs("US", [
      {
        appId: "same-country-id",
        name: "US App",
        averageUserRating: 4,
        userRatingCount: 100,
      },
    ]);
    upsertOwnedAppDocs("GB", [
      {
        appId: "same-country-id",
        name: "GB App",
        averageUserRating: 3,
        userRatingCount: 20,
      },
    ]);

    expect(getOwnedAppDocs("US", ["same-country-id"])[0]).toEqual(
      expect.objectContaining({
        name: "US App",
        country: "US",
        averageUserRating: 4,
      })
    );
    expect(getOwnedAppDocs("GB", ["same-country-id"])[0]).toEqual(
      expect.objectContaining({
        name: "GB App",
        country: "GB",
        averageUserRating: 3,
      })
    );
  });

  it("tracks previous owned ratings per country", () => {
    upsertOwnedAppDocs("US", [
      {
        appId: "snapshot-id",
        name: "Snapshot",
        averageUserRating: 4,
        userRatingCount: 100,
      },
    ]);
    upsertOwnedAppDocs("US", [
      {
        appId: "snapshot-id",
        name: "Snapshot",
        averageUserRating: 4.5,
        userRatingCount: 200,
      },
    ]);
    upsertOwnedAppDocs("GB", [
      {
        appId: "snapshot-id",
        name: "Snapshot GB",
        averageUserRating: 3.2,
        userRatingCount: 50,
      },
    ]);

    const usDoc = getOwnedAppDocs("US", ["snapshot-id"])[0];
    const gbDoc = getOwnedAppDocs("GB", ["snapshot-id"])[0];
    expect(usDoc).toEqual(
      expect.objectContaining({
        averageUserRating: 4.5,
        userRatingCount: 200,
        previousAverageUserRating: 4,
        previousUserRatingCount: 100,
      })
    );
    expect(gbDoc).toEqual(
      expect.objectContaining({
        averageUserRating: 3.2,
        userRatingCount: 50,
        previousAverageUserRating: null,
        previousUserRatingCount: null,
      })
    );
  });
});
