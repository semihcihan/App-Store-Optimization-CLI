import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { logger } from "../utils/logger";
import { getAppById, listApps, upsertApps } from "../db/apps";
import { listKeywords, getKeyword } from "../db/aso-keywords";
import {
  listKeywordFailuresForApp,
  getKeywordFailures,
  deleteKeywordFailures,
} from "../db/aso-keyword-failures";
import {
  getCompetitorAppDocs,
  getOwnedAppDocs,
  upsertCompetitorAppDocs,
  upsertOwnedAppDocs,
} from "../db/aso-apps";
import {
  listAllAppKeywords,
  listByApp,
  createAppKeywords,
  deleteAppKeywords,
  getAppLastKeywordAddedAtMap,
} from "../db/app-keywords";
import {
  normalizeKeywords,
  fetchAndPersistKeywordPopularityStage,
  enrichAndPersistKeywords,
  refreshAndPersistKeywordOrder,
  refreshKeywordsForStartup,
} from "../services/keywords/aso-keyword-service";
import {
  asoAuthService,
} from "../services/auth/aso-auth-service";
import { isAsoAuthReauthRequiredError } from "../services/keywords/aso-popularity-service";
import { reportBugsnagError } from "../services/telemetry/error-reporter";
import { getAsoAppDocsLocal } from "../services/keywords/aso-local-cache-service";
import {
  DEFAULT_RESEARCH_APP_ID,
  DEFAULT_RESEARCH_APP_NAME,
} from "../services/keywords/aso-research";
import {
  createStartupRefreshManager,
  type StartupRefreshState,
} from "./startup-refresh-manager";
import { chunkArray, getMissingOrExpiredAppIds } from "./refresh-utils";
import {
  ASO_MAX_KEYWORDS,
  ASO_MAX_KEYWORDS_PER_REQUEST_ERROR,
} from "../shared/aso-keyword-limits";

const DEFAULT_PORT = 3456;
const DEFAULT_APP_DOCS_HYDRATION_COUNTRY = "US";
const DASHBOARD_PUBLIC_DIR = path.resolve(__dirname, "dashboard-public");
const DASHBOARD_RUNTIME_CONFIG_PATH = "/runtime-config.js";
const ASO_APP_DOCS_MAX_BATCH_SIZE = 50;
const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

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

type DashboardErrorCode =
  | "INVALID_REQUEST"
  | "MISSING_APPLE_CREDENTIALS"
  | "AUTH_REQUIRED"
  | "AUTH_IN_PROGRESS"
  | "TTY_REQUIRED"
  | "AUTHORIZATION_FAILED"
  | "RATE_LIMITED"
  | "REQUEST_TIMEOUT"
  | "NETWORK_ERROR"
  | "NOT_FOUND"
  | "INTERNAL_ERROR";

type ManualAppAddRequest =
  | {
      type: "app";
      appId?: string;
    }
  | {
      type: "research";
      name?: string;
    };

type DashboardAuthStatus = "idle" | "in_progress" | "failed" | "succeeded";

type DashboardAuthState = {
  status: DashboardAuthStatus;
  updatedAt: string | null;
  lastError: string | null;
  requiresTerminalAction: boolean;
};

const dashboardAuthState: DashboardAuthState = {
  status: "idle",
  updatedAt: null,
  lastError: null,
  requiresTerminalAction: false,
};

let dashboardAuthPromise: Promise<void> | null = null;
let foregroundMutationCount = 0;

type UserSafeError = {
  errorCode: DashboardErrorCode;
  message: string;
};

function reportDashboardError(
  error: unknown,
  metadata: Record<string, unknown>
): void {
  reportBugsnagError(error, {
    surface: "aso-dashboard-server",
    ...metadata,
  });
}

