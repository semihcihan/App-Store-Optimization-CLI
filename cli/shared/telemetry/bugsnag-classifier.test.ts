import {
  classifyTelemetryError,
  withTelemetryDecisionMetadata,
} from "./bugsnag-classifier";

describe("bugsnag-classifier", () => {
  it("reports explicit actionable classifications", () => {
    const decision = classifyTelemetryError(new Error("boom"), {
      telemetryHint: { classification: "actionable_bug" },
    });

    expect(decision).toEqual({
      report: true,
      classification: "actionable_bug",
      reason: "explicit_hint_classification",
    });
  });

  it("classifies terminal upstream hints explicitly", () => {
    const decision = classifyTelemetryError(new Error("upstream failed"), {
      telemetryHint: {
        upstreamProvider: "apple-search-ads",
        isTerminal: true,
      },
    });
    expect(decision).toEqual({
      report: true,
      classification: "upstream_terminal_failure",
      reason: "explicit_hint_terminal_upstream",
    });
  });

  it("suppresses non-terminal upstream hints", () => {
    const decision = classifyTelemetryError(new Error("retrying"), {
      telemetryHint: {
        upstreamProvider: "apple-search-ads",
        isTerminal: false,
      },
    });
    expect(decision).toEqual({
      report: false,
      classification: "transient_non_terminal",
      reason: "explicit_hint_non_terminal",
    });
  });

  it("suppresses explicit user-fault hints", () => {
    const decision = classifyTelemetryError(new Error("bad input"), {
      telemetryHint: { isUserFault: true },
    });

    expect(decision.report).toBe(true);
    expect(decision.classification).toBe("user_fault");
  });

  it("suppresses dashboard api 4xx flow errors", () => {
    const dashboardApiError = Object.assign(new Error("Unauthorized"), {
      name: "DashboardApiError",
      status: 401,
      errorCode: "AUTH_REQUIRED",
    });
    const decision = classifyTelemetryError(dashboardApiError, {
      method: "POST",
      path: "/api/aso/auth/start",
    });

    expect(decision).toEqual({
      report: false,
      classification: "expected_flow",
      reason: "dashboard_api_4xx",
    });
  });

  it("does not suppress actionable dashboard timeout/network server errors", () => {
    const timeoutError = Object.assign(new Error("Request timed out"), {
      name: "DashboardApiError",
      status: 500,
      errorCode: "REQUEST_TIMEOUT",
    });
    const networkError = Object.assign(new Error("Network unavailable"), {
      name: "DashboardApiError",
      status: 500,
      errorCode: "NETWORK_ERROR",
    });

    const timeoutDecision = classifyTelemetryError(timeoutError, {});
    const networkDecision = classifyTelemetryError(networkError, {});

    expect(timeoutDecision).toEqual({
      report: true,
      classification: "unknown",
      reason: "default_report",
    });
    expect(networkDecision).toEqual({
      report: true,
      classification: "unknown",
      reason: "default_report",
    });
  });

  it("suppresses known Apple auth user faults", () => {
    const error = Object.assign(new Error("Invalid Apple ID credentials"), {
      name: "AppleAuthResponseError",
      reason: "invalid_credentials",
    });

    const decision = classifyTelemetryError(error, {});
    expect(decision.report).toBe(true);
    expect(decision.classification).toBe("user_fault");
  });

  it("classifies mcp parse-json payload drift as user-fault noise", () => {
    const decision = classifyTelemetryError(
      new Error("MCP expected JSON output from aso keywords"),
      {
        surface: "aso-mcp",
        stage: "parse-json",
      }
    );

    expect(decision).toEqual({
      report: true,
      classification: "user_fault",
      reason: "mcp_parse_json_shape",
    });
  });

  it("classifies dashboard auth status transport errors as user-fault noise", () => {
    const decision = classifyTelemetryError(new TypeError("Failed to fetch"), {
      surface: "aso-dashboard-ui",
      method: "GET",
      path: "/api/aso/auth/status",
    });

    expect(decision).toEqual({
      report: true,
      classification: "user_fault",
      reason: "dashboard_auth_status_transport",
    });
  });

  it("reports unknown Apple auth reasons as apple contract changes", () => {
    const error = Object.assign(new Error("Unexpected Apple auth response"), {
      name: "AppleAuthResponseError",
      reason: "unknown",
    });

    const decision = classifyTelemetryError(error, {});
    expect(decision).toEqual({
      report: true,
      classification: "apple_contract_change",
      reason: "apple_auth_unknown",
    });
  });

  it("adds decision metadata to report payloads", () => {
    const metadata = withTelemetryDecisionMetadata(
      { phase: "run" },
      {
        report: true,
        classification: "upstream_terminal_failure",
        reason: "explicit_hint_terminal_upstream",
      }
    );

    expect(metadata).toEqual({
      phase: "run",
      surface: "unknown",
      source: "unknown",
      operation: "unknown",
      endpoint: null,
      method: null,
      status: null,
      request_id: null,
      upstream_service: null,
      signal: "actionable",
      noise_class: null,
      isTerminal: null,
      telemetryClassification: "upstream_terminal_failure",
      telemetryDecisionReason: "explicit_hint_terminal_upstream",
    });
  });

  it("normalizes report fields from telemetryHint", () => {
    const metadata = withTelemetryDecisionMetadata(
      {
        telemetryHint: {
          surface: "aso-mcp",
          source: "mcp.aso-evaluate-keywords.parse-envelope",
          operation: "keywords-popularities-request",
          isTerminal: true,
        },
      },
      {
        report: true,
        classification: "actionable_bug",
        reason: "explicit_hint_classification",
      }
    );

    expect(metadata).toEqual(
      expect.objectContaining({
        surface: "aso-mcp",
        source: "mcp.aso-evaluate-keywords.parse-envelope",
        operation: "keywords-popularities-request",
        signal: "actionable",
        isTerminal: true,
      })
    );
  });

  it("infers cli source and operation from command metadata", () => {
    const metadata = withTelemetryDecisionMetadata(
      { command: "aso keywords" },
      {
        report: true,
        classification: "unknown",
        reason: "default_report",
      }
    );

    expect(metadata).toEqual(
      expect.objectContaining({
        surface: "aso-cli",
        source: "cli.aso-keywords",
        operation: "command:aso keywords",
      })
    );
  });
});
