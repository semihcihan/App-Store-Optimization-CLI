import * as http from "http";
import { logger } from "../../utils/logger";
import { listUnionKeywords, getCompareMatrix } from "../../db/app-compare";
import { getOwnedAppById } from "../../db/owned-apps";
import { normalizeCountry } from "../../domain/keywords/policy";
import {
  COMPARE_MAX_APPS,
  COMPARE_MAX_KEYWORDS,
  COMPARE_MIN_APPS,
  COMPARE_MIN_KEYWORDS,
  type CompareApp,
  type CompareKeywordsResponse,
  type CompareMatrixResponse,
} from "../../shared/compare-types";
import type { AsoRouteDeps } from "./aso-route-types";

function parseAppIdsQueryParam(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function resolveApps(
  appIds: string[],
  country: string
): { resolved: CompareApp[]; missing: string[] } {
  const resolved: CompareApp[] = [];
  const missing: string[] = [];
  for (const appId of appIds) {
    const app = getOwnedAppById(appId, country);
    if (!app) {
      missing.push(appId);
      continue;
    }
    resolved.push({ appId: app.id, name: app.name });
  }
  return { resolved, missing };
}

export function createCompareHandlers(deps: AsoRouteDeps) {
  function handleCompareKeywordsGet(
    res: http.ServerResponse,
    query: Record<string, string>
  ): void {
    const country = normalizeCountry(query.country);
    const appIds = dedupe(parseAppIdsQueryParam(query.appIds));

    if (appIds.length < COMPARE_MIN_APPS) {
      deps.sendApiError(
        res,
        400,
        "INVALID_REQUEST",
        `Please provide at least ${COMPARE_MIN_APPS} app IDs.`
      );
      return;
    }
    if (appIds.length > COMPARE_MAX_APPS) {
      deps.sendApiError(
        res,
        413,
        "TOO_MANY_APPS",
        `A maximum of ${COMPARE_MAX_APPS} apps can be compared at once.`
      );
      return;
    }

    const { resolved, missing } = resolveApps(appIds, country);
    if (missing.length > 0) {
      deps.sendApiError(
        res,
        404,
        "APP_NOT_FOUND",
        `Unknown app IDs: ${missing.join(", ")}`
      );
      return;
    }

    try {
      const rows = listUnionKeywords(appIds, country);
      const response: CompareKeywordsResponse = {
        country,
        apps: resolved,
        keywords: rows.map((row) => ({
          keyword: row.keyword,
          normalizedKeyword: row.normalizedKeyword,
          trackedByAppIds: row.trackedByAppIds,
          trackedCount: row.trackedCount,
          popularity: row.popularity,
          difficulty: row.difficulty,
          isResearched: row.isResearched,
        })),
      };
      logger.debug("[aso-dashboard] request", {
        method: "GET",
        path: "/api/aso/compare/keywords",
        country,
        appCount: appIds.length,
        keywordCount: rows.length,
      });
      deps.sendJson(res, 200, { success: true, data: response });
    } catch (error) {
      deps.reportDashboardError(error, {
        method: "GET",
        path: "/api/aso/compare/keywords",
        country,
        appIds,
      });
      const publicError = deps.toUserSafeError(
        error,
        "Failed to load compare keyword universe"
      );
      deps.sendApiError(
        res,
        deps.statusForDashboardErrorCode(publicError.errorCode),
        publicError.errorCode,
        publicError.message
      );
    }
  }

  async function handleCompareMatrixPost(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const body = await deps.parseJsonBody<{
      appIds?: string[];
      keywords?: string[];
      country?: string;
    }>(req, res);
    if (!body) {
      return;
    }

    const country = normalizeCountry(body.country);
    const appIds = dedupe(
      (body.appIds ?? [])
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter((value): value is string => value.length > 0)
    );
    const keywords = (body.keywords ?? []).filter(
      (value): value is string => typeof value === "string" && value.trim() !== ""
    );

    if (appIds.length < COMPARE_MIN_APPS) {
      deps.sendApiError(
        res,
        400,
        "INVALID_REQUEST",
        `Please provide at least ${COMPARE_MIN_APPS} app IDs.`
      );
      return;
    }
    if (appIds.length > COMPARE_MAX_APPS) {
      deps.sendApiError(
        res,
        413,
        "TOO_MANY_APPS",
        `A maximum of ${COMPARE_MAX_APPS} apps can be compared at once.`
      );
      return;
    }
    if (keywords.length < COMPARE_MIN_KEYWORDS) {
      deps.sendApiError(
        res,
        400,
        "INVALID_REQUEST",
        `Please provide at least ${COMPARE_MIN_KEYWORDS} keyword.`
      );
      return;
    }
    if (keywords.length > COMPARE_MAX_KEYWORDS) {
      deps.sendApiError(
        res,
        413,
        "TOO_MANY_KEYWORDS",
        `A maximum of ${COMPARE_MAX_KEYWORDS} keywords can be compared at once.`
      );
      return;
    }

    const { resolved, missing } = resolveApps(appIds, country);
    if (missing.length > 0) {
      deps.sendApiError(
        res,
        404,
        "APP_NOT_FOUND",
        `Unknown app IDs: ${missing.join(", ")}`
      );
      return;
    }

    try {
      const flatRows = getCompareMatrix(appIds, keywords, country);
      const rowMap = new Map<
        string,
        {
          keyword: string;
          normalizedKeyword: string;
          popularity: number | null;
          difficulty: number | null;
          isResearched: boolean;
          cells: Map<
            string,
            {
              currentPosition: number | null;
              previousPosition: number | null;
              isTracked: boolean;
            }
          >;
        }
      >();
      for (const row of flatRows) {
        const existing = rowMap.get(row.normalizedKeyword);
        if (existing) {
          existing.cells.set(row.appId, {
            currentPosition: row.currentPosition,
            previousPosition: row.previousPosition,
            isTracked: row.isTracked,
          });
          continue;
        }
        const cells = new Map<
          string,
          {
            currentPosition: number | null;
            previousPosition: number | null;
            isTracked: boolean;
          }
        >();
        cells.set(row.appId, {
          currentPosition: row.currentPosition,
          previousPosition: row.previousPosition,
          isTracked: row.isTracked,
        });
        rowMap.set(row.normalizedKeyword, {
          keyword: row.keyword,
          normalizedKeyword: row.normalizedKeyword,
          popularity: row.popularity,
          difficulty: row.difficulty,
          isResearched: row.isResearched,
          cells,
        });
      }

      const response: CompareMatrixResponse = {
        country,
        generatedAt: new Date().toISOString(),
        apps: resolved,
        rows: Array.from(rowMap.values()).map((row) => ({
          keyword: row.keyword,
          normalizedKeyword: row.normalizedKeyword,
          popularity: row.popularity,
          difficulty: row.difficulty,
          status: row.isResearched ? "researched" : "not_researched",
          cells: appIds.map((appId) => {
            const cell = row.cells.get(appId);
            const currentPosition = cell?.currentPosition ?? null;
            const previousPosition = cell?.previousPosition ?? null;
            const change =
              currentPosition != null && previousPosition != null
                ? previousPosition - currentPosition
                : null;
            return {
              appId,
              currentPosition,
              previousPosition,
              change,
              isTracked: cell?.isTracked ?? false,
            };
          }),
        })),
      };
      logger.debug("[aso-dashboard] request", {
        method: "POST",
        path: "/api/aso/compare/matrix",
        country,
        appCount: appIds.length,
        keywordCount: response.rows.length,
      });
      deps.sendJson(res, 200, { success: true, data: response });
    } catch (error) {
      deps.reportDashboardError(error, {
        method: "POST",
        path: "/api/aso/compare/matrix",
        country,
        appIds,
        keywordCount: keywords.length,
      });
      const publicError = deps.toUserSafeError(
        error,
        "Failed to load compare matrix"
      );
      deps.sendApiError(
        res,
        deps.statusForDashboardErrorCode(publicError.errorCode),
        publicError.errorCode,
        publicError.message
      );
    }
  }

  return {
    handleCompareKeywordsGet,
    handleCompareMatrixPost,
  };
}
