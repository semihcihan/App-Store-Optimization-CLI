import {
  readAsoConfig,
  writeAsoConfig,
  type AsoConfig,
} from "../services/runtime/aso-config-service";

export type DashboardRefreshMode = "startup" | "manual";

export type DashboardSettings = {
  includeResearchAppsInKeywordRefresh: boolean;
  refreshMode: DashboardRefreshMode;
};

export const DEFAULT_DASHBOARD_SETTINGS: DashboardSettings = {
  includeResearchAppsInKeywordRefresh: true,
  refreshMode: "startup",
};

const CONFIG_KEY = "dashboardSettings";

function isRefreshMode(value: unknown): value is DashboardRefreshMode {
  return value === "startup" || value === "manual";
}

function normalizeSettings(value: unknown): DashboardSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_DASHBOARD_SETTINGS };
  }

  const raw = value as Partial<Record<keyof DashboardSettings, unknown>>;
  return {
    includeResearchAppsInKeywordRefresh:
      typeof raw.includeResearchAppsInKeywordRefresh === "boolean"
        ? raw.includeResearchAppsInKeywordRefresh
        : DEFAULT_DASHBOARD_SETTINGS.includeResearchAppsInKeywordRefresh,
    refreshMode: isRefreshMode(raw.refreshMode)
      ? raw.refreshMode
      : DEFAULT_DASHBOARD_SETTINGS.refreshMode,
  };
}

export function readDashboardSettings(configPath?: string): DashboardSettings {
  const config = readAsoConfig(configPath);
  return normalizeSettings(config[CONFIG_KEY]);
}

export function updateDashboardSettings(
  patch: Partial<DashboardSettings>,
  configPath?: string
): DashboardSettings {
  const config: AsoConfig = readAsoConfig(configPath);
  const current = normalizeSettings(config[CONFIG_KEY]);
  const next: DashboardSettings = {
    includeResearchAppsInKeywordRefresh:
      typeof patch.includeResearchAppsInKeywordRefresh === "boolean"
        ? patch.includeResearchAppsInKeywordRefresh
        : current.includeResearchAppsInKeywordRefresh,
    refreshMode: isRefreshMode(patch.refreshMode)
      ? patch.refreshMode
      : current.refreshMode,
  };

  writeAsoConfig(
    {
      ...config,
      [CONFIG_KEY]: next,
    },
    configPath
  );
  return next;
}
