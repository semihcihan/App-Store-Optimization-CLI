import {
  computeAppExpiryIsoForApp,
  computeOrderExpiryIso,
  computePopularityExpiryIso,
  getAppTtlHours,
  getOrderTtlHours,
  getPopularityTtlHours,
  normalizeKeyword,
  normalizeTextForKeywordMatch,
  sanitizeKeywords,
} from "./aso-keyword-utils";

describe("aso-keyword-utils", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("normalizes keyword/text and sanitizes keyword list", () => {
    expect(normalizeKeyword("  HeLLo ")).toBe("hello");
    expect(normalizeTextForKeywordMatch("  Best, Game!!!\nNow ")).toBe(
      "best game now"
    );
    expect(sanitizeKeywords([" Foo ", "foo", "", "  ", "Bar"])).toEqual([
      "foo",
      "bar",
    ]);
  });

  it("uses fallback order ttl when env is missing or invalid", () => {
    delete process.env.ASO_KEYWORD_ORDER_TTL_HOURS;
    expect(getOrderTtlHours()).toBe(24);

    process.env.ASO_KEYWORD_ORDER_TTL_HOURS = "0";
    expect(getOrderTtlHours()).toBe(24);

    process.env.ASO_KEYWORD_ORDER_TTL_HOURS = "abc";
    expect(getOrderTtlHours()).toBe(24);
  });

  it("computes order expiry with configured ttl", () => {
    process.env.ASO_KEYWORD_ORDER_TTL_HOURS = "2";
    const now = new Date("2026-01-01T00:00:00.000Z");

    expect(computeOrderExpiryIso(now)).toBe("2026-01-01T02:00:00.000Z");
  });

  it("computes popularity expiry with configured ttl", () => {
    process.env.ASO_POPULARITY_CACHE_TTL_HOURS = "720";
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(computePopularityExpiryIso(now)).toBe("2026-01-31T00:00:00.000Z");

    delete process.env.ASO_POPULARITY_CACHE_TTL_HOURS;
    expect(getPopularityTtlHours()).toBe(720);
  });

  it("supports app ttl zero and falls back for invalid app ttl", () => {
    process.env.ASO_APP_CACHE_TTL_HOURS = "0";
    expect(getAppTtlHours()).toBe(0);
    expect(computeAppExpiryIsoForApp(new Date("2026-01-01T00:00:00.000Z"))).toBe(
      "1970-01-01T00:00:00.000Z"
    );

    process.env.ASO_APP_CACHE_TTL_HOURS = "-1";
    expect(getAppTtlHours()).toBe(168);
  });
});
