type AnyRecord = Record<string, unknown>;

export type TelemetryClassification =
  | "actionable_bug"
  | "apple_contract_change"
  | "upstream_terminal_failure"
  | "user_fault"
  | "expected_flow"
  | "validation_error"
  | "transient_non_terminal"
  | "unknown";

export type TelemetryHint = {
  classification?: TelemetryClassification;
  isTerminal?: boolean;
  isUserFault?: boolean;
  source?: string;
  operation?: string;
  surface?: string;
  statusCode?: number;
  errorCode?: string;
  tool?: string;
  stage?: string;
  upstreamProvider?: string;
};

export type TelemetryDecision = {
  report: boolean;
  classification: TelemetryClassification;
  reason: string;
};

const REPORTABLE_CLASSIFICATIONS = new Set<TelemetryClassification>([
  "actionable_bug",
  "apple_contract_change",
  "upstream_terminal_failure",
  "unknown",
]);

const EXPECTED_DASHBOARD_FLOW_ERROR_CODES = new Set([
  "INVALID_REQUEST",
  "PAYLOAD_TOO_LARGE",
  "AUTH_REQUIRED",
  "AUTH_IN_PROGRESS",
  "TTY_REQUIRED",
  "AUTHORIZATION_FAILED",
  "NOT_FOUND",
]);

const APPLE_AUTH_USER_FAULT_REASONS = new Set([
  "invalid_credentials",
  "two_factor_required",
  "upgrade_required",
]);

function toRecord(value: unknown): AnyRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as AnyRecord;
}

function toStatusCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function toStringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function getTelemetryHint(metadata: AnyRecord): TelemetryHint | undefined {
  const hint = toRecord(metadata.telemetryHint);
  if (!hint) return undefined;

  return {
    classification: toStringValue(hint.classification) as
      | TelemetryClassification
      | undefined,
    isTerminal: typeof hint.isTerminal === "boolean" ? hint.isTerminal : undefined,
    isUserFault: typeof hint.isUserFault === "boolean" ? hint.isUserFault : undefined,
    source: toStringValue(hint.source),
    operation: toStringValue(hint.operation),
    surface: toStringValue(hint.surface),
    statusCode: toStatusCode(hint.statusCode),
    errorCode: toStringValue(hint.errorCode),
    tool: toStringValue(hint.tool),
    stage: toStringValue(hint.stage),
    upstreamProvider: toStringValue(hint.upstreamProvider),
  };
}

function getErrorRecord(error: unknown): AnyRecord | undefined {
  return toRecord(error);
}

function getStatusCode(error: unknown, metadata: AnyRecord): number | undefined {
  const hint = getTelemetryHint(metadata);
  if (hint?.statusCode != null) return hint.statusCode;

  const record = getErrorRecord(error);
  return toStatusCode(record?.status ?? record?.statusCode ?? metadata.statusCode);
}

function getErrorCode(error: unknown, metadata: AnyRecord): string | undefined {
  const hint = getTelemetryHint(metadata);
  if (hint?.errorCode) return hint.errorCode;

  const record = getErrorRecord(error);
  return toStringValue(record?.errorCode ?? record?.code ?? metadata.errorCode);
}

function isDashboardApiErrorLike(error: unknown): boolean {
  const record = getErrorRecord(error);
  return toStringValue(record?.name) === "DashboardApiError";
}

function isAppleAuthResponseErrorLike(error: unknown): boolean {
  const record = getErrorRecord(error);
  return toStringValue(record?.name) === "AppleAuthResponseError";
}

function isLikelyCredentialUserFault(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("invalid apple id credentials") ||
    message.includes("invalid credentials") ||
    message.includes("incorrect verification code")
  );
}

function isLikelyUserSetupFlow(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("primary app id") &&
    (message.includes("not accessible") || message.includes("you can access"))
  );
}

function classifyKnownFlow(
  error: unknown,
  metadata: AnyRecord
): TelemetryDecision | undefined {
  const hint = getTelemetryHint(metadata);
  if (hint?.classification) {
    return {
      report: REPORTABLE_CLASSIFICATIONS.has(hint.classification),
      classification: hint.classification,
      reason: "explicit_hint_classification",
    };
  }
  if (hint?.isUserFault) {
    return {
      report: false,
      classification: "user_fault",
      reason: "explicit_hint_user_fault",
    };
  }
  if (isAppleAuthResponseErrorLike(error)) {
    const reason = toStringValue((error as AnyRecord).reason);
    if (reason && APPLE_AUTH_USER_FAULT_REASONS.has(reason)) {
      return {
        report: false,
        classification: "user_fault",
        reason: `apple_auth_${reason}`,
      };
    }
    return {
      report: true,
      classification: "apple_contract_change",
      reason: `apple_auth_${reason ?? "unknown"}`,
    };
  }

  if (hint?.isTerminal === false) {
    return {
      report: false,
      classification: "transient_non_terminal",
      reason: "explicit_hint_non_terminal",
    };
  }
  if (hint?.upstreamProvider && hint?.isTerminal === true) {
    return {
      report: true,
      classification: "upstream_terminal_failure",
      reason: "explicit_hint_terminal_upstream",
    };
  }

  if (isLikelyCredentialUserFault(error)) {
    return {
      report: false,
      classification: "user_fault",
      reason: "credential_user_fault_message",
    };
  }

  const statusCode = getStatusCode(error, metadata);
  const errorCode = getErrorCode(error, metadata);
  const isDashboardClientFlow = isDashboardApiErrorLike(error) && statusCode != null;
  if (isDashboardClientFlow && statusCode >= 400 && statusCode < 500) {
    return {
      report: false,
      classification: "expected_flow",
      reason: "dashboard_api_4xx",
    };
  }

  if (errorCode && EXPECTED_DASHBOARD_FLOW_ERROR_CODES.has(errorCode)) {
    return {
      report: false,
      classification: "expected_flow",
      reason: `dashboard_error_code_${errorCode}`,
    };
  }

  if (isLikelyUserSetupFlow(error)) {
    return {
      report: false,
      classification: "expected_flow",
      reason: "primary_app_setup_flow",
    };
  }

  if (statusCode != null && statusCode >= 400 && statusCode < 500) {
    return {
      report: false,
      classification: "validation_error",
      reason: "generic_4xx",
    };
  }

  return undefined;
}

export function classifyTelemetryError(
  error: unknown,
  metadata: Record<string, unknown> = {}
): TelemetryDecision {
  const known = classifyKnownFlow(error, metadata);
  if (known) return known;

  return {
    report: true,
    classification: "unknown",
    reason: "default_report",
  };
}

export function withTelemetryDecisionMetadata(
  metadata: Record<string, unknown>,
  decision: TelemetryDecision
): Record<string, unknown> {
  const hint = getTelemetryHint(metadata);
  const surface = toStringValue(metadata.surface) ?? hint?.surface ?? "unknown";
  const source = toStringValue(metadata.source) ?? hint?.source ?? "unknown";
  const operation =
    toStringValue(metadata.operation) ?? hint?.operation ?? "unknown";
  const isTerminal =
    typeof metadata.isTerminal === "boolean"
      ? metadata.isTerminal
      : hint?.isTerminal ?? null;

  return {
    ...metadata,
    surface,
    source,
    operation,
    isTerminal,
    telemetryClassification: decision.classification,
    telemetryDecisionReason: decision.reason,
  };
}
