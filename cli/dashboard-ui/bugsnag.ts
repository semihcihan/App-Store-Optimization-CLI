import {
  initializeBugsnag,
  notifyBugsnagError,
} from "../shared/telemetry/bugsnag-shared";
import {
  classifyTelemetryError,
  withTelemetryDecisionMetadata,
} from "../shared/telemetry/bugsnag-classifier";
import { isDashboardDevelopment } from "./runtime-config";

export function initializeDashboardBugsnag(): void {
  initializeBugsnag({
    isDevelopment: isDashboardDevelopment(),
  });
}

export function notifyDashboardError(
  error: unknown,
  metadata: Record<string, unknown> = {}
): void {
  const mergedMetadata = {
    surface: "aso-dashboard-ui",
    ...metadata,
  };
  const decision = classifyTelemetryError(error, mergedMetadata);
  if (!decision.report) return;
  notifyBugsnagError(
    error,
    withTelemetryDecisionMetadata(mergedMetadata, decision)
  );
}
