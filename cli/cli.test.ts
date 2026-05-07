describe("cli stdout failure handling", () => {
  const originalArgv = process.argv.slice();
  const originalExitCode = process.exitCode;

  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
    process.argv = originalArgv.slice();
    process.exitCode = originalExitCode;
  });

  it("emits a single runtime envelope for stdout handler failures", async () => {
    const writeSpy = jest
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true as any);

    process.argv = [
      "node",
      "cli.ts",
      "keywords",
      "term",
      "--stdout",
    ];

    jest.doMock("./load-env", () => ({}));
    jest.doMock("./services/telemetry/instrument", () => ({}));
    jest.doMock("./commands/aso", () => ({ __esModule: true, default: {} }));
    jest.doMock("./services/runtime/version-check-service", () => ({
      checkVersionUpdateSync: jest.fn(),
    }));
    jest.doMock("./services/telemetry/error-reporter", () => ({
      reportBugsnagError: jest.fn(),
    }));
    jest.doMock("./services/runtime/node-version-guard", () => ({
      assertSupportedNodeVersion: jest.fn(),
    }));
    jest.doMock("./services/telemetry/posthog-usage-tracking", () => ({
      shutdownPostHog: jest.fn().mockResolvedValue(undefined),
      trackCliStarted: jest.fn(),
    }));
    jest.doMock("./utils/logger", () => ({
      logger: {
        setOutputModes: jest.fn(),
        setLevel: jest.fn(),
        error: jest.fn(),
      },
      processNestedErrors: jest.fn((error) => error),
    }));
    jest.doMock("yargs/helpers", () => ({
      hideBin: jest.fn(() => process.argv.slice(2)),
    }));
    jest.doMock("yargs", () => {
      return {
        __esModule: true,
        default: jest.fn(() => {
          let failHandler:
            | ((msg?: string, err?: Error) => Promise<never>)
            | undefined;

          return {
            command() {
              return this;
            },
            strict() {
              return this;
            },
            fail(handler: typeof failHandler) {
              failHandler = handler;
              return this;
            },
            help() {
              return this;
            },
            async parseAsync() {
              if (!failHandler) {
                throw new Error("Missing fail handler");
              }
              return failHandler(
                "Primary App ID is missing.",
                new Error("Primary App ID is missing.")
              );
            },
          };
        }),
      };
    });

    await import("./cli");
    await new Promise((resolve) => setImmediate(resolve));

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(writeSpy.mock.calls[0]?.[0] || "").trim());
    expect(payload).toEqual({
      error: {
        code: "CLI_RUNTIME_ERROR",
        message: "Primary App ID is missing.",
      },
    });
    expect(process.exitCode).toBe(1);
  });

  it("emits a single validation envelope for stdout parser failures", async () => {
    const writeSpy = jest
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true as any);

    process.argv = [
      "node",
      "cli.ts",
      "keywords",
      "--stdout",
    ];

    jest.doMock("./load-env", () => ({}));
    jest.doMock("./services/telemetry/instrument", () => ({}));
    jest.doMock("./commands/aso", () => ({ __esModule: true, default: {} }));
    jest.doMock("./services/runtime/version-check-service", () => ({
      checkVersionUpdateSync: jest.fn(),
    }));
    jest.doMock("./services/telemetry/error-reporter", () => ({
      reportBugsnagError: jest.fn(),
    }));
    jest.doMock("./services/runtime/node-version-guard", () => ({
      assertSupportedNodeVersion: jest.fn(),
    }));
    jest.doMock("./services/telemetry/posthog-usage-tracking", () => ({
      shutdownPostHog: jest.fn().mockResolvedValue(undefined),
      trackCliStarted: jest.fn(),
    }));
    jest.doMock("./utils/logger", () => ({
      logger: {
        setOutputModes: jest.fn(),
        setLevel: jest.fn(),
        error: jest.fn(),
      },
      processNestedErrors: jest.fn((error) => error),
    }));
    jest.doMock("yargs/helpers", () => ({
      hideBin: jest.fn(() => process.argv.slice(2)),
    }));
    jest.doMock("yargs", () => {
      return {
        __esModule: true,
        default: jest.fn(() => {
          let failHandler:
            | ((msg?: string, err?: Error) => Promise<never>)
            | undefined;

          return {
            command() {
              return this;
            },
            strict() {
              return this;
            },
            fail(handler: typeof failHandler) {
              failHandler = handler;
              return this;
            },
            help() {
              return this;
            },
            async parseAsync() {
              if (!failHandler) {
                throw new Error("Missing fail handler");
              }
              return failHandler("Missing required argument: terms");
            },
          };
        }),
      };
    });

    await import("./cli");
    await new Promise((resolve) => setImmediate(resolve));

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(writeSpy.mock.calls[0]?.[0] || "").trim());
    expect(payload).toEqual({
      error: {
        code: "CLI_VALIDATION_ERROR",
        message: "Missing required argument: terms",
        help: "Use `aso --help` to see available commands and options.",
      },
    });
    expect(process.exitCode).toBe(1);
  });
});
