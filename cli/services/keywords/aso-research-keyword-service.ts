import {
  DEFAULT_RESEARCH_APP_ID,
  DEFAULT_RESEARCH_APP_NAME,
} from "../../shared/aso-research";
import { createAppKeywords } from "../../db/app-keywords";
import { getAppById, upsertApps } from "../../db/apps";

function resolveTargetAppId(appId: string): string {
  const normalizedAppId = appId.trim() || DEFAULT_RESEARCH_APP_ID;
  const idPrefixedNumeric = normalizedAppId.match(/^id(\d+)$/i);
  if (!idPrefixedNumeric) {
    return normalizedAppId;
  }

  const numericAppId = idPrefixedNumeric[1];
  if (getAppById(numericAppId)) {
    return numericAppId;
  }

  return `id${numericAppId}`;
}

export function saveKeywordsToResearchApp(
  keywords: string[],
  country: string,
  appId: string = DEFAULT_RESEARCH_APP_ID
): number {
  if (keywords.length === 0) {
    return 0;
  }

  const normalized = Array.from(
    new Set(
      keywords
        .map((keyword) => keyword.trim().toLowerCase())
        .filter((keyword) => keyword.length > 0)
    )
  );
  if (normalized.length === 0) {
    return 0;
  }

  const targetAppId = resolveTargetAppId(appId);
  if (!getAppById(targetAppId)) {
    const appName =
      targetAppId === DEFAULT_RESEARCH_APP_ID
        ? DEFAULT_RESEARCH_APP_NAME
        : targetAppId;
    upsertApps([
      {
        id: targetAppId,
        name: appName,
      },
    ]);
  }

  createAppKeywords(targetAppId, normalized, country);
  return normalized.length;
}

export function saveKeywordsToDefaultResearchApp(
  keywords: string[],
  country: string
): number {
  return saveKeywordsToResearchApp(keywords, country, DEFAULT_RESEARCH_APP_ID);
}
