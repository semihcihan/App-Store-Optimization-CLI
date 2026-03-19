import type {
  TelemetryClassification,
  TelemetryHint,
} from "./bugsnag-classifier";
import {
  getRequestPath,
  normalizeOperationPath,
  slugToken,
  toStringValue,
} from "./telemetry-helpers";

const NOISE_CLASS_BY_REASON: Record<string, string> = {
  mcp_parse_json_shape: "mcp_parse_shape",
  dashboard_auth_status_transport: "local_setup",
  dashboard_apps_search_failed: "local_setup",
  explicit_hint_user_fault: "user_fault",
  credential_user_fault_message: "credential_user_fault",
  apple_auth_invalid_credentials: "credential_user_fault",
  apple_auth_two_factor_required: "credential_user_fault",
  apple_auth_upgrade_required: "credential_user_fault",
};

export function inferSurface(
  metadata: Record<string, unknown>,
  hint: TelemetryHint | undefined
): string | undefined {
  if (toStringValue(metadata.surface)) return toStringValue(metadata.surface);
  if (hint?.surface) return hint.surface;
  if (toStringValue(metadata.command)) return "aso-cli";
  if (toStringValue(metadata.tool) || hint?.tool) return "aso-mcp";
  return undefined;
}

export function inferSource(
  metadata: Record<string, unknown>,
  hint: TelemetryHint | undefined,
  surface: string
): string | undefined {
  if (toStringValue(metadata.source)) return toStringValue(metadata.source);
  if (hint?.source) return hint.source;

  const command = toStringValue(metadata.command);
  if (surface === "aso-cli" && command) {
    const normalized = slugToken(command);
    if (normalized) return `cli.${normalized}`;
  }

  const method = toStringValue(metadata.method)?.toUpperCase();
  const path = getRequestPath(metadata);
  if (surface.startsWith("aso-dashboard") && method && path) {
    return `${surface}.http`;
  }

  const tool = toStringValue(metadata.tool) ?? hint?.tool;
  if (surface === "aso-mcp" && tool) {
    const stage = toStringValue(metadata.stage) ?? hint?.stage ?? "runtime";
    return `mcp.${slugToken(tool)}.${slugToken(stage) || "runtime"}`;
  }

  return undefined;
}

export function inferOperation(
  metadata: Record<string, unknown>,
  hint: TelemetryHint | undefined
): string | undefined {
  if (toStringValue(metadata.operation)) return toStringValue(metadata.operation);
  if (hint?.operation) return hint.operation;

  const method = toStringValue(metadata.method)?.toUpperCase();
  const path = getRequestPath(metadata);
  if (method && path) return `${method} ${normalizeOperationPath(path)}`;

  const command = toStringValue(metadata.command);
  if (command) return `command:${command}`;

  const tool = toStringValue(metadata.tool) ?? hint?.tool;
  if (tool) {
    const stage = toStringValue(metadata.stage) ?? hint?.stage ?? "runtime";
    return `${tool}.${stage}`;
  }

  return undefined;
}

export function inferSignal(classification: TelemetryClassification): string {
  switch (classification) {
    case "user_fault":
    case "expected_flow":
    case "validation_error":
    case "transient_non_terminal":
      return "suppressed_noise";
    default:
      return "actionable";
  }
}

export function inferNoiseClass(
  metadata: Record<string, unknown>,
  reason: string,
  signal: string
): string | null {
  return (
    toStringValue(metadata.noise_class) ??
    NOISE_CLASS_BY_REASON[reason] ??
    (signal === "suppressed_noise" ? "user_fault" : null)
  );
}