function toUserSafeError(error: unknown, fallback: string): UserSafeError {
  const rawMessage = error instanceof Error ? error.message : String(error ?? "");
  const lower = rawMessage.toLowerCase();

  if (lower.includes("apple credentials")) {
    return {
      errorCode: "MISSING_APPLE_CREDENTIALS",
      message: "Apple credentials are missing. Run 'aso auth' in a terminal and retry.",
    };
  }

  if (isAsoAuthReauthRequiredError(error)) {
    return {
      errorCode: "AUTH_REQUIRED",
      message:
        "Apple Search Ads session expired. Reauthenticate from the dashboard and retry.",
    };
  }

  if (
    lower.includes("primary app id") ||
    lower.includes("no_user_owned_apps_found_code") ||
    lower.includes("no user owned apps found")
  ) {
    return {
      errorCode: "AUTHORIZATION_FAILED",
      message:
        "Primary App ID is not accessible for this Apple Ads account. Run 'aso --primary-app-id <id>' with an accessible app ID and retry.",
    };
  }

  if (lower.includes("unauthorized") || lower.includes("forbidden")) {
    return {
      errorCode: "AUTHORIZATION_FAILED",
      message: "Authorization failed. Verify your account access and retry.",
    };
  }

  if (lower.includes("too many requests") || lower.includes("rate limit")) {
    return {
      errorCode: "RATE_LIMITED",
      message: "Rate limited by upstream API. Wait a bit and retry.",
    };
  }

  if (
    lower.includes("request timed out") ||
    lower.includes("timed out") ||
    lower.includes("timeout")
  ) {
    return {
      errorCode: "REQUEST_TIMEOUT",
      message: "Request timed out. Retry in a moment.",
    };
  }

  if (
    lower.includes("failed to fetch") ||
    lower.includes("networkerror") ||
    lower.includes("network")
  ) {
    return {
      errorCode: "NETWORK_ERROR",
      message: "Network issue while reaching the backend. Check your connection and retry.",
    };
  }

  return {
    errorCode: "INTERNAL_ERROR",
    message: fallback,
  };
}

function statusForDashboardErrorCode(errorCode: DashboardErrorCode): number {
  if (errorCode === "INVALID_REQUEST") return 400;
  if (errorCode === "AUTH_REQUIRED") return 401;
  if (errorCode === "AUTHORIZATION_FAILED") return 403;
  if (errorCode === "NOT_FOUND") return 404;
  if (errorCode === "AUTH_IN_PROGRESS") return 409;
  if (errorCode === "RATE_LIMITED") return 429;
  return 500;
}

function nowIsoString(): string {
  return new Date().toISOString();
}

function hasInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function setDashboardAuthState(
  status: DashboardAuthStatus,
  lastError: string | null = null
): void {
  dashboardAuthState.status = status;
  dashboardAuthState.updatedAt = nowIsoString();
  dashboardAuthState.lastError = lastError;
  dashboardAuthState.requiresTerminalAction = false;
}

function markDashboardAuthRequiresTerminalAction(): void {
  if (dashboardAuthState.status !== "in_progress") return;
  dashboardAuthState.requiresTerminalAction = true;
  dashboardAuthState.updatedAt = nowIsoString();
}

function getDashboardAuthState() {
  return {
    status: dashboardAuthState.status,
    updatedAt: dashboardAuthState.updatedAt,
    lastError: dashboardAuthState.lastError,
    requiresTerminalAction: dashboardAuthState.requiresTerminalAction,
    canPrompt: hasInteractiveTerminal(),
  };
}

function beginForegroundMutation(): () => void {
  foregroundMutationCount += 1;
  let completed = false;
  return () => {
    if (completed) return;
    completed = true;
    foregroundMutationCount = Math.max(0, foregroundMutationCount - 1);
  };
}

async function runAsForegroundMutation<T>(
  operation: () => Promise<T>
): Promise<T> {
  const end = beginForegroundMutation();
  try {
    return await operation();
  } finally {
    end();
  }
}

function runAsForegroundMutationSync(operation: () => void): void {
  const end = beginForegroundMutation();
  try {
    operation();
  } finally {
    end();
  }
}

const startupRefreshManager = createStartupRefreshManager({
  country: "US",
  listKeywords,
  listAppKeywords: listAllAppKeywords,
  enrichKeywords: (country, items) => refreshKeywordsForStartup(country, items),
  isForegroundBusy: () => foregroundMutationCount > 0,
  reportError: (error, metadata) => {
    reportDashboardError(error, {
      ...metadata,
      context: "startup-refresh",
    });
  },
});

function getStartupRefreshState(): StartupRefreshState {
  return startupRefreshManager.getState();
}

function beginDashboardReauthentication(): boolean {
  if (dashboardAuthPromise) return false;

  setDashboardAuthState("in_progress", null);
  dashboardAuthPromise = asoAuthService
    .reAuthenticate({
      onUserActionRequired: () => {
        markDashboardAuthRequiresTerminalAction();
      },
    })
    .then(() => {
      setDashboardAuthState("succeeded", null);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setDashboardAuthState("failed", message || "Authentication failed.");
      reportDashboardError(error, {
        method: "POST",
        path: "/api/aso/auth/start",
      });
      logger.error(`ASO dashboard reauthentication failed: ${message}`);
    })
    .finally(() => {
      dashboardAuthPromise = null;
    });

  return true;
}

