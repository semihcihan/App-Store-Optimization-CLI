import * as http from "http";
import { logger } from "../../utils/logger";
import { getKeyword } from "../../db/aso-keywords";
import {
  getCompetitorAppDocs,
  upsertCompetitorAppDocs,
} from "../../db/aso-apps";
import {
  getAsoAppDocsLocal,
  refreshAsoKeywordOrderLocal,
} from "../../services/keywords/aso-local-cache-service";
import { chunkArray, getMissingOrExpiredAppIds } from "../refresh-utils";
import {
  DEFAULT_ASO_COUNTRY,
  normalizeCountry,
} from "../../domain/keywords/policy";
import type { AsoApiAppDoc, AsoRouteDeps } from "./aso-route-types";

const ASO_APP_DOCS_MAX_BATCH_SIZE = 50;
const ASO_APP_SEARCH_DEFAULT_LIMIT = 20;
const ASO_APP_SEARCH_MAX_LIMIT = 50;
const ASO_APP_SEARCH_FALLBACK_WARNING = "Search failed";

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
    country: incoming.country || existing?.country || DEFAULT_ASO_COUNTRY,
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
  appIds: string[],
  options?: { forceLookup?: boolean }
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
    forceLookup: options?.forceLookup === true,
  });

  for (const chunk of idChunks) {
    const docs =
      options == null
        ? await getAsoAppDocsLocal(country, chunk)
        : await getAsoAppDocsLocal(country, chunk, options);
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
    forceLookup: options?.forceLookup === true,
  });
  return ordered;
}

export function createAppDocHandlers(deps: AsoRouteDeps) {
  async function handleApiAsoAppsSearchGet(
    res: http.ServerResponse,
    query: Record<string, string>
  ): Promise<void> {
    const country = normalizeCountry(query.country);
    const term = (query.term ?? "").trim();
    const requestedLimit = Number.parseInt(
      query.limit ?? String(ASO_APP_SEARCH_DEFAULT_LIMIT),
      10
    );
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, ASO_APP_SEARCH_MAX_LIMIT)
      : ASO_APP_SEARCH_DEFAULT_LIMIT;

    logger.debug("[aso-dashboard] request", {
      method: "GET",
      path: "/api/aso/apps/search",
      country,
      term,
      limit,
    });

    if (!term) {
      deps.sendJson(res, 200, { success: true, data: { term: "", appDocs: [] } });
      return;
    }

    const isNumericTerm = /^\d+$/.test(term);
    let orderedAppIds: string[] = [];
    let searchPageAppDocs: Array<{
      appId: string;
      name: string;
      icon?: Record<string, unknown>;
      iconArtwork?: { url?: string; [key: string]: unknown };
    }> = [];
    try {
      const orderData = await refreshAsoKeywordOrderLocal(country, term);
      orderedAppIds = orderData.orderedAppIds;
      searchPageAppDocs = [];
      for (const doc of orderData.appDocs ?? []) {
        const appId = `${doc.appId ?? ""}`.trim();
        if (!appId) continue;
        searchPageAppDocs.push({
          appId,
          name: doc.name?.trim() || appId,
          icon:
            doc.icon && typeof doc.icon === "object"
              ? (doc.icon as Record<string, unknown>)
              : undefined,
          iconArtwork:
            doc.iconArtwork && typeof doc.iconArtwork === "object"
              ? (doc.iconArtwork as { url?: string; [key: string]: unknown })
              : undefined,
        });
      }
    } catch (error) {
      deps.reportDashboardError(error, {
        method: "GET",
        path: "/api/aso/apps/search",
        country,
        term,
        context: "apps-search-order",
      });
    }

    const docsById = new Map(
      searchPageAppDocs.map((doc) => [doc.appId, doc] as const)
    );
    const orderOnlyFallback =
      orderedAppIds.length > 0 && searchPageAppDocs.length === 0;

    if (orderOnlyFallback) {
      logger.debug("[aso-dashboard] response", {
        method: "GET",
        path: "/api/aso/apps/search",
        status: 200,
        term,
        idsCount: orderedAppIds.length,
        appDocCount: 0,
        mode: "order-only-fallback",
      });
      deps.sendJson(res, 200, {
        success: true,
        data: {
          term,
          appDocs: [],
          warning: ASO_APP_SEARCH_FALLBACK_WARNING,
        },
      });
      return;
    }

    const appDocs: Array<{
      appId: string;
      name: string;
      icon?: Record<string, unknown>;
      iconArtwork?: { url?: string; [key: string]: unknown };
    }> = [];
    const seen = new Set<string>();
    const appendDoc = (doc: {
      appId: string;
      name: string;
      icon?: Record<string, unknown>;
      iconArtwork?: { url?: string; [key: string]: unknown };
    }) => {
      if (appDocs.length >= limit) return;
      if (!doc.appId || seen.has(doc.appId)) return;
      seen.add(doc.appId);
      appDocs.push(doc);
    };

    if (isNumericTerm) {
      const existing = docsById.get(term);
      if (existing) {
        appendDoc(existing);
      } else {
        appendDoc({
          appId: term,
          name: term,
        });
      }
    }

    for (const appId of orderedAppIds) {
      const doc = docsById.get(appId);
      if (!doc) continue;
      appendDoc(doc);
      if (appDocs.length >= limit) break;
    }

    if (appDocs.length === 0) {
      deps.sendJson(res, 200, { success: true, data: { term, appDocs: [] } });
      return;
    }

    logger.debug("[aso-dashboard] response", {
      method: "GET",
      path: "/api/aso/apps/search",
      status: 200,
      term,
      idsCount: orderedAppIds.length,
      appDocCount: appDocs.length,
    });
    deps.sendJson(res, 200, {
      success: true,
      data: {
        term,
        appDocs,
      },
    });
  }

  async function handleApiAsoTopAppsGet(
    res: http.ServerResponse,
    query: Record<string, string>
  ): Promise<void> {
    const country = normalizeCountry(query.country);
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
        logger.debug("[aso-dashboard] response <- local-backend", {
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
    const country = normalizeCountry(query.country);
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

    const docs = getCompetitorAppDocs(country, ids);
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

    return fetchAsoAppDocsFromApi(country, staleIds, { forceLookup: true })
      .then((lookupDocs) => {
        if (lookupDocs.length > 0) {
          const cachedById = new Map(docs.map((doc) => [doc.appId, doc]));
          upsertCompetitorAppDocs(
            country,
            lookupDocs.map((doc) => {
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
        const merged = getCompetitorAppDocs(country, ids);
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
    handleApiAsoAppsSearchGet,
    handleApiAsoTopAppsGet,
    handleApiAsoAppsGet,
  };
}
