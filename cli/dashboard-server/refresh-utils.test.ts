import {
  chunkArray,
  getMissingOrExpiredAppIds,
  isFreshAsoAppDoc,
} from "./refresh-utils";

describe("refresh-utils", () => {
  it("chunks arrays with stable ordering", () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([
      [1, 2],
      [3, 4],
      [5],
    ]);
  });

  it("treats invalid chunk size as 1", () => {
    expect(chunkArray([1, 2], 0)).toEqual([[1], [2]]);
  });

  it("detects fresh and stale app docs by expiresAt and date completeness", () => {
    const now = Date.parse("2026-03-07T00:00:00.000Z");
    expect(
      isFreshAsoAppDoc(
        {
          expiresAt: "2026-03-08T00:00:00.000Z",
          releaseDate: "2024-01-01",
          currentVersionReleaseDate: "2026-01-01",
        },
        now
      )
    ).toBe(true);
    expect(
      isFreshAsoAppDoc(
        {
          expiresAt: "2026-03-06T00:00:00.000Z",
          releaseDate: "2024-01-01",
          currentVersionReleaseDate: "2026-01-01",
        },
        now
      )
    ).toBe(false);
    expect(
      isFreshAsoAppDoc(
        {
          expiresAt: "2026-03-08T00:00:00.000Z",
          releaseDate: "2024-01-01",
        },
        now
      )
    ).toBe(false);
    expect(isFreshAsoAppDoc({}, now)).toBe(false);
  });

  it("returns missing and expired app ids in request order", () => {
    const now = Date.parse("2026-03-07T00:00:00.000Z");
    const missing = getMissingOrExpiredAppIds(
      ["a", "b", "c", "d"],
      [
        {
          appId: "a",
          expiresAt: "2026-03-08T00:00:00.000Z",
          releaseDate: "2024-01-01",
          currentVersionReleaseDate: "2026-01-01",
        },
        {
          appId: "b",
          expiresAt: "2026-03-06T00:00:00.000Z",
          releaseDate: "2024-01-01",
          currentVersionReleaseDate: "2026-01-01",
        },
        {
          appId: "c",
          expiresAt: "2026-03-08T00:00:00.000Z",
          releaseDate: "2024-01-01",
          currentVersionReleaseDate: null,
        },
      ],
      now
    );
    expect(missing).toEqual(["b", "c", "d"]);
  });
});
