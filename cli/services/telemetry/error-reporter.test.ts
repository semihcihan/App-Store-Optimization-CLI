import { notifyBugsnagError } from "../../shared/telemetry/bugsnag-shared";
import { getErrorBugsnagMetadata } from "./bugsnag-metadata";
import { reportBugsnagError } from "./error-reporter";

jest.mock("../../shared/telemetry/bugsnag-shared", () => ({
  notifyBugsnagError: jest.fn(),
  initializeBugsnag: jest.fn(),
}));

jest.mock("./bugsnag-metadata", () => ({
  getErrorBugsnagMetadata: jest.fn(),
}));

describe("reportBugsnagError", () => {
  const mockNotifyBugsnagError = jest.mocked(notifyBugsnagError);
  const mockGetErrorBugsnagMetadata = jest.mocked(getErrorBugsnagMetadata);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("merges caller metadata with error metadata", () => {
    const error = new Error("boom");
    mockGetErrorBugsnagMetadata.mockReturnValue({
      requestId: "req-1",
      phase: "error",
    });

    reportBugsnagError(error, { phase: "caller", command: "aso keywords" });

    expect(mockNotifyBugsnagError).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        phase: "error",
        command: "aso keywords",
        requestId: "req-1",
        request_id: "req-1",
        surface: "aso-cli",
        source: "cli.aso-keywords",
        operation: "command:aso keywords",
        signal: "actionable",
        telemetryClassification: "unknown",
        telemetryDecisionReason: "default_report",
      }),
      expect.any(Function)
    );
  });

  it("handles missing error metadata", () => {
    const error = new Error("boom");
    mockGetErrorBugsnagMetadata.mockReturnValue(undefined);

    reportBugsnagError(error, { command: "aso auth" });

    expect(mockNotifyBugsnagError).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        command: "aso auth",
        surface: "aso-cli",
        source: "cli.aso-auth",
        operation: "command:aso auth",
        signal: "actionable",
        telemetryClassification: "unknown",
        telemetryDecisionReason: "default_report",
      }),
      expect.any(Function)
    );
  });

  it("reports user-fault Apple auth errors with suppressed-noise signal", () => {
    const error = Object.assign(new Error("Invalid Apple ID credentials"), {
      name: "AppleAuthResponseError",
      reason: "invalid_credentials",
    });
    mockGetErrorBugsnagMetadata.mockReturnValue(undefined);

    reportBugsnagError(error, { command: "aso auth" });

    expect(mockNotifyBugsnagError).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        telemetryClassification: "user_fault",
        telemetryDecisionReason: "apple_auth_invalid_credentials",
        signal: "suppressed_noise",
        noise_class: "credential_user_fault",
      }),
      expect.any(Function)
    );
  });

  it("deep-merges telemetryHint so caller classifications survive trace metadata", () => {
    const error = new Error("contract drift");
    mockGetErrorBugsnagMetadata.mockReturnValue({
      telemetryHint: {
        upstreamProvider: "apple-search-ads",
        operation: "keywords-popularities-response",
        source: "apple.apple-search-ads.keywords-popularities-response",
      },
    });

    reportBugsnagError(error, {
      telemetryHint: {
        classification: "apple_contract_change",
        surface: "aso-apple-api",
      },
    });

    expect(mockNotifyBugsnagError).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        telemetryHint: expect.objectContaining({
          classification: "apple_contract_change",
          surface: "aso-apple-api",
          upstreamProvider: "apple-search-ads",
          operation: "keywords-popularities-response",
          source: "apple.apple-search-ads.keywords-popularities-response",
        }),
      }),
      expect.any(Function)
    );
  });
});
