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
    const { toError } = await import("./bugsnag-shared");
    const existing = new Error("existing");

    expect(toError(existing)).toBe(existing);
    expect(toError("message")).toEqual(new Error("message"));
    expect(toError({ code: "E_FAIL" }).message).toBe('{"code":"E_FAIL"}');
  });

  it("does not start Bugsnag in development mode", async () => {
    const { initializeBugsnag } = await import("./bugsnag-shared");
    const Bugsnag = getBugsnagMock();

    initializeBugsnag({ isDevelopment: true, appVersion: "1.2.3" });

    expect(Bugsnag.start).not.toHaveBeenCalled();
  });

  it("starts Bugsnag once in production mode with defaults", async () => {
    const { initializeBugsnag } = await import("./bugsnag-shared");
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
      })
    );
  });

  it("notifies errors only after startup and attaches metadata", async () => {
    const { initializeBugsnag, notifyBugsnagError } = await import(
      "./bugsnag-shared"
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
