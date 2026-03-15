describe("bugsnag-shared", () => {
  function getBugsnagMock(): {
    start: jest.Mock;
    notify: jest.Mock;
  } {
    return jest.requireMock("@bugsnag/js") as {
      start: jest.Mock;
      notify: jest.Mock;
    };
  }

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it("converts unknown values to Error instances", async () => {
    const { toError } = await import("../../shared/telemetry/bugsnag-shared");
    const existing = new Error("existing");

    expect(toError(existing)).toBe(existing);
    expect(toError("message")).toEqual(new Error("message"));
    expect(toError({ code: "E_FAIL" }).message).toBe('{"code":"E_FAIL"}');
  });

  it("does not start Bugsnag in development mode", async () => {
    const { initializeBugsnag } = await import("../../shared/telemetry/bugsnag-shared");
    const Bugsnag = getBugsnagMock();

    initializeBugsnag({ isDevelopment: true, appVersion: "1.2.3" });

    expect(Bugsnag.start).not.toHaveBeenCalled();
  });

  it("starts Bugsnag once in production mode with defaults", async () => {
    const { initializeBugsnag } = await import("../../shared/telemetry/bugsnag-shared");
    const Bugsnag = getBugsnagMock();

    initializeBugsnag({ isDevelopment: false, appVersion: "1.2.3" });
    initializeBugsnag({ isDevelopment: false, appVersion: "9.9.9" });

    expect(Bugsnag.start).toHaveBeenCalledTimes(1);
    expect(Bugsnag.start).toHaveBeenCalledWith(
      expect.objectContaining({
        appVersion: "1.2.3",
        autoTrackSessions: false,
        logger: null,
        enabledBreadcrumbTypes: ["error", "manual"],
        redactedKeys: expect.any(Array),
        onError: expect.any(Function),
      })
    );
  });

  it("sanitizes sensitive values globally via Bugsnag onError hook", async () => {
    const { initializeBugsnag } = await import("../../shared/telemetry/bugsnag-shared");
    const Bugsnag = getBugsnagMock();

    initializeBugsnag({ isDevelopment: false, appVersion: "1.2.3" });

    expect(Bugsnag.start).toHaveBeenCalledTimes(1);
    const config = Bugsnag.start.mock.calls[0]?.[0] as {
      onError?: (event: any) => void;
    };
    expect(typeof config.onError).toBe("function");

    const metadata: Record<string, any> = {
      metadata: {
        context: {
          code: "ENOENT",
          path: "security",
          spawnargs: [
            "add-generic-password",
            "-U",
            "-s",
            "aso.cli.apple",
            "-a",
            "default",
            "-w",
            '{"appleId":"user@example.com","password":"pw"}',
          ],
          nested: {
            username: "user@example.com",
            password: "pw",
          },
        },
      },
    };

    const event: any = {
      errors: [
        {
          errorMessage:
            'spawn failed payload={"appleId":"user@example.com","password":"pw"}',
        },
      ],
      getMetadata: jest.fn((section?: string, key?: string) => {
        if (!section) return metadata;
        if (!key) return metadata[section];
        return metadata[section]?.[key];
      }),
      clearMetadata: jest.fn((section: string, key?: string) => {
        if (!key) {
          delete metadata[section];
          return;
        }
        const sectionData = metadata[section];
        if (sectionData && typeof sectionData === "object") {
          delete sectionData[key];
        }
      }),
      addMetadata: jest.fn((section: string, values: Record<string, unknown>) => {
        metadata[section] = values;
      }),
    };

    config.onError?.(event);

    expect(metadata.metadata.context.spawnargs).toEqual([
      "add-generic-password",
      "-U",
      "-s",
      "aso.cli.apple",
      "-a",
      "default",
      "-w",
      "[REDACTED]",
    ]);
    expect(metadata.metadata.context.nested).toEqual({
      username: "[REDACTED]",
      password: "[REDACTED]",
    });
    expect(event.errors[0].errorMessage).toContain('"appleId":"[REDACTED]"');
    expect(event.errors[0].errorMessage).toContain('"password":"[REDACTED]"');
    expect(event.errors[0].errorMessage).not.toContain("user@example.com");
    expect(event.errors[0].errorMessage).not.toContain('"password":"pw"');
  });

  it("notifies errors only after startup and attaches metadata", async () => {
    const { initializeBugsnag, notifyBugsnagError } = await import(
      "../../shared/telemetry/bugsnag-shared"
    );
    const Bugsnag = getBugsnagMock();
    const addMetadata = jest.fn();
    const event: any = { addMetadata };
    Bugsnag.notify.mockImplementation(
      (_error: Error, callback: (event: unknown) => void) => {
        callback(event);
      }
    );

    notifyBugsnagError("not-started", { phase: "pre" });
    expect(Bugsnag.notify).not.toHaveBeenCalled();

    initializeBugsnag({ isDevelopment: false, appVersion: "1.2.3" });
    notifyBugsnagError(
      new Error("boom"),
      { phase: "run" },
      (mutableEvent: any) => {
        mutableEvent.custom = true;
      }
    );

    expect(Bugsnag.notify).toHaveBeenCalledTimes(1);
    expect(addMetadata).toHaveBeenCalledWith("metadata", { phase: "run" });
    expect((event as any).custom).toBe(true);
  });
});
