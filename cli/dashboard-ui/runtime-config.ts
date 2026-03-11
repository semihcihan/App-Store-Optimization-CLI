type DashboardRuntimeConfig = {
  nodeEnv?: string;
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

export function isDashboardDevelopment(): boolean {
  const nodeEnv = getRuntimeNodeEnv();
  return nodeEnv === "development";
}
