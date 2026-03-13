import { notifyDashboardError } from "./bugsnag";
import { notifyBugsnagError } from "../shared/telemetry/bugsnag-shared";

jest.mock("../shared/telemetry/bugsnag-shared", () => ({
  initializeBugsnag: jest.fn(),
  notifyBugsnagError: jest.fn(),
}));

jest.mock("./runtime-config", () => ({
  isDashboardDevelopment: jest.fn(() => false),
}));

describe("dashboard-ui/bugsnag", () => {
  const mockNotifyBugsnagError = jest.mocked(notifyBugsnagError);

  beforeEach(() => {
    jest.clearAllMocks();
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
      })
    );
  });
});
