import {
  assertSupportedCountry,
  normalizeCountry,
} from "./policy";

describe("keyword policy", () => {
  it("normalizes country codes", () => {
    expect(normalizeCountry(" dk ")).toBe("DK");
    expect(normalizeCountry(undefined)).toBe("US");
  });

  it("accepts configured non-US storefronts", () => {
    expect(() => assertSupportedCountry("DK")).not.toThrow();
    expect(() => assertSupportedCountry("tr")).not.toThrow();
  });

  it("rejects unknown storefronts", () => {
    expect(() => assertSupportedCountry("XX")).toThrow(
      'Unsupported country code "XX"'
    );
  });
});
