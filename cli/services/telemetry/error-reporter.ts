import "./instrument";
import { notifyBugsnagError } from "../../shared/telemetry/bugsnag-shared";
import {
  classifyTelemetryError,
  withTelemetryDecisionMetadata,
} from "../../shared/telemetry/bugsnag-classifier";
import { getErrorBugsnagMetadata } from "./bugsnag-metadata";

export function reportBugsnagError(
  error: unknown,
  metadata: Record<string, unknown> = {}
): void {
  const errorMetadata = getErrorBugsnagMetadata(error) || {};
  const mergedMetadata = { ...metadata, ...errorMetadata };
  const decision = classifyTelemetryError(error, mergedMetadata);
  if (!decision.report) return;
  notifyBugsnagError(
    error,
    withTelemetryDecisionMetadata(mergedMetadata, decision)
  );
}
