import * as path from "path";
import { ASO_DEFAULTS, ASO_ENV } from "./aso-env";

describe("aso-env", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("uses centralized defaults when env is missing", () => {
    delete process.env.ASO_DB_PATH;
    delete process.env.ASO_PRIMARY_APP_ID;
    delete process.env.ASO_AUTH_MODE;
    delete process.env.ASO_APPLE_WIDGET_KEY;
    delete process.env.ASO_SIRP_RUBY_ORACLE;
    delete process.env.ASO_SIRP_USE_RUBY_PROOF;
    delete process.env.ASO_KEYWORD_ORDER_TTL_HOURS;
    delete process.env.ASO_APP_CACHE_TTL_HOURS;
    delete process.env.ASO_OWNED_APP_DOC_REFRESH_MAX_AGE_HOURS;

    expect(ASO_ENV.dbPath).toBe(ASO_DEFAULTS.dbPath);
    expect(ASO_ENV.primaryAppId).toBeNull();
    expect(ASO_ENV.authMode).toBe("auto");
    expect(ASO_ENV.appleWidgetKey).toBeNull();
    expect(ASO_ENV.sirpRubyOracle).toBe(false);
    expect(ASO_ENV.sirpUseRubyProof).toBe(false);
    expect(ASO_ENV.keywordOrderTtlHours).toBe(ASO_DEFAULTS.keywordOrderTtlHours);
    expect(ASO_ENV.appCacheTtlHours).toBe(ASO_DEFAULTS.appCacheTtlHours);
    expect(ASO_ENV.ownedAppDocRefreshMaxAgeMs).toBe(
      ASO_DEFAULTS.ownedAppDocRefreshMaxAgeHours * 60 * 60 * 1000
    );
  });

  it("parses optional ASO runtime env settings", () => {
    process.env.ASO_DB_PATH = " ./tmp/aso.sqlite ";
    process.env.ASO_PRIMARY_APP_ID = " 123456789 ";
    process.env.ASO_AUTH_MODE = "sirp";
    process.env.ASO_APPLE_WIDGET_KEY = " widget-key ";
    process.env.ASO_SIRP_RUBY_ORACLE = "1";
    process.env.ASO_SIRP_USE_RUBY_PROOF = "1";

    expect(ASO_ENV.dbPath).toBe(path.resolve("./tmp/aso.sqlite"));
    expect(ASO_ENV.primaryAppId).toBe("123456789");
    expect(ASO_ENV.authMode).toBe("sirp");
    expect(ASO_ENV.appleWidgetKey).toBe("widget-key");
    expect(ASO_ENV.sirpRubyOracle).toBe(true);
    expect(ASO_ENV.sirpUseRubyProof).toBe(true);
  });

  it("falls back for invalid auth mode", () => {
    process.env.ASO_AUTH_MODE = "invalid";
    expect(ASO_ENV.authMode).toBe("auto");
  });

  it("parses owned app refresh max age hours and falls back for invalid values", () => {
    process.env.ASO_OWNED_APP_DOC_REFRESH_MAX_AGE_HOURS = "1";
    expect(ASO_ENV.ownedAppDocRefreshMaxAgeMs).toBe(60 * 60 * 1000);

    process.env.ASO_OWNED_APP_DOC_REFRESH_MAX_AGE_HOURS = "0";
    expect(ASO_ENV.ownedAppDocRefreshMaxAgeMs).toBe(
      ASO_DEFAULTS.ownedAppDocRefreshMaxAgeHours * 60 * 60 * 1000
    );

    process.env.ASO_OWNED_APP_DOC_REFRESH_MAX_AGE_HOURS = "abc";
    expect(ASO_ENV.ownedAppDocRefreshMaxAgeMs).toBe(
      ASO_DEFAULTS.ownedAppDocRefreshMaxAgeHours * 60 * 60 * 1000
    );
  });
});
