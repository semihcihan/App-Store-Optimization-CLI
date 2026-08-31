import { notifyBugsnagError } from "../../shared/telemetry/bugsnag-shared";
import { reportBugsnagError } from "../telemetry/error-reporter";
import { resetAppleHttpTracingForTests } from "../keywords/apple-http-trace";
import { AsoAuthEngine, AppleAuthResponseError } from "./aso-auth-service";

jest.mock("../../shared/telemetry/bugsnag-shared", () => ({
  initializeBugsnag: jest.fn(),
  notifyBugsnagError: jest.fn(),
}));

describe("aso auth reporting ownership", () => {
  const credentials = { appleId: "user@example.com", password: "pw" };
  const mockNotifyBugsnagError = jest.mocked(notifyBugsnagError);

  function createEngine(mode: "auto" | "sirp"): any {
    const engine = new AsoAuthEngine({ request: jest.fn() } as any, mode) as any;
    engine.resolveWidgetKey = jest.fn().mockResolvedValue("widget-key");
    engine.bootstrapAuthRequestContext = jest.fn().mockResolvedValue({
      frameId: "frame-id",
      state: "state-id",
    });
    return engine;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    resetAppleHttpTracingForTests();
  });

  it("reports propagated explicit SIRP drift once at the outer boundary", async () => {
    const engine = createEngine("sirp");
    engine.loginWithSirp = jest.fn(async () =>
      engine.handlePostLoginResponse({
        status: 400,
        data: {},
        headers: {},
      })
    );

    let propagatedError: unknown;
    try {
      await engine.ensureAuthenticated(credentials);
    } catch (error) {
      propagatedError = error;
    }

    expect(propagatedError).toBeInstanceOf(AppleAuthResponseError);
    expect(mockNotifyBugsnagError).not.toHaveBeenCalled();

    reportBugsnagError(propagatedError, {
      surface: "aso-cli",
      source: "cli.main.catch",
      operation: "command:auth",
    });

    expect(mockNotifyBugsnagError).toHaveBeenCalledTimes(1);
    expect(mockNotifyBugsnagError).toHaveBeenCalledWith(
      propagatedError,
      expect.objectContaining({
        telemetryClassification: "apple_contract_change",
        telemetryDecisionReason: "apple_auth_unknown",
      }),
      expect.any(Function)
    );
  });

  it("reports propagated unknown legacy fallback drift once at the outer boundary", async () => {
    const engine = createEngine("auto");
    engine.loginWithSirp = jest.fn().mockRejectedValue(new Error("SIRP failed"));
    engine.loginWithLegacy = jest.fn().mockRejectedValue(
      new AppleAuthResponseError({
        message: "Unknown legacy response",
        status: 400,
        payload: {},
        reason: "unknown",
      })
    );

    let propagatedError: unknown;
    try {
      await engine.ensureAuthenticated(credentials);
    } catch (error) {
      propagatedError = error;
    }

    expect(propagatedError).toBeInstanceOf(AppleAuthResponseError);
    expect(mockNotifyBugsnagError).not.toHaveBeenCalled();

    reportBugsnagError(propagatedError, {
      surface: "aso-dashboard-server",
      source: "dashboard-server.auth",
      operation: "auth.reauthenticate",
    });

    expect(mockNotifyBugsnagError).toHaveBeenCalledTimes(1);
    expect(mockNotifyBugsnagError).toHaveBeenCalledWith(
      propagatedError,
      expect.objectContaining({
        telemetryClassification: "apple_contract_change",
        telemetryDecisionReason: "apple_auth_unknown",
      }),
      expect.any(Function)
    );
  });
});
