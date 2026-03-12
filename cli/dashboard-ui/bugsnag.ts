import {
  initializeBugsnag,
  notifyBugsnagError,
} from "../shared/telemetry/bugsnag-shared";
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
  notifyBugsnagError(error, {
    surface: "aso-dashboard-ui",
    ...metadata,
  });
}
