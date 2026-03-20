import "./instrument";
import { notifyBugsnagError } from "../../shared/telemetry/bugsnag-shared";
import {
  classifyTelemetryError,
  withTelemetryDecisionMetadata,
} from "../../shared/telemetry/bugsnag-classifier";
import { NoiseDedupeWindow } from "../../shared/telemetry/noise-dedupe";
import { buildNoiseSignature } from "../../shared/telemetry/noise-signature";
import { getErrorBugsnagMetadata } from "./bugsnag-metadata";

const USER_FAULT_DEDUPE_WINDOW_MS = 60_000;
const DEDUPABLE_USER_FAULT_REASONS = new Set(["mcp_parse_json_shape"]);
const userFaultDedupeWindow = new NoiseDedupeWindow(USER_FAULT_DEDUPE_WINDOW_MS);

function toRecord(
  value: unknown
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function shouldDedupeUserFault(reason: string, signal: unknown): boolean {
  return signal === "suppressed_noise" && DEDUPABLE_USER_FAULT_REASONS.has(reason);
}

export function reportBugsnagError(
  error: unknown,
  metadata: Record<string, unknown> = {}
): void {
  const errorMetadata = getErrorBugsnagMetadata(error) || {};
  const mergedMetadata = { ...metadata, ...errorMetadata };
  const telemetryHint = {
    ...(toRecord(metadata.telemetryHint) || {}),
    ...(toRecord(errorMetadata.telemetryHint) || {}),
  };
  if (Object.keys(telemetryHint).length > 0) {
    mergedMetadata.telemetryHint = telemetryHint;
  }
  const decision = classifyTelemetryError(error, mergedMetadata);
  if (!decision.report) return;
  let reportMetadata = withTelemetryDecisionMetadata(mergedMetadata, decision);
  if (shouldDedupeUserFault(decision.reason, reportMetadata.signal)) {
    const signature = buildNoiseSignature(error, reportMetadata);
    const dedupeDecision = userFaultDedupeWindow.register(signature);
    if (!dedupeDecision.shouldSend) return;
    if (dedupeDecision.dedupedCount > 0) {
      reportMetadata = {
        ...reportMetadata,
        deduped_count: dedupeDecision.dedupedCount,
      };
    }
  }
  notifyBugsnagError(
    error,
    reportMetadata,
    (event) => {
      if (decision.classification !== "user_fault") return;
      event.severity = "info";
    }
  );
}

export function resetErrorReporterDeduplicationForTests(): void {
  userFaultDedupeWindow.reset();
}
