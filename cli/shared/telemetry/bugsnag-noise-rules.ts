import type { TelemetryDecision, TelemetryHint } from "./bugsnag-classifier";
import {
  getErrorMessage,
  getRequestPath,
  normalizeOperationPath,
  toStringValue,
  type AnyRecord,
} from "./telemetry-helpers";

function isDashboardUiSurface(
  metadata: AnyRecord,
  hint: TelemetryHint | undefined
): boolean {
  const surface = toStringValue(metadata.surface) ?? hint?.surface;
  return surface === "aso-dashboard-ui";
}

function isLikelyTransportError(error: unknown): boolean {
  const message = (getErrorMessage(error) || "").toLowerCase();
  return message !== "" && (
    message.includes("failed to fetch") ||
    message.includes("load failed") ||
    message.includes("networkerror") ||
    message.includes("network request failed")
  );
}

export function classifyKnownNoise(
  error: unknown,
  metadata: AnyRecord,
  hint: TelemetryHint | undefined
): TelemetryDecision | undefined {
  const message = (getErrorMessage(error) || "").toLowerCase();
  if (message.includes("mcp expected json output from aso keywords")) {
    return {
      report: true,
      classification: "user_fault",
      reason: "mcp_parse_json_shape",
    };
  }

  if (!isDashboardUiSurface(metadata, hint)) return undefined;
  const path = getRequestPath(metadata);
  const method = toStringValue(metadata.method)?.toUpperCase();
  const normalizedPath = path ? normalizeOperationPath(path) : undefined;
  if (
    normalizedPath === "/api/aso/auth/status" &&
    method === "GET" &&
    isLikelyTransportError(error)
  ) {
    return {
      report: true,
      classification: "user_fault",
      reason: "dashboard_auth_status_transport",
    };
  }
  if (
    normalizedPath === "/api/aso/apps/search" &&
    message.includes("failed to search apps")
  ) {
    return {
      report: true,
      classification: "user_fault",
      reason: "dashboard_apps_search_failed",
    };
  }

  return undefined;
}
