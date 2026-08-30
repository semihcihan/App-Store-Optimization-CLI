import * as http from "http";
import { logger } from "../../utils/logger";
import {
  listByApp,
  createAppKeywords,
  deleteAppKeywords,
  setAppKeywordFavorite,
} from "../../db/app-keywords";
import { listAppKeywordPositionHistory } from "../../db/app-keyword-position-history";
import { getDb } from "../../db/store";
import { keywordPipelineService } from "../../services/keywords/keyword-pipeline-service";
import { isAsoAuthReauthRequiredError } from "../../services/keywords/aso-popularity-service";
import { DEFAULT_RESEARCH_APP_ID } from "../../shared/aso-research";
import {
  ASO_MAX_KEYWORDS,
  ASO_MAX_KEYWORDS_PER_REQUEST_ERROR,
} from "../../shared/aso-keyword-limits";
import { normalizeCountry, normalizeKeyword } from "../../domain/keywords/policy";
import type { AsoRouteDeps } from "./aso-route-types";

const DEFAULT_KEYWORDS_PAGE = 1;
const DEFAULT_KEYWORDS_PAGE_SIZE = 100;
const MAX_KEYWORDS_PAGE_SIZE = 500;
const DEFAULT_MIN_POPULARITY = 0;
const DEFAULT_MAX_DIFFICULTY = 100;
const DEFAULT_MIN_RANK = 0;
const DEFAULT_MAX_RANK = 201;

type KeywordSortKey =
  | "keyword"
  | "popularity"
  | "difficulty"
  | "appCount"
  | "rank"
  | "change"
  | "addedAt"
  | "updatedAt";
type KeywordSortDir = "asc" | "desc";
type KeywordBrandFilter = "all" | "brand" | "non_brand";
type KeywordFavoriteFilter = "all" | "favorite" | "non_favorite";

type KeywordPagedQuery = {
  page: number;
  pageSize: number;
  keywordFilter: string;
  minPopularity: number;
  maxDifficulty: number;
  brandFilter: KeywordBrandFilter;
  favoriteFilter: KeywordFavoriteFilter;
  minRank: number;
  maxRank: number;
  sortBy: KeywordSortKey;
  sortDir: KeywordSortDir;
};

type KeywordPagedRow = {
  normalized_keyword: string;
  keyword: string;
  popularity: number | null;
  difficulty_score: number | null;
  min_difficulty_score: number | null;
  is_brand_keyword: number | null;
  app_count: number | null;
  keyword_match: string | null;
  ordered_app_ids: string;
  created_at: string;
  added_at: string | null;
  updated_at: string;
  order_expires_at: string;
  popularity_expires_at: string;
  is_favorite: number;
  current_position: number | null;
  failure_stage: string | null;
  failure_reason_code: string | null;
  failure_message: string | null;
  failure_status_code: number | null;
  failure_retryable: number | null;
  failure_attempts: number | null;
  failure_request_id: string | null;
  failure_updated_at: string | null;
};

type KeywordPagedSummaryRow = {
  total_count: number;
  failed_count: number;
  pending_count: number;
};

type AppAssociationRow = {
  app_id: string;
  keyword: string;
  previous_position: number | null;
};

function toBoundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

function parseKeywordSortKey(value: string | undefined): KeywordSortKey {
  switch (value) {
    case "keyword":
    case "popularity":
    case "difficulty":
    case "appCount":
    case "rank":
    case "change":
    case "addedAt":
    case "updatedAt":
      return value;
    default:
      return "updatedAt";
  }
}

function parseKeywordSortDir(value: string | undefined): KeywordSortDir {
  return value === "asc" || value === "desc" ? value : "desc";
}

function parseKeywordBrandFilter(value: string | undefined): KeywordBrandFilter {
  if (value === "brand" || value === "non_brand") return value;
  return "all";
}

function parseKeywordFavoriteFilter(
  value: string | undefined
): KeywordFavoriteFilter {
  if (value === "favorite" || value === "non_favorite") return value;
  return "all";
}

function parseOrderedAppIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((value) => String(value));
  } catch {
    return [];
  }
}

