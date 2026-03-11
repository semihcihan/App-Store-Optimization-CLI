export const RESEARCH_APP_ID = "research";
export const RESEARCH_APP_ID_PREFIX = "research:";
export const DEFAULT_RESEARCH_APP_ID = RESEARCH_APP_ID;
export const DEFAULT_RESEARCH_APP_NAME = "Research";

export function isResearchAppId(appId: string): boolean {
  const normalized = appId.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized === RESEARCH_APP_ID ||
    normalized.startsWith(RESEARCH_APP_ID_PREFIX)
  );
}
