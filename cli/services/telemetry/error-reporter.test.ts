import { notifyBugsnagError } from "../../shared/telemetry/bugsnag-shared";
import { getErrorBugsnagMetadata } from "./bugsnag-metadata";
import {
  reportBugsnagError,
  resetErrorReporterDeduplicationForTests,
} from "./error-reporter";

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
    resetErrorReporterDeduplicationForTests();
  });

  afterEach(() => {
    jest.restoreAllMocks();
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

  it("suppresses MCP parse-json user-fault signals", () => {
    const error = new Error("MCP expected JSON output from aso keywords");
    const metadata = {
      surface: "aso-mcp",
      tool: "aso_evaluate_keywords",
      stage: "parse-json",
      operation: "aso_evaluate_keywords.parse-json",
      source: "mcp.aso-evaluate-keywords.parse-json",
    };

    reportBugsnagError(error, metadata);

    expect(mockNotifyBugsnagError).not.toHaveBeenCalled();
  });

  it("suppresses user-fault Apple auth errors", () => {
    const error = Object.assign(new Error("Invalid Apple ID credentials"), {
      name: "AppleAuthResponseError",
      reason: "invalid_credentials",
    });
    mockGetErrorBugsnagMetadata.mockReturnValue(undefined);

    reportBugsnagError(error, { command: "aso auth" });

    expect(mockNotifyBugsnagError).not.toHaveBeenCalled();
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

  it("delivers recovered Apple contract drift to Bugsnag", () => {
    const error = new Error("recovered contract drift");
    mockGetErrorBugsnagMetadata.mockReturnValue(undefined);

    reportBugsnagError(error, {
      telemetryHint: {
        classification: "apple_contract_change",
        upstreamProvider: "apple-appstore",
        isTerminal: false,
      },
      recoveryOutcome: "recovered",
    });

    expect(mockNotifyBugsnagError).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        isTerminal: false,
        recoveryOutcome: "recovered",
        telemetryClassification: "apple_contract_change",
      }),
      expect.any(Function)
    );
  });
});
