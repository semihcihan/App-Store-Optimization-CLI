import * as http from "http";
import { getKeyword } from "../../db/aso-keywords";
import {
  getCompetitorAppDocs,
  upsertCompetitorAppDocs,
} from "../../db/aso-apps";
import {
  getAsoAppDocsLocal,
  refreshAsoKeywordOrderLocal,
} from "../../services/keywords/aso-local-cache-service";
import { keywordPipelineService } from "../../services/keywords/keyword-pipeline-service";
import { chunkArray, getMissingOrExpiredAppIds } from "../refresh-utils";
import {
  DEFAULT_ASO_COUNTRY,
  normalizeCountry,
} from "../../domain/keywords/policy";
import type { AsoApiAppDoc, AsoRouteDeps } from "./aso-route-types";
import { isStoredKeywordOrderFresh } from "../../shared/aso-keyword-validity";
import {
  fetchSensorTowerMetricsForApps,
  type SensorTowerAppMetrics,
} from "../../services/sensortower/sensortower-app-service";
import {
  getSensorTowerAppMetrics,
  upsertSensorTowerAppMetrics,
} from "../../db/sensor-tower-app-metrics";

const ASO_APP_DOCS_MAX_BATCH_SIZE = 50;
const ASO_APP_SEARCH_DEFAULT_LIMIT = 20;
const ASO_APP_SEARCH_MAX_LIMIT = 50;
const SENSOR_TOWER_METRICS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function isSensorTowerMetricsFresh(fetchedAt: string, nowMs: number): boolean {
  const fetchedAtMs = Date.parse(fetchedAt);
  return (
    Number.isFinite(fetchedAtMs) &&
    nowMs - fetchedAtMs < SENSOR_TOWER_METRICS_CACHE_TTL_MS
  );
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
    publisherName:
      incoming.publisherName && incoming.publisherName.trim() !== ""
        ? incoming.publisherName
        : existing?.publisherName,
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
  const idChunks = chunkArray(uniqueIds, ASO_APP_DOCS_MAX_BATCH_SIZE);
  const docsById = new Map<string, AsoApiAppDoc>();

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
      orderedAppIds =
        orderData.orderedAppIds ?? searchPageAppDocs.map((doc) => doc.appId);
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
    let keywordRow = getKeyword(country, decoded);
    if (!keywordRow) {
      deps.sendApiError(res, 404, "NOT_FOUND", "Keyword not found.");
      return;
    }
    if (!isStoredKeywordOrderFresh(keywordRow, Date.now())) {
      try {
        await keywordPipelineService.refreshOrder(country, [decoded], {
          preserveUpdatedAt: true,
        });
        const refreshed = getKeyword(country, decoded);
        if (refreshed) {
          keywordRow = refreshed;
        }
      } catch (error) {
        deps.reportDashboardError(error, {
          method: "GET",
          path: "/api/aso/top-apps",
          country,
          keyword: decoded,
          context: "top-apps-order-refresh",
        });
      }
    }

    const topIds = keywordRow.orderedAppIds.slice(0, limit);
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
                publisherName: merged.publisherName,
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
      }
    }
    appDocs = getCompetitorAppDocs(country, topIds);
    const metricAppIds = appDocs.map((doc) => doc.appId);
    let cachedSensorTowerMetrics: ReturnType<
      typeof getSensorTowerAppMetrics
    > = [];
    try {
      cachedSensorTowerMetrics = getSensorTowerAppMetrics(metricAppIds);
    } catch (error) {
      deps.reportDashboardError(error, {
        method: "GET",
        path: "/api/aso/top-apps",
        country,
        appIdsCount: metricAppIds.length,
        context: "top-apps-sensortower-cache-read",
      });
    }
    const sensorTowerMetrics = new Map<string, SensorTowerAppMetrics>(
      cachedSensorTowerMetrics.map((metrics) => [
        metrics.appId,
        {
          lastMonthDownloads: metrics.lastMonthDownloads,
          lastMonthRevenue: metrics.lastMonthRevenue,
        },
      ])
    );
    const cachedByAppId = new Map(
      cachedSensorTowerMetrics.map((metrics) => [metrics.appId, metrics] as const)
    );
    const nowMs = Date.now();
    const appIdsToRefresh = metricAppIds.filter((appId) => {
      const cached = cachedByAppId.get(appId);
      return !cached || !isSensorTowerMetricsFresh(cached.fetchedAt, nowMs);
    });

    if (appIdsToRefresh.length > 0) {
      try {
        const fetchedMetrics = await fetchSensorTowerMetricsForApps(
          appIdsToRefresh,
          (error, appIds) => {
            deps.reportDashboardError(error, {
              method: "GET",
              path: "/api/aso/top-apps",
              country,
              appIds,
              appIdsCount: appIds.length,
              context: "top-apps-sensortower-enrichment",
            });
          }
        );
        for (const [appId, metrics] of fetchedMetrics) {
          sensorTowerMetrics.set(appId, {
            ...(sensorTowerMetrics.get(appId) ?? {}),
            ...metrics,
          });
        }
        const completeMetrics = Array.from(fetchedMetrics.entries()).flatMap(
          ([appId, metrics]) => {
            const lastMonthDownloads = metrics.lastMonthDownloads;
            const lastMonthRevenue = metrics.lastMonthRevenue;
            if (!lastMonthDownloads || !lastMonthRevenue) return [];
            return [{ appId, lastMonthDownloads, lastMonthRevenue }];
          }
        );
        if (completeMetrics.length > 0) {
          try {
            upsertSensorTowerAppMetrics(completeMetrics);
          } catch (error) {
            deps.reportDashboardError(error, {
              method: "GET",
              path: "/api/aso/top-apps",
              country,
              appIdsCount: completeMetrics.length,
              context: "top-apps-sensortower-cache-write",
            });
          }
        }
      } catch (error) {
        deps.reportDashboardError(error, {
          method: "GET",
          path: "/api/aso/top-apps",
          country,
          appIdsCount: appIdsToRefresh.length,
          context: "top-apps-sensortower-enrichment",
        });
      }
    }
    deps.sendJson(res, 200, {
      success: true,
      data: {
        keyword: keywordRow.keyword,
        appDocs: appDocs.map((doc) => ({
          ...doc,
          ...(sensorTowerMetrics.get(doc.appId) ?? {}),
        })),
      },
    });
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
    if (ids.length === 0) {
      deps.sendJson(res, 200, { success: true, data: [] });
      return Promise.resolve();
    }

    const docs = getCompetitorAppDocs(country, ids);
    const staleIds = forceRefresh ? ids : getMissingOrExpiredAppIds(ids, docs);

    if (staleIds.length === 0) {
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
                publisherName: merged.publisherName,
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
        deps.sendJson(res, 200, { success: true, data: merged });
      })
      .catch((err) => {
        deps.reportDashboardError(err, {
          method: "GET",
          path: "/api/aso/apps",
          country,
          idsCount: ids.length,
          staleIdsCount: staleIds.length,
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
