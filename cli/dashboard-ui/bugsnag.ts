import {
  initializeBugsnag,
  notifyBugsnagError,
} from "../shared/telemetry/bugsnag-shared";
import {
  classifyTelemetryError,
  withTelemetryDecisionMetadata,
} from "../shared/telemetry/bugsnag-classifier";
import { NoiseDedupeWindow } from "../shared/telemetry/noise-dedupe";
import { buildNoiseSignature } from "../shared/telemetry/noise-signature";
import {
  getDashboardBugsnagApiKey,
  isDashboardDevelopment,
} from "./runtime-config";

const DASHBOARD_BUGSNAG_DEDUPE_WINDOW_MS = 60_000;
const dedupeWindow = new NoiseDedupeWindow(DASHBOARD_BUGSNAG_DEDUPE_WINDOW_MS);

function shouldDedupe(decisionClassification: string, signal: unknown): boolean {
  if (decisionClassification === "user_fault") return true;
  return signal === "suppressed_noise";
}

function applyNoiseEventMutation(decisionClassification: string): (event: any) => void {
  return (event) => {
    if (decisionClassification !== "user_fault") return;
    event.severity = "info";
  };
}

export function initializeDashboardBugsnag(): void {
  const bugsnagApiKey = getDashboardBugsnagApiKey();
  initializeBugsnag({
    isDevelopment: isDashboardDevelopment(),
    ...(bugsnagApiKey ? { apiKey: bugsnagApiKey } : {}),
    autoTrackSessions: true,
    enabledBreadcrumbTypes: ["error", "manual", "navigation", "request"],
  });
}

export function resetDashboardBugsnagDeduplicationForTests(): void {
  dedupeWindow.reset();
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
  let reportMetadata = withTelemetryDecisionMetadata(mergedMetadata, decision);

  if (shouldDedupe(decision.classification, reportMetadata.signal)) {
    const signature = buildNoiseSignature(error, reportMetadata);
    const dedupeDecision = dedupeWindow.register(signature);
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
    applyNoiseEventMutation(decision.classification)
  );
}
