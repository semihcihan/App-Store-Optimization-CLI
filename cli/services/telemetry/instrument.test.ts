describe("telemetry instrument", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalBugsnagApiKey = process.env.BUGSNAG_API_KEY;

  beforeEach(() => {
    delete process.env.BUGSNAG_API_KEY;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalBugsnagApiKey === undefined) {
      delete process.env.BUGSNAG_API_KEY;
    } else {
      process.env.BUGSNAG_API_KEY = originalBugsnagApiKey;
    }
    jest.resetModules();
    jest.clearAllMocks();
  });

  it("initializes bugsnag in development mode", async () => {
    process.env.NODE_ENV = "development";
    const initializeBugsnag = jest.fn();
    jest.doMock("../../shared/telemetry/bugsnag-shared", () => ({ initializeBugsnag }));

    await import("./instrument");

    const { version } = require("../../../package.json");
    expect(initializeBugsnag).toHaveBeenCalledWith({
      isDevelopment: true,
      appVersion: version,
    });
  });

  it("initializes bugsnag in production mode", async () => {
    process.env.NODE_ENV = "production";
    const initializeBugsnag = jest.fn();
    jest.doMock("../../shared/telemetry/bugsnag-shared", () => ({ initializeBugsnag }));

    await import("./instrument");

    const { version } = require("../../../package.json");
    expect(initializeBugsnag).toHaveBeenCalledWith({
      isDevelopment: false,
      appVersion: version,
    });
  });
});
