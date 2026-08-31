import type { TelemetryDecision, TelemetryHint } from "./bugsnag-classifier";
import {
  getErrorName,
  getErrorRecord,
  getErrorMessage,
  toStatusCode,
  toStringValue,
  type AnyRecord,
} from "./telemetry-helpers";

const AUTH_REAUTH_REQUIRED_ERROR_CODE = "ASO_AUTH_REAUTH_REQUIRED";

function hasOnlyFourHundredKeywordFailures(
  error: unknown,
  message: string
): boolean {
  const record = getErrorRecord(error);
  const structuredStatuses = record?.keywordFailureStatusCodes;
  if (Array.isArray(structuredStatuses)) {
    return (
      structuredStatuses.length > 0 &&
      structuredStatuses.every((value) => {
        const status = toStatusCode(value);
        return status != null && status >= 400 && status < 500;
      })
    );
  }

  const failureCountMatch = /^all keywords failed \((\d+)\):/.exec(message);
  if (!failureCountMatch) return false;
  const failureCount = Number(failureCountMatch[1]);
  const statuses = Array.from(message.matchAll(/\((\d{3})\)/g), (match) =>
    Number(match[1])
  ).filter((status) => status >= 400);
  return (
    failureCount > 0 &&
    statuses.length === failureCount &&
    statuses.every((status) => status >= 400 && status < 500)
  );
}

function classifyExpectedCliFlow(
  error: unknown
): TelemetryDecision | undefined {
  const record = getErrorRecord(error);
  const name = getErrorName(error);
  const code = toStringValue(record?.code);
  const message = (getErrorMessage(error) || "").toLowerCase();

  if (
    name === "CliValidationError" ||
    code === "CLI_VALIDATION_ERROR" ||
    name === "UnsupportedCountryError" ||
    code === "ASO_UNSUPPORTED_COUNTRY"
  ) {
    return {
      report: false,
      classification: "validation_error",
      reason: "cli_validation_error",
    };
  }
  if (
    name === "AsoAuthReauthRequiredError" ||
    code === AUTH_REAUTH_REQUIRED_ERROR_CODE ||
    message.includes("needs interactive apple search ads reauthentication")
  ) {
    return {
      report: false,
      classification: "expected_flow",
      reason: "cli_auth_reauthentication_required",
    };
  }
  if (
    message.includes("primary app id") &&
    (message.includes("is missing") ||
      message.includes("must be updated interactively") ||
      message.includes("not accessible") ||
      message.includes("you can access"))
  ) {
    return {
      report: false,
      classification: "expected_flow",
      reason: "primary_app_setup_flow",
    };
  }
  if (
    message.includes(
      "interactive terminal is required to enter apple credentials"
    )
  ) {
    return {
      report: false,
      classification: "expected_flow",
      reason: "cli_credentials_tty_required",
    };
  }
  if (message.includes("not enabled for app store connect")) {
    return {
      report: false,
      classification: "expected_flow",
      reason: "apple_account_setup_required",
    };
  }
  if (hasOnlyFourHundredKeywordFailures(error, message)) {
    return {
      report: false,
      classification: "validation_error",
      reason: "all_keywords_failed_4xx",
    };
  }

  return undefined;
}

export function classifyKnownNoise(
  error: unknown,
  metadata: AnyRecord,
  hint: TelemetryHint | undefined
): TelemetryDecision | undefined {
  const expectedCliFlow = classifyExpectedCliFlow(error);
  if (expectedCliFlow) return expectedCliFlow;

  const message = (getErrorMessage(error) || "").toLowerCase();
  if (message.includes("mcp expected json output from aso keywords")) {
    return {
      report: false,
      classification: "user_fault",
      reason: "mcp_parse_json_shape",
    };
  }

  return undefined;
}