function sendApiError(
  res: http.ServerResponse,
  status: number,
  errorCode: DashboardErrorCode,
  message: string
): void {
  sendJson(res, status, {
    success: false,
    errorCode,
    error: message,
  });
}

function normalizeAppId(input: string | undefined): string {
  return (input ?? "").trim();
}

function isNumericAppId(appId: string): boolean {
  return /^\d+$/.test(appId);
}

function slugifyResearchName(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return base || "research";
}

function nextResearchAppId(slug: string): string {
  const baseId = `research:${slug}`;
  if (!getAppById(baseId)) {
    return baseId;
  }
  let suffix = 2;
  while (true) {
    const candidate = `${baseId}-${suffix}`;
    if (!getAppById(candidate)) {
      return candidate;
    }
    suffix += 1;
  }
}

function ensureDefaultResearchAppExists(): void {
  if (getAppById(DEFAULT_RESEARCH_APP_ID)) {
    return;
  }
  upsertApps([
    {
      id: DEFAULT_RESEARCH_APP_ID,
      name: DEFAULT_RESEARCH_APP_NAME,
    },
  ]);
}

async function fetchAsoAppDocsFromApi(
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
    .filter(
      (
        doc
      ): doc is AsoApiAppDoc => doc != null
    );

  logger.debug("[aso-dashboard] response <- local-backend", {
    durationMs: Date.now() - startedAt,
    appDocCount: ordered.length,
    appIdsCount: uniqueIds.length,
    chunkCount: idChunks.length,
  });
  return ordered;
}

function parseQuery(url: string): Record<string, string> {
  const i = url.indexOf("?");
  if (i < 0) return {};
  const out: Record<string, string> = {};
  const search = new URLSearchParams(url.slice(i));
  search.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

function isTruthyQueryParam(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store, max-age=0",
  });
  res.end(JSON.stringify(data));
}

function sendStaticFile(res: http.ServerResponse, filePath: string): void {
  try {
    const content = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = STATIC_CONTENT_TYPES[ext] ?? "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store, max-age=0",
    });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

function sendDashboardRuntimeConfig(res: http.ServerResponse): void {
  const payload = `window.__ASO_DASHBOARD_RUNTIME__=${JSON.stringify({
    nodeEnv: process.env.NODE_ENV ?? "",
  })};`;
  res.writeHead(200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
  });
  res.end(payload);
}

function resolveStaticPath(pathname: string): string | null {
  if (!pathname.startsWith("/")) return null;
  const decoded = decodeURIComponent(pathname);
  const relativePath = decoded.replace(/^\/+/, "");
  if (relativePath.includes("..")) return null;
  return path.join(DASHBOARD_PUBLIC_DIR, relativePath);
}

function getRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleApiAppsPost(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  let body: ManualAppAddRequest;
  try {
    const raw = await getRequestBody(req);
    body = JSON.parse(raw) as ManualAppAddRequest;
  } catch {
    sendApiError(res, 400, "INVALID_REQUEST", "Invalid request payload.");
    return;
  }

  if (!body || (body.type !== "app" && body.type !== "research")) {
    sendApiError(
      res,
      400,
      "INVALID_REQUEST",
      "Invalid request. type must be 'app' or 'research'."
    );
    return;
  }

  if (body.type === "app") {
    const appId = normalizeAppId(body.appId);
    if (!appId || !isNumericAppId(appId)) {
      sendApiError(
        res,
        400,
        "INVALID_REQUEST",
        "App ID must be numeric."
      );
      return;
    }

    const country = DEFAULT_APP_DOCS_HYDRATION_COUNTRY;
    upsertApps([{ id: appId, name: appId }]);
    let hydratedName = appId;
    try {
      const docs = await fetchAsoAppDocsFromApi(country, [appId]);
      if (docs.length > 0) {
        upsertOwnedAppDocs(country, docs);
        const first = docs[0];
        if (first?.name?.trim()) {
          hydratedName = first.name.trim();
          upsertApps([{ id: appId, name: hydratedName }]);
        }
      }
    } catch (error) {
      reportDashboardError(error, {
        method: "POST",
        path: "/api/apps",
        phase: "manual-app-hydration",
        appId,
        country,
      });
    }

    sendJson(res, 201, {
      success: true,
      data: {
        id: appId,
        name: hydratedName,
      },
    });
    return;
  }

  const name = (body.name ?? "").trim();
  if (!name) {
    sendApiError(
      res,
      400,
      "INVALID_REQUEST",
      "Research name is required."
    );
    return;
  }

  const slug = slugifyResearchName(name);
  ensureDefaultResearchAppExists();
  const id = nextResearchAppId(slug);
  upsertApps([{ id, name }]);
  sendJson(res, 201, {
    success: true,
    data: {
      id,
      name,
    },
  });
}

