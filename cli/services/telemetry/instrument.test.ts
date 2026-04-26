describe("telemetry instrument", () => {
  const defaultPosthogApiKey = "phc_CjK5coJt6fxtXseg8XgkU8dMfXPur3JgabQh5454opmQ";
  const originalNodeEnv = process.env.NODE_ENV;
  const originalBugsnagApiKey = process.env.BUGSNAG_API_KEY;
  const originalPosthogApiKey = process.env.ASO_POSTHOG_API_KEY;
  const originalPosthogHost = process.env.ASO_POSTHOG_HOST;

  beforeEach(() => {
    delete process.env.BUGSNAG_API_KEY;
    delete process.env.ASO_POSTHOG_API_KEY;
    delete process.env.ASO_POSTHOG_HOST;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalBugsnagApiKey === undefined) {
      delete process.env.BUGSNAG_API_KEY;
    } else {
      process.env.BUGSNAG_API_KEY = originalBugsnagApiKey;
    }
    if (originalPosthogApiKey === undefined) {
      delete process.env.ASO_POSTHOG_API_KEY;
    } else {
      process.env.ASO_POSTHOG_API_KEY = originalPosthogApiKey;
    }
    if (originalPosthogHost === undefined) {
      delete process.env.ASO_POSTHOG_HOST;
    } else {
      process.env.ASO_POSTHOG_HOST = originalPosthogHost;
    }
    jest.resetModules();
    jest.clearAllMocks();
  });

  it("initializes bugsnag in development mode", async () => {
    process.env.NODE_ENV = "development";
    const initializeBugsnag = jest.fn();
    const initializePostHog = jest.fn();
    jest.doMock("../../shared/telemetry/bugsnag-shared", () => ({ initializeBugsnag }));
    jest.doMock("../../shared/telemetry/posthog-shared", () => ({ initializePostHog }));

    await import("./instrument");

    const { version } = require("../../../package.json");
    expect(initializeBugsnag).toHaveBeenCalledWith({
      isDevelopment: true,
      appVersion: version,
    });
    expect(initializePostHog).toHaveBeenCalledWith({
      isDevelopment: true,
      apiKey: defaultPosthogApiKey,
    });
  });

  it("initializes bugsnag in production mode", async () => {
    process.env.NODE_ENV = "production";
    const initializeBugsnag = jest.fn();
    const initializePostHog = jest.fn();
    jest.doMock("../../shared/telemetry/bugsnag-shared", () => ({ initializeBugsnag }));
    jest.doMock("../../shared/telemetry/posthog-shared", () => ({ initializePostHog }));

    await import("./instrument");

    const { version } = require("../../../package.json");
    expect(initializeBugsnag).toHaveBeenCalledWith({
      isDevelopment: false,
      appVersion: version,
    });
    expect(initializePostHog).toHaveBeenCalledWith({
      isDevelopment: false,
      apiKey: defaultPosthogApiKey,
    });
  });

  it("passes posthog env overrides into telemetry startup", async () => {
    process.env.NODE_ENV = "production";
    process.env.ASO_POSTHOG_API_KEY = "phc_test_key";
    process.env.ASO_POSTHOG_HOST = "https://eu.i.posthog.com";

    const initializeBugsnag = jest.fn();
    const initializePostHog = jest.fn();
    jest.doMock("../../shared/telemetry/bugsnag-shared", () => ({ initializeBugsnag }));
    jest.doMock("../../shared/telemetry/posthog-shared", () => ({ initializePostHog }));

    await import("./instrument");

    expect(initializePostHog).toHaveBeenCalledWith({
      isDevelopment: false,
      apiKey: "phc_test_key",
      host: "https://eu.i.posthog.com",
    });
  });
});
