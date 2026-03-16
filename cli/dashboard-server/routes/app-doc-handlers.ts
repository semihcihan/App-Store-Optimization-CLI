import * as http from "http";
import { logger } from "../../utils/logger";
import { getKeyword } from "../../db/aso-keywords";
import {
  getCompetitorAppDocs,
  getOwnedAppDocs,
  upsertCompetitorAppDocs,
  upsertOwnedAppDocs,
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
import { readAsoEnv } from "../../shared/aso-env";
import type { AsoApiAppDoc, AsoRouteDeps } from "./aso-route-types";

const ASO_APP_DOCS_MAX_BATCH_SIZE = 50;
const ASO_APP_SEARCH_DEFAULT_LIMIT = 20;
const ASO_APP_SEARCH_MAX_LIMIT = 50;
function getStaleOwnedAppIds(
  orderedIds: string[],
  docs: Array<{
    appId: string;
    expiresAt?: string;
    releaseDate?: string | null;
    currentVersionReleaseDate?: string | null;
    lastFetchedAt?: string | null;
  }>,
  nowMs: number = Date.now()
): string[] {
  const refreshMaxAgeMs = readAsoEnv().ownedAppDocRefreshMaxAgeMs;
  const missingOrExpired = new Set(getMissingOrExpiredAppIds(orderedIds, docs, nowMs));
  const byId = new Map(docs.map((doc) => [doc.appId, doc]));
  const staleIds: string[] = [];

  for (const appId of orderedIds) {
    if (missingOrExpired.has(appId)) {
      staleIds.push(appId);
      continue;
    }
    const doc = byId.get(appId);
    const fetchedAtMs = Date.parse(doc?.lastFetchedAt ?? "");
    if (!Number.isFinite(fetchedAtMs) || nowMs - fetchedAtMs >= refreshMaxAgeMs) {
      staleIds.push(appId);
    }
  }
  return staleIds;
}

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

    const candidateIds: string[] = [];
    if (/^\d+$/.test(term)) {
      candidateIds.push(term);
    }

    try {
      const orderData = await refreshAsoKeywordOrderLocal(country, term);
      candidateIds.push(...orderData.orderedAppIds);
    } catch (error) {
      deps.reportDashboardError(error, {
        method: "GET",
        path: "/api/aso/apps/search",
        country,
        term,
        context: "apps-search-order",
      });
    }

    const ids = Array.from(new Set(candidateIds)).slice(0, limit);
    if (ids.length === 0) {
      deps.sendJson(res, 200, { success: true, data: { term, appDocs: [] } });
      return;
    }

    try {
      const docs = await fetchAsoAppDocsFromApi(country, ids);
      const appDocs = docs.map((doc) => ({
        appId: doc.appId,
        name: doc.name,
        icon: doc.icon,
        iconArtwork: doc.iconArtwork,
      }));
      logger.debug("[aso-dashboard] response", {
        method: "GET",
        path: "/api/aso/apps/search",
        status: 200,
        term,
        idsCount: ids.length,
        appDocCount: appDocs.length,
      });
      deps.sendJson(res, 200, {
        success: true,
        data: {
          term,
          appDocs,
        },
      });
    } catch (error) {
      deps.reportDashboardError(error, {
        method: "GET",
        path: "/api/aso/apps/search",
        country,
        term,
        idsCount: ids.length,
        context: "apps-search-hydration",
      });
      deps.sendApiError(res, 500, "NETWORK_ERROR", "Failed to search apps.");
    }
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

    const docs = getOwnedAppDocs(country, ids);
    const staleIds = forceRefresh ? ids : getStaleOwnedAppIds(ids, docs);

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
    handleApiAsoAppsSearchGet,
    handleApiAsoTopAppsGet,
    handleApiAsoAppsGet,
  };
}