function handleApiAsoAuthStatusGet(res: http.ServerResponse): void {
  sendJson(res, 200, { success: true, data: getDashboardAuthState() });
}

function handleApiAsoRefreshStatusGet(res: http.ServerResponse): void {
  sendJson(res, 200, { success: true, data: getStartupRefreshState() });
}

function handleApiAsoAuthStartPost(res: http.ServerResponse): void {
  if (!hasInteractiveTerminal()) {
    sendApiError(
      res,
      503,
      "TTY_REQUIRED",
      "Reauthentication requires an interactive terminal. Start dashboard in a terminal and retry."
    );
    return;
  }

  if (!beginDashboardReauthentication()) {
    sendApiError(
      res,
      409,
      "AUTH_IN_PROGRESS",
      "Reauthentication is already in progress."
    );
    return;
  }

  sendJson(res, 202, { success: true, data: getDashboardAuthState() });
}

async function handleApiAsoKeywordsPost(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  let body: { appId?: string; keywords?: string[]; country?: string };
  try {
    const raw = await getRequestBody(req);
    body = JSON.parse(raw) as typeof body;
  } catch {
    sendApiError(res, 400, "INVALID_REQUEST", "Invalid request payload.");
    return;
  }
  const appId = body.appId ?? DEFAULT_RESEARCH_APP_ID;
  const rawKeywords = body.keywords ?? [];
  const keywords = normalizeKeywords(rawKeywords);
  const country = (body.country ?? "US").toUpperCase();
  const startedAt = Date.now();
  if (keywords.length === 0) {
    sendApiError(res, 400, "INVALID_REQUEST", "Please provide at least one keyword.");
    return;
  }
  if (keywords.length > ASO_MAX_KEYWORDS) {
    sendApiError(res, 400, "INVALID_REQUEST", ASO_MAX_KEYWORDS_PER_REQUEST_ERROR);
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
    sendJson(res, 201, {
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

  if (dashboardAuthPromise) {
    sendApiError(
      res,
      409,
      "AUTH_IN_PROGRESS",
      "Reauthentication is in progress. Finish it in terminal and retry."
    );
    return;
  }

  try {
    const { hits, pendingItems, orderRefreshKeywords, failedKeywords } =
      await fetchAndPersistKeywordPopularityStage(
        country,
        keywordsToAdd,
        { allowInteractiveAuthRecovery: false }
      );
    createAppKeywords(appId, keywordsToAdd, country);
    const pendingCount = pendingItems.length + orderRefreshKeywords.length;

    sendJson(res, 201, {
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
              reportDashboardError(err, {
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
              reportDashboardError(err, {
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
      sendApiError(
        res,
        401,
        "AUTH_REQUIRED",
        "Apple Search Ads session expired. Reauthenticate from the dashboard and retry."
      );
      return;
    }

    const message = err instanceof Error ? err.message : String(err);
    const publicError = toUserSafeError(err, "Failed to add keywords");
    const responseStatus = statusForDashboardErrorCode(publicError.errorCode);
    reportDashboardError(err, {
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
    sendApiError(
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
  let body: { appId?: string; keywords?: string[]; country?: string };
  try {
    const raw = await getRequestBody(req);
    body = JSON.parse(raw) as typeof body;
  } catch {
    sendApiError(res, 400, "INVALID_REQUEST", "Invalid request payload.");
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
    sendApiError(res, 400, "INVALID_REQUEST", "Please provide at least one keyword.");
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
    sendJson(res, 200, { success: true, data: { removedCount } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const publicError = toUserSafeError(err, "Failed to delete keywords");
    const responseStatus = statusForDashboardErrorCode(publicError.errorCode);
    reportDashboardError(err, {
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
    sendApiError(
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
  let body: { appId?: string; country?: string };
  try {
    const raw = await getRequestBody(req);
    body = JSON.parse(raw) as typeof body;
  } catch {
    sendApiError(res, 400, "INVALID_REQUEST", "Invalid request payload.");
    return;
  }
  const appId = body.appId ?? DEFAULT_RESEARCH_APP_ID;
  const country = (body.country ?? "US").toUpperCase();

  if (dashboardAuthPromise) {
    sendApiError(
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
    sendJson(res, 200, {
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
    sendJson(res, 200, {
      success: true,
      data: {
        retriedCount: keywordsToRetry.length,
        succeededCount: succeededKeywords.length,
        failedCount,
      },
    });
  } catch (error) {
    if (isAsoAuthReauthRequiredError(error)) {
      sendApiError(
        res,
        401,
        "AUTH_REQUIRED",
        "Apple Search Ads session expired. Reauthenticate from the dashboard and retry."
      );
      return;
    }
    const publicError = toUserSafeError(error, "Failed to retry failed keywords");
    sendApiError(
      res,
      statusForDashboardErrorCode(publicError.errorCode),
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
  if (appId != null && appId !== "") {
    const kws = byApp.get(appId) ?? [];
    const set = new Set(kws.map((k) => k.trim().toLowerCase()));
    filtered = keywords.filter((k) => set.has(k.normalizedKeyword));
  }
  const keywordFailures = getKeywordFailures(
    country,
    filtered.map((item) => item.keyword)
  );
  const failureByKeyword = new Map(
    keywordFailures.map((failure) => [failure.normalizedKeyword, failure] as const)
  );
  const withMeta = filtered.map((k) => {
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
      keywordStatus: failureByKeyword.has(k.normalizedKeyword)
        ? "failed"
        : k.difficultyScore == null
          ? "pending"
          : "ok",
      failure: failureByKeyword.get(k.normalizedKeyword)
        ? {
            stage: failureByKeyword.get(k.normalizedKeyword)?.stage,
            reasonCode: failureByKeyword.get(k.normalizedKeyword)?.reasonCode,
            message: failureByKeyword.get(k.normalizedKeyword)?.message,
            statusCode: failureByKeyword.get(k.normalizedKeyword)?.statusCode,
            retryable: failureByKeyword.get(k.normalizedKeyword)?.retryable,
            attempts: failureByKeyword.get(k.normalizedKeyword)?.attempts,
            requestId: failureByKeyword.get(k.normalizedKeyword)?.requestId,
            updatedAt: failureByKeyword.get(k.normalizedKeyword)?.updatedAt,
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
  sendJson(res, 200, { success: true, data: withMeta });
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

async function handleApiAsoTopAppsGet(
  res: http.ServerResponse,
  query: Record<string, string>
): Promise<void> {
  const country = (query.country ?? "US").toUpperCase();
  const keyword = query.keyword ?? "";
  if (!keyword.trim()) {
    sendApiError(res, 400, "INVALID_REQUEST", "Keyword is required.");
    return;
  }
  const requestedLimit = Number.parseInt(query.limit ?? "10", 10);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, 50)
    : 10;
  const decoded = decodeURIComponent(keyword);
  logger.debug("[aso-dashboard] request", {
    method: "GET",
    path: "/api/aso/top-apps",
    country,
    keyword: decoded,
    limit,
  });
  const kw = getKeyword(country, decoded);
  if (!kw) {
    sendApiError(res, 404, "NOT_FOUND", "Keyword not found.");
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
      reportDashboardError(err, {
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
  sendJson(res, 200, { success: true, data: { keyword: kw.keyword, appDocs } });
}

function handleApiAsoAppsGet(
  res: http.ServerResponse,
  query: Record<string, string>
): Promise<void> {
  const country = (query.country ?? "US").toUpperCase();
  const forceRefresh = isTruthyQueryParam(query.refresh);
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
    sendJson(res, 200, { success: true, data: [] });
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
    sendJson(res, 200, { success: true, data: docs });
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
      sendJson(res, 200, { success: true, data: merged });
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      reportDashboardError(err, {
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
      sendJson(res, 200, { success: true, data: docs });
    });
}

export function createServerRequestHandler(): http.RequestListener {
  return async (req, res) => {
    const url = req.url ?? "/";
    const [pathname] = url.split("?");
    const query = parseQuery(url);

    if (req.method === "GET" && pathname === "/") {
      sendStaticFile(res, path.join(DASHBOARD_PUBLIC_DIR, "index.html"));
      return;
    }

    if (req.method === "GET" && pathname === "/health") {
      sendJson(res, 200, { success: true });
      return;
    }

    if (req.method === "GET" && pathname === DASHBOARD_RUNTIME_CONFIG_PATH) {
      sendDashboardRuntimeConfig(res);
      return;
    }

    if (req.method === "GET" && pathname === "/api/apps") {
      ensureDefaultResearchAppExists();
      const appLastAddedAt = getAppLastKeywordAddedAtMap("US");
      const apps = listApps()
        .map((app) => ({
          ...app,
          lastKeywordAddedAt: appLastAddedAt.get(app.id) ?? null,
        }))
        .sort((a, b) => {
          const ad = a.lastKeywordAddedAt ?? "";
          const bd = b.lastKeywordAddedAt ?? "";
          if (ad && bd && ad !== bd) return bd.localeCompare(ad);
          if (ad && !bd) return -1;
          if (!ad && bd) return 1;
          return a.name.localeCompare(b.name);
        });
      sendJson(res, 200, { success: true, data: apps });
      return;
    }

    if (req.method === "POST" && pathname === "/api/apps") {
      await runAsForegroundMutation(() => handleApiAppsPost(req, res));
      return;
    }

    if (req.method === "GET" && pathname === "/api/aso/auth/status") {
      handleApiAsoAuthStatusGet(res);
      return;
    }

    if (req.method === "GET" && pathname === "/api/aso/refresh-status") {
      handleApiAsoRefreshStatusGet(res);
      return;
    }

    if (req.method === "POST" && pathname === "/api/aso/auth/start") {
      runAsForegroundMutationSync(() => {
        handleApiAsoAuthStartPost(res);
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/aso/keywords") {
      handleApiAsoKeywordsGet(res, query);
      return;
    }

    if (req.method === "GET" && pathname === "/api/aso/top-apps") {
      await handleApiAsoTopAppsGet(res, query);
      return;
    }

    if (req.method === "POST" && pathname === "/api/aso/keywords") {
      await runAsForegroundMutation(() => handleApiAsoKeywordsPost(req, res));
      return;
    }

    if (req.method === "POST" && pathname === "/api/aso/keywords/retry-failed") {
      await runAsForegroundMutation(() =>
        handleApiAsoKeywordsRetryFailedPost(req, res)
      );
      return;
    }

    if (req.method === "DELETE" && pathname === "/api/aso/keywords") {
      await runAsForegroundMutation(() => handleApiAsoKeywordsDelete(req, res));
      return;
    }

    if (req.method === "GET" && pathname === "/api/aso/apps") {
      await handleApiAsoAppsGet(res, query);
      return;
    }

    if (req.method === "GET" && pathname && !pathname.startsWith("/api/")) {
      const staticPath = resolveStaticPath(pathname);
      if (staticPath && fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
        sendStaticFile(res, staticPath);
        return;
      }
      sendStaticFile(res, path.join(DASHBOARD_PUBLIC_DIR, "index.html"));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  };
}

export function createServer(): http.Server {
  return http.createServer(createServerRequestHandler());
}

export function startDashboard(openBrowser: boolean = true): Promise<never> {
  return new Promise((_, reject) => {
    const server = createServer();
    let boundPort = DEFAULT_PORT;
    let retriedWithDynamicPort = false;

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && !retriedWithDynamicPort) {
        retriedWithDynamicPort = true;
        boundPort = 0;
        logger.debug(
          `ASO dashboard port ${DEFAULT_PORT} is busy; retrying with an available local port.`
        );
        server.listen(0, "127.0.0.1");
        return;
      }

      if (err.code === "EADDRINUSE") {
        logger.error(
          `ASO dashboard failed to start: no available local port found after retry (last attempted: ${boundPort}).`
        );
        reject(
          new Error(
            `Failed to start ASO dashboard: no available local port found after retry (last attempted: ${boundPort}).`
          )
        );
        return;
      }
      if (err.code === "EACCES" || err.code === "EPERM") {
        logger.error(
          `ASO dashboard failed to start: cannot bind to 127.0.0.1:${boundPort} (${err.code}).`
        );
        reject(
          new Error(
            `Cannot bind dashboard to 127.0.0.1:${boundPort} (${err.code}).`
          )
        );
        return;
      }
      reject(err);
    });

    server.listen(DEFAULT_PORT, "127.0.0.1", () => {
      const address = server.address();
      const activePort =
        address && typeof address === "object" && "port" in address
          ? address.port
          : boundPort;
      const url = `http://127.0.0.1:${activePort}`;
      logger.info(`ASO Dashboard: ${url}`);
      startupRefreshManager.start();
      if (openBrowser) {
        try {
          const { exec } = require("child_process");
          const open = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
          exec(`${open} ${url}`);
        } catch {
          // ignore
        }
      }
    });
  });
}
