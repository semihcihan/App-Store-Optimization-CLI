import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  getCompetitorAppDocs,
  upsertCompetitorAppDocs,
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

  it("stores and reads competitor app docs", () => {
    upsertCompetitorAppDocs("US", [
      {
        appId: "comp1",
        name: "Competitor App",
        averageUserRating: 4.7,
        userRatingCount: 500,
        additionalLocalizations: {
          "es-MX": {
            name: "App Competidora",
            subtitle: "Subtitulo",
          },
        },
      },
    ]);
    const docs = getCompetitorAppDocs("US", ["comp1"]);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toEqual(
      expect.objectContaining({
        appId: "comp1",
        name: "Competitor App",
        country: "US",
        averageUserRating: 4.7,
        userRatingCount: 500,
        additionalLocalizations: {
          "es-MX": {
            name: "App Competidora",
            subtitle: "Subtitulo",
          },
        },
      })
    );
  });

  it("keeps docs isolated for same app id across countries", () => {
    upsertCompetitorAppDocs("US", [
      {
        appId: "same-country-id",
        name: "US App",
        averageUserRating: 4,
        userRatingCount: 100,
      },
    ]);
    upsertCompetitorAppDocs("GB", [
      {
        appId: "same-country-id",
        name: "GB App",
        averageUserRating: 3,
        userRatingCount: 20,
      },
    ]);

    expect(getCompetitorAppDocs("US", ["same-country-id"])[0]).toEqual(
      expect.objectContaining({
        name: "US App",
        country: "US",
        averageUserRating: 4,
      })
    );
    expect(getCompetitorAppDocs("GB", ["same-country-id"])[0]).toEqual(
      expect.objectContaining({
        name: "GB App",
        country: "GB",
        averageUserRating: 3,
      })
    );
  });

  it("upserts existing doc for same country and app id", () => {
    upsertCompetitorAppDocs("US", [
      {
        appId: "same-id",
        name: "Initial",
        averageUserRating: 4,
        userRatingCount: 10,
        additionalLocalizations: {
          "fr-FR": {
            name: "Initiale",
          },
        },
      },
    ]);

    upsertCompetitorAppDocs("US", [
      {
        appId: "same-id",
        name: "Updated",
        averageUserRating: 4.5,
        userRatingCount: 40,
        releaseDate: "2026-01-01",
      },
    ]);

    expect(getCompetitorAppDocs("US", ["same-id"])[0]).toEqual(
      expect.objectContaining({
        name: "Updated",
        averageUserRating: 4.5,
        userRatingCount: 40,
        releaseDate: "2026-01-01",
        additionalLocalizations: {
          "fr-FR": {
            name: "Initiale",
          },
        },
      })
    );
  });
});
