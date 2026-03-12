import * as http from "http";
import { logger } from "../../utils/logger";
import { listKeywords, getKeyword } from "../../db/aso-keywords";
import {
  listKeywordFailuresForApp,
  getKeywordFailures,
  deleteKeywordFailures,
} from "../../db/aso-keyword-failures";
import {
  getCompetitorAppDocs,
  getOwnedAppDocs,
  upsertCompetitorAppDocs,
  upsertOwnedAppDocs,
} from "../../db/aso-apps";
import {
  listAllAppKeywords,
  listByApp,
  createAppKeywords,
  deleteAppKeywords,
} from "../../db/app-keywords";
import {
  normalizeKeywords,
  fetchAndPersistKeywordPopularityStage,
  enrichAndPersistKeywords,
  refreshAndPersistKeywordOrder,
} from "../../services/keywords/aso-keyword-service";
import { isAsoAuthReauthRequiredError } from "../../services/keywords/aso-popularity-service";
import { getAsoAppDocsLocal } from "../../services/keywords/aso-local-cache-service";
import { DEFAULT_RESEARCH_APP_ID } from "../../shared/aso-research";
import {
  ASO_MAX_KEYWORDS,
  ASO_MAX_KEYWORDS_PER_REQUEST_ERROR,
} from "../../shared/aso-keyword-limits";
import { chunkArray, getMissingOrExpiredAppIds } from "../refresh-utils";

const ASO_APP_DOCS_MAX_BATCH_SIZE = 50;

type AsoApiAppDoc = {
  appId: string;
  country: string;
  name: string;
  subtitle?: string;
  averageUserRating: number;
  userRatingCount: number;
  releaseDate?: string | null;
  currentVersionReleaseDate?: string | null;
  icon?: Record<string, unknown>;
  iconArtwork?: { url?: string; [key: string]: unknown };
  expiresAt?: string;
};

type UserSafeError = {
  errorCode: string;
  message: string;
};

type AsoRouteDeps = {
  parseJsonBody: <T>(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) => Promise<T | null>;
  sendJson: (res: http.ServerResponse, status: number, data: unknown) => void;
  sendApiError: (
    res: http.ServerResponse,
    status: number,
    errorCode: string,
    message: string
  ) => void;
  reportDashboardError: (
    error: unknown,
    metadata: Record<string, unknown>
  ) => void;
  toUserSafeError: (error: unknown, fallback: string) => UserSafeError;
  statusForDashboardErrorCode: (errorCode: string) => number;
  isDashboardAuthInProgress: () => boolean;
  isTruthyQueryParam: (value: string | undefined) => boolean;
};

function mergeHydratedCompetitorDoc(
  existing: AsoApiAppDoc | undefined,
  incoming: AsoApiAppDoc
): AsoApiAppDoc {
  const releaseDate = incoming.releaseDate ?? existing?.releaseDate ?? null;
  const currentVersionReleaseDate =
    incoming.currentVersionReleaseDate ?? existing?.currentVersionReleaseDate ?? null;
  const hasCompleteDates = Boolean(releaseDate && currentVersionReleaseDate);
  return {
    appId: incoming.appId,
    country: incoming.country || existing?.country || "US",
    name: incoming.name || existing?.name || incoming.appId,
    subtitle:
      incoming.subtitle && incoming.subtitle.trim() !== ""
        ? incoming.subtitle
        : existing?.subtitle,
    averageUserRating: incoming.averageUserRating,
    userRatingCount: incoming.userRatingCount,
    releaseDate,
    currentVersionReleaseDate,
    icon: incoming.icon ?? existing?.icon,
    iconArtwork: incoming.iconArtwork ?? existing?.iconArtwork,
    expiresAt: hasCompleteDates ? incoming.expiresAt ?? existing?.expiresAt : undefined,
  };
}

export async function fetchAsoAppDocsFromApi(
  country: string,
  appIds: string[]
): Promise<AsoApiAppDoc[]> {
  if (appIds.length === 0) return [];
  const uniqueIds = Array.from(new Set(appIds.map((id) => id.trim()).filter(Boolean)));
  if (uniqueIds.length === 0) return [];
  const startedAt = Date.now();
  const idChunks = chunkArray(uniqueIds, ASO_APP_DOCS_MAX_BATCH_SIZE);
  const docsById = new Map<string, AsoApiAppDoc>();

  logger.debug("[aso-dashboard] request -> local-backend", {
    country,
    appIdsCount: uniqueIds.length,
    chunkCount: idChunks.length,
  });

  for (const chunk of idChunks) {
    const docs = await getAsoAppDocsLocal(country, chunk);
    for (const doc of docs) {
      if (doc?.appId) {
        docsById.set(doc.appId, {
          ...doc,
          country: (doc.country ?? country).toUpperCase(),
        });
      }
    }
  }

  const ordered = uniqueIds
    .map((id) => docsById.get(id))
    .filter((doc): doc is AsoApiAppDoc => doc != null);

  logger.debug("[aso-dashboard] response <- local-backend", {
    durationMs: Date.now() - startedAt,
    appDocCount: ordered.length,
    appIdsCount: uniqueIds.length,
    chunkCount: idChunks.length,
  });
  return ordered;
}