function parseKeywordPagedQuery(query: Record<string, string>): KeywordPagedQuery {
  const minRank = toBoundedInteger(
    query.minRank,
    DEFAULT_MIN_RANK,
    DEFAULT_MIN_RANK,
    DEFAULT_MAX_RANK
  );
  const maxRank = toBoundedInteger(
    query.maxRank,
    DEFAULT_MAX_RANK,
    DEFAULT_MIN_RANK,
    DEFAULT_MAX_RANK
  );
  const normalizedMinRank = Math.min(minRank, maxRank);
  const normalizedMaxRank = Math.max(minRank, maxRank);
  return {
    page: toBoundedInteger(
      query.page,
      DEFAULT_KEYWORDS_PAGE,
      DEFAULT_KEYWORDS_PAGE,
      Number.MAX_SAFE_INTEGER
    ),
    pageSize: toBoundedInteger(
      query.pageSize,
      DEFAULT_KEYWORDS_PAGE_SIZE,
      1,
      MAX_KEYWORDS_PAGE_SIZE
    ),
    keywordFilter: (query.keyword ?? "").trim(),
    minPopularity: toBoundedInteger(
      query.minPopularity,
      DEFAULT_MIN_POPULARITY,
      DEFAULT_MIN_POPULARITY,
      100
    ),
    maxDifficulty: toBoundedInteger(
      query.maxDifficulty,
      DEFAULT_MAX_DIFFICULTY,
      0,
      DEFAULT_MAX_DIFFICULTY
    ),
    brandFilter: parseKeywordBrandFilter(query.brand),
    favoriteFilter: parseKeywordFavoriteFilter(query.favorite),
    minRank: normalizedMinRank,
    maxRank: normalizedMaxRank,
    sortBy: parseKeywordSortKey(query.sortBy),
    sortDir: parseKeywordSortDir(query.sortDir),
  };
}

function buildPagedKeywordWhereClause(parsed: KeywordPagedQuery): {
  clause: string;
  args: unknown[];
} {
  const clauses: string[] = [];
  const args: unknown[] = [];

  if (parsed.keywordFilter !== "") {
    clauses.push("LOWER(keyword) LIKE ?");
    args.push(`%${parsed.keywordFilter.toLowerCase()}%`);
  }
  if (parsed.minPopularity > DEFAULT_MIN_POPULARITY) {
    clauses.push("COALESCE(popularity, 0) > ?");
    args.push(parsed.minPopularity);
  }
  if (parsed.maxDifficulty < DEFAULT_MAX_DIFFICULTY) {
    clauses.push("(difficulty_score IS NULL OR difficulty_score < ?)");
    args.push(parsed.maxDifficulty);
  }
  if (parsed.brandFilter === "brand") {
    clauses.push("is_brand_keyword = 1");
  } else if (parsed.brandFilter === "non_brand") {
    clauses.push("is_brand_keyword = 0");
  }
  if (parsed.favoriteFilter === "favorite") {
    clauses.push("is_favorite = 1");
  } else if (parsed.favoriteFilter === "non_favorite") {
    clauses.push("is_favorite = 0");
  }
  const hasRankLowerBound = parsed.minRank > DEFAULT_MIN_RANK;
  const hasRankUpperBound = parsed.maxRank < DEFAULT_MAX_RANK;
  if (hasRankLowerBound || hasRankUpperBound) {
    clauses.push("current_position IS NOT NULL");
    if (hasRankLowerBound) {
      clauses.push("current_position > ?");
      args.push(parsed.minRank);
    }
    if (hasRankUpperBound) {
      clauses.push("current_position < ?");
      args.push(parsed.maxRank);
    }
  }

  return {
    clause: clauses.length > 0 ? clauses.join(" AND ") : "1=1",
    args,
  };
}

