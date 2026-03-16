import { ASO_DEFAULTS, readAsoEnv } from "./aso-env";

describe("aso-env", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("uses centralized defaults when env is missing", () => {
    delete process.env.ASO_KEYWORD_ORDER_TTL_HOURS;
    delete process.env.ASO_APP_CACHE_TTL_HOURS;
    delete process.env.ASO_OWNED_APP_DOC_REFRESH_MAX_AGE_HOURS;

    const env = readAsoEnv();
    expect(env.keywordOrderTtlHours).toBe(ASO_DEFAULTS.keywordOrderTtlHours);
    expect(env.appCacheTtlHours).toBe(ASO_DEFAULTS.appCacheTtlHours);
    expect(env.ownedAppDocRefreshMaxAgeMs).toBe(
      ASO_DEFAULTS.ownedAppDocRefreshMaxAgeHours * 60 * 60 * 1000
    );
  });

  it("parses owned app refresh max age hours and falls back for invalid values", () => {
    process.env.ASO_OWNED_APP_DOC_REFRESH_MAX_AGE_HOURS = "1";
    expect(readAsoEnv().ownedAppDocRefreshMaxAgeMs).toBe(60 * 60 * 1000);

    process.env.ASO_OWNED_APP_DOC_REFRESH_MAX_AGE_HOURS = "0";
    expect(readAsoEnv().ownedAppDocRefreshMaxAgeMs).toBe(
      ASO_DEFAULTS.ownedAppDocRefreshMaxAgeHours * 60 * 60 * 1000
    );

    process.env.ASO_OWNED_APP_DOC_REFRESH_MAX_AGE_HOURS = "abc";
    expect(readAsoEnv().ownedAppDocRefreshMaxAgeMs).toBe(
      ASO_DEFAULTS.ownedAppDocRefreshMaxAgeHours * 60 * 60 * 1000
    );
  });
});