export function createAsoRouteHandlers(deps: AsoRouteDeps) {
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
    const keywords = normalizeKeywords(rawKeywords);
    const country = (body.country ?? "US").toUpperCase();
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
        await fetchAndPersistKeywordPopularityStage(country, keywordsToAdd, {
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
          logger.debug("[aso-dashboard] request -> backend", {
            method: "POST",
            path: "/aso/enrich",
            country,
            itemCount: pendingItems.length,
          });
          backgroundTasks.push(
            enrichAndPersistKeywords(country, pendingItems)
              .catch((err) => {
                deps.reportDashboardError(err, {
                  method: "POST",
                  path: "/aso/enrich",
                  country,
                  itemCount: pendingItems.length,
                  phase: "background-enrichment",
                });
                logger.debug("[aso-dashboard] response <- backend", {
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
                logger.debug("[aso-dashboard] response <- backend", {
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
          logger.debug("[aso-dashboard] request -> backend", {
            method: "POST",
            path: "/aso/order-refresh",
            country,
            keywordCount: orderRefreshKeywords.length,
          });
          backgroundTasks.push(
            refreshAndPersistKeywordOrder(country, orderRefreshKeywords)
              .catch((err) => {
                deps.reportDashboardError(err, {
                  method: "POST",
                  path: "/aso/order-refresh",
                  country,
                  keywordCount: orderRefreshKeywords.length,
                  phase: "background-order-refresh",
                });
                logger.debug("[aso-dashboard] response <- backend", {
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
                logger.debug("[aso-dashboard] response <- backend", {
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
    const country = (body.country ?? "US").toUpperCase();
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
    const country = (body.country ?? "US").toUpperCase();

    if (deps.isDashboardAuthInProgress()) {
      deps.sendApiError(
        res,
        409,
        "AUTH_IN_PROGRESS",
        "Reauthentication is in progress. Finish it in terminal and retry."
      );
      return;
    }

    const failures = listKeywordFailuresForApp(appId, country);
    const keywordsToRetry = Array.from(
      new Set(failures.map((failure) => failure.keyword))
    );
    if (keywordsToRetry.length === 0) {
      deps.sendJson(res, 200, {
        success: true,
        data: {
          retriedCount: 0,
          succeededCount: 0,
          failedCount: 0,
        },
      });
      return;
    }

    try {
      const stageResult = await fetchAndPersistKeywordPopularityStage(
        country,
        keywordsToRetry,
        { allowInteractiveAuthRecovery: false }
      );
      const [enrichedResult, orderRefreshedItems] = await Promise.all([
        enrichAndPersistKeywords(country, stageResult.pendingItems),
        refreshAndPersistKeywordOrder(country, stageResult.orderRefreshKeywords),
      ]);
      const succeededKeywords = [
        ...stageResult.hits.map((item) => item.keyword),
        ...orderRefreshedItems.map((item) => item.keyword),
        ...enrichedResult.items.map((item) => item.keyword),
      ];
      if (succeededKeywords.length > 0) {
        deleteKeywordFailures(country, succeededKeywords);
      }
      const failedCount =
        stageResult.failedKeywords.length + enrichedResult.failedKeywords.length;
      deps.sendJson(res, 200, {
        success: true,
        data: {
          retriedCount: keywordsToRetry.length,
          succeededCount: succeededKeywords.length,
          failedCount,
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
    const country = (query.country ?? "US").toUpperCase();
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

  async function handleApiAsoTopAppsGet(
    res: http.ServerResponse,
    query: Record<string, string>
  ): Promise<void> {
    const country = (query.country ?? "US").toUpperCase();
    const keyword = query.keyword ?? "";
    if (!keyword.trim()) {
      deps.sendApiError(res, 400, "INVALID_REQUEST", "Keyword is required.");
      return;
    }
    const requestedLimit = Number.parseInt(query.limit ?? "10", 10);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 50)
      : 10;
    const decoded = keyword.trim();
    logger.debug("[aso-dashboard] request", {
      method: "GET",
      path: "/api/aso/top-apps",
      country,
      keyword: decoded,
      limit,
    });
    const kw = getKeyword(country, decoded);
    if (!kw) {
      deps.sendApiError(res, 404, "NOT_FOUND", "Keyword not found.");
      return;
    }
    const topIds = kw.orderedAppIds.slice(0, limit);
    let appDocs = getCompetitorAppDocs(country, topIds);
    const cachedById = new Map(appDocs.map((doc) => [doc.appId, doc]));
    const missingIds = getMissingOrExpiredAppIds(topIds, appDocs);
    if (missingIds.length > 0) {
      try {
        const fetchedDocs = await fetchAsoAppDocsFromApi(country, missingIds);
        if (fetchedDocs.length > 0) {
          upsertCompetitorAppDocs(
            country,
            fetchedDocs.map((doc) => {
              const merged = mergeHydratedCompetitorDoc(cachedById.get(doc.appId), {
                ...doc,
                averageUserRating: doc.averageUserRating ?? 0,
                userRatingCount: doc.userRatingCount ?? 0,
              });
              return {
                appId: merged.appId,
                name: merged.name,
                subtitle: merged.subtitle,
                averageUserRating: merged.averageUserRating,
                userRatingCount: merged.userRatingCount,
                releaseDate: merged.releaseDate ?? null,
                currentVersionReleaseDate: merged.currentVersionReleaseDate ?? null,
                icon: merged.icon,
                iconArtwork: merged.iconArtwork,
                expiresAt: merged.expiresAt,
              };
            })
          );
        }
        appDocs = getCompetitorAppDocs(country, topIds);
      } catch (err) {
        deps.reportDashboardError(err, {
          method: "POST",
          path: "/aso/app-docs",
          country,
          appIdsCount: missingIds.length,
          context: "top-apps-hydration",
        });
        logger.debug("[aso-dashboard] response <- backend", {
          method: "POST",
          path: "/aso/app-docs",
          status: 500,
          country,
          appIdsCount: missingIds.length,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    appDocs = getCompetitorAppDocs(country, topIds);
    logger.debug("[aso-dashboard] response", {
      method: "GET",
      path: "/api/aso/top-apps",
      status: 200,
      appDocCount: appDocs.length,
    });
    deps.sendJson(res, 200, { success: true, data: { keyword: kw.keyword, appDocs } });
  }

  function handleApiAsoAppsGet(
    res: http.ServerResponse,
    query: Record<string, string>
  ): Promise<void> {
    const country = (query.country ?? "US").toUpperCase();
    const forceRefresh = deps.isTruthyQueryParam(query.refresh);
    const ids = Array.from(
      new Set(
        (query.ids ?? "")
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean)
      )
    );
    logger.debug("[aso-dashboard] request", {
      method: "GET",
      path: "/api/aso/apps",
      country,
      idsCount: ids.length,
      forceRefresh,
    });
    if (ids.length === 0) {
      deps.sendJson(res, 200, { success: true, data: [] });
      return Promise.resolve();
    }

    const docs = getOwnedAppDocs(country, ids);
    const staleIds = forceRefresh ? ids : getMissingOrExpiredAppIds(ids, docs);

    if (staleIds.length === 0) {
      logger.debug("[aso-dashboard] response", {
        method: "GET",
        path: "/api/aso/apps",
        status: 200,
        appDocCount: docs.length,
        staleIdsCount: 0,
      });
      deps.sendJson(res, 200, { success: true, data: docs });
      return Promise.resolve();
    }

    return fetchAsoAppDocsFromApi(country, staleIds)
      .then((lookupDocs) => {
        if (lookupDocs.length > 0) {
          upsertOwnedAppDocs(country, lookupDocs);
        }
        const merged = getOwnedAppDocs(country, ids);
        logger.debug("[aso-dashboard] response", {
          method: "GET",
          path: "/api/aso/apps",
          status: 200,
          appDocCount: merged.length,
          staleIdsCount: staleIds.length,
          fetchedCount: lookupDocs.length,
          forceRefresh,
        });
        deps.sendJson(res, 200, { success: true, data: merged });
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        deps.reportDashboardError(err, {
          method: "GET",
          path: "/api/aso/apps",
          country,
          idsCount: ids.length,
          staleIdsCount: staleIds.length,
        });
        logger.debug("[aso-dashboard] response", {
          method: "GET",
          path: "/api/aso/apps",
          status: 200,
          appDocCount: docs.length,
          staleIdsCount: staleIds.length,
          fallback: true,
          forceRefresh,
          error: message,
        });
        deps.sendJson(res, 200, { success: true, data: docs });
      });
  }

  return {
    handleApiAsoKeywordsPost,
    handleApiAsoKeywordsDelete,
    handleApiAsoKeywordsRetryFailedPost,
    handleApiAsoKeywordsGet,
    handleApiAsoTopAppsGet,
    handleApiAsoAppsGet,
  };
}
