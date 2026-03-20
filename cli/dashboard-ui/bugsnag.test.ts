import {
  initializeDashboardBugsnag,
  notifyDashboardError,
  resetDashboardBugsnagDeduplicationForTests,
} from "./bugsnag";
import {
  initializeBugsnag,
  notifyBugsnagError,
} from "../shared/telemetry/bugsnag-shared";

jest.mock("../shared/telemetry/bugsnag-shared", () => ({
  initializeBugsnag: jest.fn(),
  notifyBugsnagError: jest.fn(),
}));

jest.mock("./runtime-config", () => ({
  isDashboardDevelopment: jest.fn(() => false),
  getDashboardBugsnagApiKey: jest.fn(() => "browser-test-key"),
}));

describe("dashboard-ui/bugsnag", () => {
  const mockInitializeBugsnag = jest.mocked(initializeBugsnag);
  const mockNotifyBugsnagError = jest.mocked(notifyBugsnagError);

  beforeEach(() => {
    jest.clearAllMocks();
    resetDashboardBugsnagDeduplicationForTests();
  });

  it("initializes dashboard bugsnag with sessions and request/navigation breadcrumbs", () => {
    initializeDashboardBugsnag();

    expect(mockInitializeBugsnag).toHaveBeenCalledWith({
      isDevelopment: false,
      apiKey: "browser-test-key",
      autoTrackSessions: true,
      enabledBreadcrumbTypes: ["error", "manual", "navigation", "request"],
    });
  });

  it("suppresses expected dashboard 4xx flow errors", () => {
    const error = Object.assign(new Error("Unauthorized"), {
      name: "DashboardApiError",
      status: 401,
      errorCode: "AUTH_REQUIRED",
    });

    notifyDashboardError(error, { method: "POST", path: "/api/aso/auth/start" });

    expect(mockNotifyBugsnagError).not.toHaveBeenCalled();
  });

  it("reports actionable dashboard failures with decision metadata", () => {
    const error = Object.assign(new Error("Internal"), {
      name: "DashboardApiError",
      status: 500,
      errorCode: "INTERNAL_ERROR",
    });

    notifyDashboardError(error, { method: "POST", path: "/api/aso/keywords" });

    expect(mockNotifyBugsnagError).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        surface: "aso-dashboard-ui",
        method: "POST",
        path: "/api/aso/keywords",
        telemetryClassification: "unknown",
        telemetryDecisionReason: "default_report",
      }),
      expect.any(Function)
    );
  });

  it("dedupes repeated user-fault transport noise within 60 seconds", () => {
    const nowSpy = jest.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000);

    const error = new TypeError("Failed to fetch");
    const metadata = {
      method: "GET",
      path: "/api/aso/auth/status",
      source: "dashboard-ui.api-request",
      operation: "GET /api/aso/auth/status",
    };

    notifyDashboardError(error, metadata);
    notifyDashboardError(error, metadata);
    nowSpy.mockReturnValue(62_000);
    notifyDashboardError(error, metadata);

    expect(mockNotifyBugsnagError).toHaveBeenCalledTimes(2);
    expect(mockNotifyBugsnagError).toHaveBeenNthCalledWith(
      1,
      error,
      expect.objectContaining({
        telemetryClassification: "user_fault",
      }),
      expect.any(Function)
    );
    expect(mockNotifyBugsnagError).toHaveBeenNthCalledWith(
      2,
      error,
      expect.objectContaining({
        telemetryClassification: "user_fault",
        deduped_count: 1,
      }),
      expect.any(Function)
    );
  });
});
