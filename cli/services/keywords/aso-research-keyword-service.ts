import {
  DEFAULT_RESEARCH_APP_ID,
  DEFAULT_RESEARCH_APP_NAME,
} from "../../shared/aso-research";
import { createAppKeywords } from "../../db/app-keywords";
import { getAppById, upsertApps } from "../../db/apps";

export function saveKeywordsToDefaultResearchApp(
  keywords: string[],
  country: string
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

  if (!getAppById(DEFAULT_RESEARCH_APP_ID)) {
    upsertApps([
      {
        id: DEFAULT_RESEARCH_APP_ID,
        name: DEFAULT_RESEARCH_APP_NAME,
      },
    ]);
  }

  createAppKeywords(DEFAULT_RESEARCH_APP_ID, normalized, country);
  return normalized.length;
}
