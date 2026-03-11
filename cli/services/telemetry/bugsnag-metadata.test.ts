import { getErrorBugsnagMetadata, withBugsnagMetadata } from "./bugsnag-metadata";

describe("bugsnag-metadata", () => {
  it("stores metadata as non-enumerable and merges values", () => {
    const error = new Error("boom");
    withBugsnagMetadata(error, { a: 1 });
    withBugsnagMetadata(error, { b: 2 });

    expect(getErrorBugsnagMetadata(error)).toEqual({ a: 1, b: 2 });
    expect(Object.keys(error)).toEqual([]);
  });
});