function buildPagedKeywordOrderClause(
  sortBy: KeywordSortKey,
  sortDir: KeywordSortDir
): string {
  const dir = sortDir === "asc" ? "ASC" : "DESC";
  switch (sortBy) {
    case "keyword":
      return `keyword COLLATE NOCASE ${dir}, normalized_keyword COLLATE NOCASE ASC`;
    case "popularity":
      return `popularity IS NULL ASC, popularity ${dir}, keyword COLLATE NOCASE ASC`;
    case "difficulty":
      return `difficulty_score IS NULL ASC, difficulty_score ${dir}, keyword COLLATE NOCASE ASC`;
    case "appCount":
      return `app_count IS NULL ASC, app_count ${dir}, keyword COLLATE NOCASE ASC`;
    case "rank":
      return `current_position IS NULL ASC, current_position ${dir}, keyword COLLATE NOCASE ASC`;
    case "change":
      return `position_change IS NULL ASC, position_change ${dir}, keyword COLLATE NOCASE ASC`;
    case "addedAt":
      return `added_at IS NULL ASC, added_at ${dir}, keyword COLLATE NOCASE ASC`;
    case "updatedAt":
    default:
      return `updated_at IS NULL ASC, updated_at ${dir}, keyword COLLATE NOCASE ASC`;
  }
}

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
                keywordPipelineService.persistBackgroundEnrichmentCrashFailures(
                  country,
                  pendingItems,
                  err
                );
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
      deps.reportDashboardError(error, {
        method: "POST",
        path: "/api/aso/keywords/retry-failed",
        appId,
        country,
      });
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

  async function handleApiAsoKeywordsForceRefreshPost(
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
    const keywords = keywordPipelineService.normalizeKeywords(body.keywords ?? []);
    const country = normalizeCountry(body.country);

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
    if (deps.isDashboardAuthInProgress()) {
      deps.sendApiError(
        res,
        409,
        "AUTH_IN_PROGRESS",
        "Reauthentication is in progress. Finish it and retry."
      );
      return;
    }

    try {
      const result = await keywordPipelineService.forceRefresh(country, keywords, {
        allowInteractiveAuthRecovery: false,
      });
      deps.sendJson(res, 200, {
        success: true,
        data: {
          requestedCount: keywords.length,
          succeededCount: result.items.length,
          failedCount: result.failedKeywords.length,
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
      deps.reportDashboardError(error, {
        method: "POST",
        path: "/api/aso/keywords/force-refresh",
        appId,
        country,
        keywordCount: keywords.length,
      });
      const publicError = deps.toUserSafeError(
        error,
        "Failed to force refresh keywords"
      );
      deps.sendApiError(
        res,
        deps.statusForDashboardErrorCode(publicError.errorCode),
        publicError.errorCode,
        publicError.message
      );
    }
  }

  async function handleApiAsoKeywordsFavoritePost(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const body = await deps.parseJsonBody<{
      appId?: string;
      keyword?: string;
      isFavorite?: boolean;
      country?: string;
    }>(req, res);
    if (!body) {
      return;
    }
    const appId = body.appId ?? DEFAULT_RESEARCH_APP_ID;
    const keyword = body.keyword?.trim() ?? "";
    const country = normalizeCountry(body.country);
    if (!keyword) {
      deps.sendApiError(
        res,
        400,
        "INVALID_REQUEST",
        "Please provide a valid keyword."
      );
      return;
    }
    if (typeof body.isFavorite !== "boolean") {
      deps.sendApiError(
        res,
        400,
        "INVALID_REQUEST",
        "Please provide a valid favorite status."
      );
      return;
    }

    try {
      const updated = setAppKeywordFavorite(appId, keyword, body.isFavorite, country);
      if (!updated) {
        deps.sendApiError(
          res,
          404,
          "NOT_FOUND",
          "Keyword association was not found for this app."
        );
        return;
      }
      deps.sendJson(res, 200, {
        success: true,
        data: {
          appId,
          keyword,
          isFavorite: body.isFavorite,
        },
      });
    } catch (error) {
      const publicError = deps.toUserSafeError(
        error,
        "Failed to update keyword favorite status"
      );
      deps.sendApiError(
        res,
        deps.statusForDashboardErrorCode(publicError.errorCode),
        publicError.errorCode,
        publicError.message
      );
    }
  }

  function handleApiAsoKeywordHistoryGet(
    res: http.ServerResponse,
    query: Record<string, string>
  ): void {
    const appId = query.appId?.trim() ?? "";
    const normalizedKeyword = normalizeKeyword(query.keyword ?? "");
    const country = normalizeCountry(query.country);
    if (!appId || !normalizedKeyword) {
      deps.sendApiError(
        res,
        400,
        "INVALID_REQUEST",
        "Please provide appId and keyword."
      );
      return;
    }

    const points = listAppKeywordPositionHistory(appId, normalizedKeyword, country)
      .map((row) => ({
        capturedAt: row.capturedAt,
        position: row.position,
      }))
      .filter((row): row is { capturedAt: string; position: number } =>
        typeof row.position === "number"
      );

    deps.sendJson(res, 200, {
      success: true,
      data: {
        appId,
        keyword: normalizedKeyword,
        points,
      },
    });
  }

  function handleApiAsoKeywordsGetPagedForApp(
    res: http.ServerResponse,
    country: string,
    appId: string,
    query: Record<string, string>
  ): void {
    const parsed = parseKeywordPagedQuery(query);
    const where = buildPagedKeywordWhereClause(parsed);
    const orderBy = buildPagedKeywordOrderClause(parsed.sortBy, parsed.sortDir);
    const db = getDb();
    const scopedSql = `
      WITH scoped AS (
        SELECT
          ak.keyword AS normalized_keyword,
          COALESCE(k.keyword, ak.keyword) AS keyword,
          k.popularity AS popularity,
          k.difficulty_score AS difficulty_score,
          k.min_difficulty_score AS min_difficulty_score,
          k.is_brand_keyword AS is_brand_keyword,
          k.app_count AS app_count,
          k.keyword_match AS keyword_match,
          COALESCE(k.ordered_app_ids, '[]') AS ordered_app_ids,
          COALESCE(ak.is_favorite, 0) AS is_favorite,
          COALESCE(k.created_at, f.updated_at, ak.added_at, '') AS created_at,
          ak.added_at AS added_at,
          COALESCE(k.updated_at, f.updated_at, ak.added_at, '') AS updated_at,
          COALESCE(k.order_expires_at, f.updated_at, ak.added_at, '') AS order_expires_at,
          COALESCE(k.popularity_expires_at, f.updated_at, ak.added_at, '') AS popularity_expires_at,
          ak.previous_position AS previous_position,
          (
            SELECT CAST(je.key AS INTEGER) + 1
            FROM json_each(COALESCE(k.ordered_app_ids, '[]')) AS je
            WHERE je.value = ak.app_id
            LIMIT 1
          ) AS current_position,
          f.stage AS failure_stage,
          f.reason_code AS failure_reason_code,
          f.message AS failure_message,
          f.status_code AS failure_status_code,
          f.retryable AS failure_retryable,
          f.attempts AS failure_attempts,
          f.request_id AS failure_request_id,
          f.updated_at AS failure_updated_at
        FROM app_keywords ak
        LEFT JOIN aso_keywords k
          ON k.country = ak.country
         AND k.normalized_keyword = ak.keyword
        LEFT JOIN aso_keyword_failures f
          ON f.country = ak.country
         AND f.normalized_keyword = ak.keyword
        WHERE ak.country = ? AND ak.app_id = ?
      )
    `;
    const summary = db
      .prepare(
        `${scopedSql}
         SELECT
           COUNT(*) AS total_count,
           SUM(CASE WHEN failure_stage IS NOT NULL THEN 1 ELSE 0 END) AS failed_count,
           SUM(
             CASE
               WHEN failure_stage IS NULL AND difficulty_score IS NULL THEN 1
               ELSE 0
             END
           ) AS pending_count
         FROM scoped`
      )
      .get(country, appId) as KeywordPagedSummaryRow | undefined;
    const filteredCountRow = db
      .prepare(
        `${scopedSql}
         SELECT COUNT(*) AS total_count
         FROM scoped
         WHERE ${where.clause}`
      )
      .get(country, appId, ...where.args) as { total_count: number } | undefined;
    const filteredTotalCount = Number(filteredCountRow?.total_count ?? 0);
    const totalPages = Math.max(
      1,
      Math.ceil(filteredTotalCount / Math.max(1, parsed.pageSize))
    );
    const page = Math.min(parsed.page, totalPages);
    const offset = (page - 1) * parsed.pageSize;
    const rows = db
      .prepare(
        `${scopedSql}
         SELECT
           normalized_keyword,
           keyword,
           popularity,
           difficulty_score,
           min_difficulty_score,
           is_brand_keyword,
           app_count,
           keyword_match,
           ordered_app_ids,
           is_favorite,
           created_at,
           added_at,
           updated_at,
           order_expires_at,
           popularity_expires_at,
           current_position,
           failure_stage,
           failure_reason_code,
           failure_message,
           failure_status_code,
           failure_retryable,
           failure_attempts,
           failure_request_id,
           failure_updated_at,
           CASE
              WHEN current_position IS NULL THEN NULL
              ELSE current_position - previous_position
            END AS position_change
         FROM scoped
         WHERE ${where.clause}
         ORDER BY ${orderBy}
         LIMIT ? OFFSET ?`
      )
      .all(
        country,
        appId,
        ...where.args,
        parsed.pageSize,
        offset
      ) as KeywordPagedRow[];

    const normalizedKeywords = rows.map((row) => row.normalized_keyword);
    const associationsByKeyword = new Map<string, AppAssociationRow[]>();
    if (normalizedKeywords.length > 0) {
      const placeholders = normalizedKeywords.map(() => "?").join(", ");
      const associationRows = db
        .prepare(
          `SELECT app_id, keyword, previous_position
           FROM app_keywords
           WHERE country = ? AND keyword IN (${placeholders})`
        )
        .all(country, ...normalizedKeywords) as AppAssociationRow[];
      for (const association of associationRows) {
        const existing = associationsByKeyword.get(association.keyword);
        if (existing) {
          existing.push(association);
        } else {
          associationsByKeyword.set(association.keyword, [association]);
        }
      }
    }

    const items = rows.map((row) => {
      const orderedAppIds = parseOrderedAppIds(row.ordered_app_ids);
      const assocs = associationsByKeyword.get(row.normalized_keyword) ?? [];
      const positions = assocs.map((association) => ({
        appId: association.app_id,
        previousPosition: association.previous_position,
        currentPosition: (() => {
          const idx = orderedAppIds.indexOf(association.app_id);
          return idx >= 0 ? idx + 1 : null;
        })(),
      }));
      const failure =
        row.failure_stage != null
          ? {
              stage:
                row.failure_stage === "popularity" ? "popularity" : "enrichment",
              reasonCode: row.failure_reason_code ?? "UNKNOWN",
              message: row.failure_message ?? "Keyword processing failed.",
              statusCode: row.failure_status_code,
              retryable: row.failure_retryable === 1,
              attempts: row.failure_attempts ?? 1,
              requestId: row.failure_request_id,
              updatedAt: row.failure_updated_at ?? row.updated_at,
            }
          : null;
      return {
        keyword: row.keyword,
        normalizedKeyword: row.normalized_keyword,
        country,
        popularity: row.popularity,
        difficultyScore: row.difficulty_score,
        minDifficultyScore: row.min_difficulty_score,
        isBrandKeyword:
          row.is_brand_keyword == null ? null : row.is_brand_keyword === 1,
        appCount: row.app_count,
        keywordMatch: row.keyword_match ?? "none",
        orderedAppIds,
        isFavorite: row.is_favorite === 1,
        createdAt: row.created_at,
        addedAt: row.added_at,
        updatedAt: row.updated_at,
        orderExpiresAt: row.order_expires_at,
        popularityExpiresAt: row.popularity_expires_at,
        keywordStatus: failure
          ? "failed"
          : row.difficulty_score == null
            ? "pending"
            : "ok",
        failure,
        positions,
      };
    });

    deps.sendJson(res, 200, {
      success: true,
      data: {
        items,
        page,
        pageSize: parsed.pageSize,
        totalCount: filteredTotalCount,
        totalPages,
        hasPrevPage: page > 1,
        hasNextPage: page < totalPages,
        associatedCount: Number(summary?.total_count ?? 0),
        failedCount: Number(summary?.failed_count ?? 0),
        pendingCount: Number(summary?.pending_count ?? 0),
      },
    });
  }

  function handleApiAsoKeywordsGet(
    res: http.ServerResponse,
    query: Record<string, string>
  ): void {
    const country = normalizeCountry(query.country);
    const appId = query.appId?.trim() ?? "";
    if (appId !== "") {
      handleApiAsoKeywordsGetPagedForApp(res, country, appId, query);
      return;
    }

    deps.sendApiError(
      res,
      400,
      "INVALID_REQUEST",
      "Please provide a valid appId."
    );
  }

  return {
    handleApiAsoKeywordsPost,
    handleApiAsoKeywordsDelete,
    handleApiAsoKeywordsFavoritePost,
    handleApiAsoKeywordsForceRefreshPost,
    handleApiAsoKeywordsRetryFailedPost,
    handleApiAsoKeywordHistoryGet,
    handleApiAsoKeywordsGet,
  };
}
