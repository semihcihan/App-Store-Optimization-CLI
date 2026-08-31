import { initializeBugsnag } from "../shared/telemetry/bugsnag-shared";
import {
  getDashboardBugsnagApiKey,
  isDashboardDevelopment,
} from "./runtime-config";

export function initializeDashboardBugsnag(): void {
  const bugsnagApiKey = getDashboardBugsnagApiKey();
  initializeBugsnag({
    isDevelopment: isDashboardDevelopment(),
    ...(bugsnagApiKey ? { apiKey: bugsnagApiKey } : {}),
    autoTrackSessions: true,
    enabledBreadcrumbTypes: ["error", "manual", "navigation", "request"],
  });
}
