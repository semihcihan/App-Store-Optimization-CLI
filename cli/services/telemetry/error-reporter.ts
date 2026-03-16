import "./instrument";
import { notifyBugsnagError } from "../../shared/telemetry/bugsnag-shared";
import {
  classifyTelemetryError,
  withTelemetryDecisionMetadata,
} from "../../shared/telemetry/bugsnag-classifier";
import { getErrorBugsnagMetadata } from "./bugsnag-metadata";

function toRecord(
  value: unknown
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
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
  notifyBugsnagError(
    error,
    withTelemetryDecisionMetadata(mergedMetadata, decision)
  );
}
