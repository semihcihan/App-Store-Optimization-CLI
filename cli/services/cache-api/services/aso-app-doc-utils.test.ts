import { normalizeCountryOnAppDocs } from "./aso-app-doc-utils";
import type { AsoAppDoc } from "./aso-types";

describe("aso-app-doc-utils", () => {
  it("normalizes country on every app doc", () => {
    const docs: AsoAppDoc[] = [
      {
        appId: "123",
        country: "tr",
        name: "App",
        averageUserRating: 4.5,
        userRatingCount: 10,
        releaseDate: "2024-01-01",
        currentVersionReleaseDate: "2024-02-01",
      },
    ];

    const result = normalizeCountryOnAppDocs("us", docs);

    expect(result[0]?.country).toBe("US");
    expect(result[0]?.appId).toBe("123");
  });
});
