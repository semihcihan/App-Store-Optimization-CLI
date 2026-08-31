import { initializeDashboardBugsnag } from "./bugsnag";
import { initializeBugsnag } from "../shared/telemetry/bugsnag-shared";

jest.mock("../shared/telemetry/bugsnag-shared", () => ({
  initializeBugsnag: jest.fn(),
}));

jest.mock("./runtime-config", () => ({
  isDashboardDevelopment: jest.fn(() => false),
  getDashboardBugsnagApiKey: jest.fn(() => "browser-test-key"),
}));

describe("dashboard-ui/bugsnag", () => {
  const mockInitializeBugsnag = jest.mocked(initializeBugsnag);

  beforeEach(() => {
    jest.clearAllMocks();
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
});
