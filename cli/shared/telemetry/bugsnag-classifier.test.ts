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
    expect(decision.report).toBe(false);
    expect(decision.classification).toBe("user_fault");
  });

  it("classifies Apple 2FA verification delivery failures as user_fault", () => {
    const error = Object.assign(new Error("Verification codes cannot be sent"), {
      name: "AppleAuthResponseError",
      reason: "verification_delivery_failed",
    });

    const decision = classifyTelemetryError(error, {});
    expect(decision).toEqual({
      report: false,
      classification: "user_fault",
      reason: "apple_auth_verification_delivery_failed",
    });
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
      report: false,
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
      report: false,
      classification: "user_fault",
      reason: "dashboard_auth_status_transport",
    });
  });

  it("suppresses non-terminal Apple contract fallback diagnostics", () => {
    const decision = classifyTelemetryError(new Error("primary parser failed"), {
      telemetryHint: {
        classification: "apple_contract_change",
        upstreamProvider: "apple-appstore",
        isTerminal: false,
      },
    });

    expect(decision).toEqual({
      report: false,
      classification: "transient_non_terminal",
      reason: "non_terminal_contract_fallback",
    });
  });

  it("does not classify unrelated TypeError on auth status as noise", () => {
    const decision = classifyTelemetryError(new TypeError("Cannot read properties"), {
      surface: "aso-dashboard-ui",
      method: "GET",
      path: "/api/aso/auth/status",
    });

    expect(decision).toEqual({
      report: true,
      classification: "unknown",
      reason: "default_report",
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

  it("classifies transient Apple auth responses as terminal upstream failures", () => {
    const error = Object.assign(new Error("Apple login failed with status 503"), {
      name: "AppleAuthResponseError",
      reason: "unknown",
      status: 503,
    });

    const decision = classifyTelemetryError(error, {});
    expect(decision).toEqual({
      report: true,
      classification: "upstream_terminal_failure",
      reason: "apple_auth_transient_upstream",
    });
  });

  it.each([
    [
      Object.assign(new Error("bad command"), {
        name: "CliValidationError",
        code: "CLI_VALIDATION_ERROR",
      }),
      {},
      "cli_validation_error",
    ],
    [
      Object.assign(new Error("session expired"), {
        name: "AsoAuthReauthRequiredError",
        code: "ASO_AUTH_REAUTH_REQUIRED",
      }),
      {},
      "cli_auth_reauthentication_required",
    ],
    [
      new Error(
        "Primary App ID 123 is not accessible for this Apple Ads account."
      ),
      {
        telemetryHint: {
          upstreamProvider: "apple-search-ads",
          isTerminal: true,
        },
      },
      "primary_app_setup_flow",
    ],
    [
      new Error(
        "Interactive terminal is required to enter Apple credentials."
      ),
      {},
      "cli_credentials_tty_required",
    ],
    [
      new Error("All keywords failed (2): one:UPSTREAM_ERROR(400), two:BAD(403)"),
      {},
      "all_keywords_failed_4xx",
    ],
  ])("suppresses expected CLI noise: %s", (error, metadata, reason) => {
    const decision = classifyTelemetryError(error, metadata);

    expect(decision.report).toBe(false);
    expect(decision.reason).toBe(reason);
  });

  it("keeps mixed-status terminal keyword failures", () => {
    const decision = classifyTelemetryError(
      new Error(
        "All keywords failed (2): one:UPSTREAM_ERROR(400), two:FAILED(503)"
      ),
      {}
    );

    expect(decision).toEqual({
      report: true,
      classification: "unknown",
      reason: "default_report",
    });
  });

  it("keeps truncated keyword previews when hidden statuses are unknown", () => {
    const decision = classifyTelemetryError(
      new Error(
        "All keywords failed (6): one:BAD(400), two:BAD(400), three:BAD(400), four:BAD(400), five:BAD(400) (+1 more)"
      ),
      {}
    );

    expect(decision).toEqual({
      report: true,
      classification: "unknown",
      reason: "default_report",
    });
  });

  it("uses the complete structured keyword status list", () => {
    const error = Object.assign(
      new Error(
        "All keywords failed (6): one:BAD(400), two:BAD(400), three:BAD(400), four:BAD(400), five:BAD(400) (+1 more)"
      ),
      {
        name: "AllKeywordsFailedError",
        keywordFailureStatusCodes: [400, 400, 400, 400, 400, 503],
      }
    );

    expect(classifyTelemetryError(error, {})).toEqual({
      report: true,
      classification: "unknown",
      reason: "default_report",
    });
  });

  it("suppresses complete structured all-4xx keyword failures", () => {
    const error = Object.assign(
      new Error(
        "All keywords failed (6): one:BAD(400), two:BAD(400), three:BAD(400), four:BAD(400), five:BAD(400) (+1 more)"
      ),
      {
        name: "AllKeywordsFailedError",
        keywordFailureStatusCodes: [400, 400, 400, 400, 400, 429],
      }
    );

    expect(classifyTelemetryError(error, {})).toEqual({
      report: false,
      classification: "validation_error",
      reason: "all_keywords_failed_4xx",
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
