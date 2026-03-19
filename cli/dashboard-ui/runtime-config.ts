type DashboardRuntimeConfig = {
  nodeEnv?: string;
  bugsnagVerboseTraces?: boolean;
};

declare global {
  interface Window {
    __ASO_DASHBOARD_RUNTIME__?: DashboardRuntimeConfig;
  }
}

function getRuntimeNodeEnv(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const nodeEnv = window.__ASO_DASHBOARD_RUNTIME__?.nodeEnv;
  if (typeof nodeEnv !== "string") return undefined;
  const normalized = nodeEnv.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function getRuntimeBugsnagVerboseTraces(): boolean {
  if (typeof window === "undefined") return false;
  return window.__ASO_DASHBOARD_RUNTIME__?.bugsnagVerboseTraces === true;
}

export function isDashboardDevelopment(): boolean {
  const nodeEnv = getRuntimeNodeEnv();
  return nodeEnv === "development";
}

export function isDashboardVerboseTraceEnabled(): boolean {
  return getRuntimeBugsnagVerboseTraces();
}
