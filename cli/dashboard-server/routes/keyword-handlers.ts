import * as http from "http";
import { logger } from "../../utils/logger";
import { listKeywords } from "../../db/aso-keywords";
import { getKeywordFailures } from "../../db/aso-keyword-failures";
import {
  listAllAppKeywords,
  listByApp,
  createAppKeywords,
  deleteAppKeywords,
} from "../../db/app-keywords";
import { keywordPipelineService } from "../../services/keywords/keyword-pipeline-service";
import { isAsoAuthReauthRequiredError } from "../../services/keywords/aso-popularity-service";
import { DEFAULT_RESEARCH_APP_ID } from "../../shared/aso-research";
import {
  ASO_MAX_KEYWORDS,
  ASO_MAX_KEYWORDS_PER_REQUEST_ERROR,
} from "../../shared/aso-keyword-limits";
import { normalizeCountry } from "../../domain/keywords/policy";
import type { AsoRouteDeps } from "./aso-route-types";

export function createKeywordHandlers(deps: AsoRouteDeps) {
  async function handleApiAsoKeywordsPost(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const body = await deps.parseJsonBody<{
      appId?: string;
      keywords?: string[];
      country?: string;
    }>(req, res);
    if (!body) {
      return;
    }
    const appId = body.appId ?? DEFAULT_RESEARCH_APP_ID;
    const rawKeywords = body.keywords ?? [];
    const keywords = keywordPipelineService.normalizeKeywords(rawKeywords);
    const country = normalizeCountry(body.country);
    const startedAt = Date.now();
    if (keywords.length === 0) {
      deps.sendApiError(
        res,
        400,
        "INVALID_REQUEST",
        "Please provide at least one keyword."
      );
      return;
    }
    if (keywords.length > ASO_MAX_KEYWORDS) {
      deps.sendApiError(
        res,
        400,
        "INVALID_REQUEST",
        ASO_MAX_KEYWORDS_PER_REQUEST_ERROR
      );
      return;
    }
    const existingForApp = new Set(
      listByApp(appId, country).map((row) => row.keyword.trim().toLowerCase())
    );
    const keywordsToAdd = keywords.filter((keyword) => !existingForApp.has(keyword));
    logger.debug("[aso-dashboard] request", {
      method: "POST",
      path: "/api/aso/keywords",
      appId,
      country,
      keywordCount: keywordsToAdd.length,
      requestedKeywordCount: keywords.length,
    });

    if (keywordsToAdd.length === 0) {
      deps.sendJson(res, 201, {
        success: true,
        data: {
          cachedCount: 0,
          pendingCount: 0,
          failedCount: 0,
        },
      });
      logger.debug("[aso-dashboard] response", {
        method: "POST",
        path: "/api/aso/keywords",
        status: 201,
        durationMs: Date.now() - startedAt,
        cachedCount: 0,
        pendingCount: 0,
        skippedExistingCount: keywords.length,
      });
      return;
    }

    if (deps.isDashboardAuthInProgress()) {
      deps.sendApiError(
        res,
        409,
        "AUTH_IN_PROGRESS",
        "Reauthentication is in progress. Finish it in terminal and retry."
      );
      return;
    }

    try {
      const { hits, pendingItems, orderRefreshKeywords, failedKeywords } =
        await keywordPipelineService.runPopularityStage(country, keywordsToAdd, {
          allowInteractiveAuthRecovery: false,
        });
      createAppKeywords(appId, keywordsToAdd, country);
      const pendingCount = pendingItems.length + orderRefreshKeywords.length;

      deps.sendJson(res, 201, {
        success: true,
        data: {
          cachedCount: hits.length,
          pendingCount,
          failedCount: failedKeywords.length,
        },
      });
      logger.debug("[aso-dashboard] response", {
        method: "POST",
        path: "/api/aso/keywords",
        status: 201,
        durationMs: Date.now() - startedAt,
        cachedCount: hits.length,
        pendingCount,
        failedCount: failedKeywords.length,
      });

      if (pendingItems.length > 0 || orderRefreshKeywords.length > 0) {
        const backgroundTasks: Array<Promise<unknown>> = [];

        if (pendingItems.length > 0) {
          logger.debug("[aso-dashboard] request -> local-backend", {
            method: "POST",
            path: "/aso/enrich",
            country,
            itemCount: pendingItems.length,
          });
          backgroundTasks.push(
            keywordPipelineService
              .enrichAndPersist(country, pendingItems)
              .catch((err) => {
                deps.reportDashboardError(err, {
                  method: "POST",
                  path: "/aso/enrich",
                  country,
                  itemCount: pendingItems.length,
                  phase: "background-enrichment",
                });
                logger.debug("[aso-dashboard] response <- local-backend", {
                  method: "POST",
                  path: "/aso/enrich",
                  status: 500,
                  country,
                  error: err instanceof Error ? err.message : String(err),
                });
                const message = err instanceof Error ? err.message : String(err);
                logger.error(
                  `ASO dashboard enrichment failed for ${pendingItems.length} keyword(s): ${message}`
                );
                return null;
              })
              .then((items) => {
                if (!items) return null;
                logger.debug("[aso-dashboard] response <- local-backend", {
                  method: "POST",
                  path: "/aso/enrich",
                  status: 200,
                  country,
                  itemCount: items.items.length,
                  failedCount: items.failedKeywords.length,
                });
                return items;
              })
          );
        }

        if (orderRefreshKeywords.length > 0) {
          logger.debug("[aso-dashboard] request -> local-backend", {
            method: "POST",
            path: "/aso/order-refresh",
            country,
            keywordCount: orderRefreshKeywords.length,
          });
          backgroundTasks.push(
            keywordPipelineService
              .refreshOrder(country, orderRefreshKeywords)
              .catch((err) => {
                deps.reportDashboardError(err, {
                  method: "POST",
                  path: "/aso/order-refresh",
                  country,
                  keywordCount: orderRefreshKeywords.length,
                  phase: "background-order-refresh",
                });
                logger.debug("[aso-dashboard] response <- local-backend", {
                  method: "POST",
                  path: "/aso/order-refresh",
                  status: 500,
                  country,
                  error: err instanceof Error ? err.message : String(err),
                });
                const message = err instanceof Error ? err.message : String(err);
                logger.error(
                  `ASO dashboard order refresh failed for ${orderRefreshKeywords.length} keyword(s): ${message}`
                );
                return null;
              })
              .then((items) => {
                if (!items) return null;
                logger.debug("[aso-dashboard] response <- local-backend", {
                  method: "POST",
                  path: "/aso/order-refresh",
                  status: 200,
                  country,
                  keywordCount: items.length,
                });
                return items;
              })
          );
        }

        void Promise.all(backgroundTasks);
      }
    } catch (err) {
      if (isAsoAuthReauthRequiredError(err)) {
        deps.sendApiError(
          res,
          401,
          "AUTH_REQUIRED",
          "Apple Search Ads session expired. Reauthenticate from the dashboard and retry."
        );
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      const publicError = deps.toUserSafeError(err, "Failed to add keywords");
      const responseStatus = deps.statusForDashboardErrorCode(publicError.errorCode);
      deps.reportDashboardError(err, {
        method: "POST",
        path: "/api/aso/keywords",
        appId,
        country,
        keywordCount: keywords.length,
      });
      logger.debug("[aso-dashboard] response", {
        method: "POST",
        path: "/api/aso/keywords",
        status: responseStatus,
        durationMs: Date.now() - startedAt,
        error: message,
      });
      deps.sendApiError(
        res,
        responseStatus,
        publicError.errorCode,
        publicError.message
      );
    }
  }

  async function handleApiAsoKeywordsDelete(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const body = await deps.parseJsonBody<{
      appId?: string;
      keywords?: string[];
      country?: string;
    }>(req, res);
    if (!body) {
      return;
    }
    const appId = body.appId ?? DEFAULT_RESEARCH_APP_ID;
    const keywords = body.keywords ?? [];
    const country = normalizeCountry(body.country);
    const startedAt = Date.now();
    logger.debug("[aso-dashboard] request", {
      method: "DELETE",
      path: "/api/aso/keywords",
      appId,
      country,
      keywordCount: keywords.length,
    });
    if (keywords.length === 0) {
      deps.sendApiError(
        res,
        400,
        "INVALID_REQUEST",
        "Please provide at least one keyword."
      );
      return;
    }
    try {
      const removedCount = deleteAppKeywords(appId, keywords, country);
      logger.debug("[aso-dashboard] response", {
        method: "DELETE",
        path: "/api/aso/keywords",
        status: 200,
        durationMs: Date.now() - startedAt,
        removedCount,
      });
      deps.sendJson(res, 200, { success: true, data: { removedCount } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const publicError = deps.toUserSafeError(err, "Failed to delete keywords");
      const responseStatus = deps.statusForDashboardErrorCode(publicError.errorCode);
      deps.reportDashboardError(err, {
        method: "DELETE",
        path: "/api/aso/keywords",
        appId,
        country,
        keywordCount: keywords.length,
      });
      logger.debug("[aso-dashboard] response", {
        method: "DELETE",
        path: "/api/aso/keywords",
        status: responseStatus,
        durationMs: Date.now() - startedAt,
        error: message,
      });
      deps.sendApiError(
        res,
        responseStatus,
        publicError.errorCode,
        publicError.message
      );
    }
  }

  async function handleApiAsoKeywordsRetryFailedPost(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const body = await deps.parseJsonBody<{ appId?: string; country?: string }>(
      req,
      res
    );
    if (!body) {
      return;
    }
    const appId = body.appId ?? DEFAULT_RESEARCH_APP_ID;
    const country = normalizeCountry(body.country);

    if (deps.isDashboardAuthInProgress()) {
      deps.sendApiError(
        res,
        409,
        "AUTH_IN_PROGRESS",
        "Reauthentication is in progress. Finish it in terminal and retry."
      );
      return;
    }

    try {
      const retryResult = await keywordPipelineService.retryFailed(appId, country);
      deps.sendJson(res, 200, {
        success: true,
        data: {
          retriedCount: retryResult.retriedCount,
          succeededCount: retryResult.succeededCount,
          failedCount: retryResult.failedCount,
        },
      });
    } catch (error) {
      if (isAsoAuthReauthRequiredError(error)) {
        deps.sendApiError(
          res,
          401,
          "AUTH_REQUIRED",
          "Apple Search Ads session expired. Reauthenticate from the dashboard and retry."
        );
        return;
      }
      const publicError = deps.toUserSafeError(
        error,
        "Failed to retry failed keywords"
      );
      deps.sendApiError(
        res,
        deps.statusForDashboardErrorCode(publicError.errorCode),
        publicError.errorCode,
        publicError.message
      );
    }
  }

  function handleApiAsoKeywordsGet(
    res: http.ServerResponse,
    query: Record<string, string>
  ): void {
    const country = normalizeCountry(query.country);
    const appId = query.appId;
    logger.debug("[aso-dashboard] request", {
      method: "GET",
      path: "/api/aso/keywords",
      country,
      appId: appId ?? null,
    });
    const keywords = listKeywords(country);
    const appKeywords = listAllAppKeywords(country);
    const byApp = new Map<string, string[]>();
    const byKeyword = new Map<string, typeof appKeywords>();
    const keywordByNormalized = new Map(
      keywords.map((keyword) => [keyword.normalizedKeyword, keyword] as const)
    );
    for (const ak of appKeywords) {
      const appKeywordsForApp = byApp.get(ak.appId);
      if (appKeywordsForApp) {
        appKeywordsForApp.push(ak.keyword);
      } else {
        byApp.set(ak.appId, [ak.keyword]);
      }

      const appAssociationsForKeyword = byKeyword.get(ak.keyword);
      if (appAssociationsForKeyword) {
        appAssociationsForKeyword.push(ak);
      } else {
        byKeyword.set(ak.keyword, [ak]);
      }
    }
    let filtered = keywords;
    let missingAssociatedKeywords: string[] = [];
    if (appId != null && appId !== "") {
      const kws = byApp.get(appId) ?? [];
      const set = new Set(kws.map((k) => k.trim().toLowerCase()));
      filtered = keywords.filter((k) => set.has(k.normalizedKeyword));
      missingAssociatedKeywords = Array.from(set).filter(
        (normalizedKeyword) => !keywordByNormalized.has(normalizedKeyword)
      );
    }
    const keywordFailures = getKeywordFailures(country, [
      ...filtered.map((item) => item.keyword),
      ...missingAssociatedKeywords,
    ]);
    const failureByKeyword = new Map(
      keywordFailures.map((failure) => [failure.normalizedKeyword, failure] as const)
    );
    const failedPlaceholders = missingAssociatedKeywords
      .map((normalizedKeyword) => {
        const failure = failureByKeyword.get(normalizedKeyword);
        if (!failure) return null;
        return {
          keyword: normalizedKeyword,
          normalizedKeyword,
          country,
          popularity: null,
          difficultyScore: null,
          minDifficultyScore: null,
          appCount: null,
          keywordIncluded: 0,
          orderedAppIds: [] as string[],
          createdAt: failure.updatedAt,
          updatedAt: failure.updatedAt,
          orderExpiresAt: failure.updatedAt,
          popularityExpiresAt: failure.updatedAt,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item != null);
    const withMeta = [...filtered, ...failedPlaceholders]
      .sort((a, b) => a.keyword.localeCompare(b.keyword, undefined, { sensitivity: "base" }))
      .map((k) => {
        const failure = failureByKeyword.get(k.normalizedKeyword) ?? null;
        const assocs = byKeyword.get(k.normalizedKeyword) ?? [];
        const positions = assocs.map((a) => ({
          appId: a.appId,
          previousPosition: a.previousPosition,
          currentPosition: (() => {
            const idx = k.orderedAppIds.indexOf(a.appId);
            return idx >= 0 ? idx + 1 : null;
          })(),
        }));
        return {
          ...k,
          keywordStatus: failure
            ? "failed"
            : k.difficultyScore == null
              ? "pending"
              : "ok",
          failure: failure
            ? {
                stage: failure.stage,
                reasonCode: failure.reasonCode,
                message: failure.message,
                statusCode: failure.statusCode,
                retryable: failure.retryable,
                attempts: failure.attempts,
                requestId: failure.requestId,
                updatedAt: failure.updatedAt,
              }
            : null,
          positions,
        };
      });
    logger.debug("[aso-dashboard] response", {
      method: "GET",
      path: "/api/aso/keywords",
      status: 200,
      keywordCount: withMeta.length,
    });
    deps.sendJson(res, 200, { success: true, data: withMeta });
  }

  return {
    handleApiAsoKeywordsPost,
    handleApiAsoKeywordsDelete,
    handleApiAsoKeywordsRetryFailedPost,
    handleApiAsoKeywordsGet,
  };
}
