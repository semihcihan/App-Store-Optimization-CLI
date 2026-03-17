import * as http from "http";
import * as path from "path";
import { logger } from "../utils/logger";
import {
  listOwnedAppIdsByKind,
  listOwnedApps,
  upsertOwnedAppSnapshots,
} from "../db/owned-apps";
import { listKeywords } from "../db/aso-keywords";
import {
  listAllAppKeywords,
  getAppLastKeywordAddedAtMap,
} from "../db/app-keywords";
import {
  keywordPipelineService,
} from "../services/keywords/keyword-pipeline-service";
import {
  asoAuthService,
} from "../services/auth/aso-auth-service";
import { isAsoAuthReauthRequiredError } from "../services/keywords/aso-popularity-service";
import { reportBugsnagError } from "../services/telemetry/error-reporter";
import {
  mapToDashboardUserSafeError,
  statusForDashboardErrorCode,
  type DashboardErrorCode,
  type DashboardUserSafeError,
} from "../domain/errors/dashboard-errors";
import { DEFAULT_ASO_COUNTRY } from "../domain/keywords/policy";
import {
  createStartupRefreshManager,
  type StartupRefreshState,
} from "./startup-refresh-manager";
import {
  createAsoRouteHandlers,
} from "./routes/aso-routes";
import { sendApiError, sendJson, parseJsonBody } from "./http-utils";
import {
  resolveStaticPath,
  sendDashboardRuntimeConfig,
  sendStaticFile,
  staticFileExists,
} from "./static-files";
import { createDashboardAuthStateManager } from "./auth-state";
import {
  createAppsHandlers,
  ensureDefaultResearchAppExists,
} from "./apps-handler";
import { fetchOwnedAppSnapshotsFromApi } from "./owned-app-details";
import { readAsoEnv } from "../shared/aso-env";

const DEFAULT_PORT = 3456;
const DEFAULT_APP_DOCS_HYDRATION_COUNTRY = DEFAULT_ASO_COUNTRY;
const DASHBOARD_PUBLIC_DIR = path.resolve(__dirname, "dashboard-public");
const DASHBOARD_RUNTIME_CONFIG_PATH = "/runtime-config.js";

let foregroundMutationCount = 0;

function reportDashboardError(
  error: unknown,
  metadata: Record<string, unknown>
): void {
  reportBugsnagError(error, {
    surface: "aso-dashboard-server",
    ...metadata,
  });
}

function toUserSafeError(error: unknown, fallback: string): DashboardUserSafeError {
  return mapToDashboardUserSafeError(error, {
    fallback,
    isAuthReauthRequiredError: isAsoAuthReauthRequiredError,
  });
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
  country: DEFAULT_ASO_COUNTRY,
  listKeywords,
  listAppKeywords: listAllAppKeywords,
  listOwnedAppIds: () => new Set(listOwnedAppIdsByKind("owned")),
  enrichKeywords: (country, items) =>
    keywordPipelineService.refreshStartup(country, items),
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

const dashboardAuthStateManager = createDashboardAuthStateManager({
  reAuthenticate: (options) => asoAuthService.reAuthenticate(options),
  onError: (error) => {
    reportDashboardError(error, {
      method: "POST",
      path: "/api/aso/auth/start",
    });
  },
});

function beginDashboardReauthentication(): boolean {
  return dashboardAuthStateManager.start();
}

function hasInteractiveTerminal(): boolean {
  return dashboardAuthStateManager.canPrompt();
}

function getDashboardAuthState() {
  return dashboardAuthStateManager.getState();
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

const appsHandlers = createAppsHandlers({
  parseJsonBody,
  sendJson,
  sendApiError,
  reportDashboardError,
  fetchOwnedAppSnapshotsFromApi,
  hydrationCountry: DEFAULT_APP_DOCS_HYDRATION_COUNTRY,
});

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
const asoRouteHandlers = createAsoRouteHandlers({
  parseJsonBody,
  sendJson,
  sendApiError,
  reportDashboardError,
  toUserSafeError,
  statusForDashboardErrorCode: (errorCode) =>
    statusForDashboardErrorCode(errorCode as DashboardErrorCode),
  isDashboardAuthInProgress: () => dashboardAuthStateManager.isInProgress(),
  isTruthyQueryParam,
});

export function createServerRequestHandler(): http.RequestListener {
  return async (req, res) => {
    const url = req.url ?? "/";
    const [pathname] = url.split("?");
    try {
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
        sendDashboardRuntimeConfig(res, process.env.NODE_ENV ?? "");
        return;
      }

      if (req.method === "GET" && pathname === "/api/apps") {
        ensureDefaultResearchAppExists();
        let apps = listOwnedApps();
        const nowMs = Date.now();
        const refreshMaxAgeMs = readAsoEnv().ownedAppDocRefreshMaxAgeMs;
        const staleOwnedAppIds = apps
          .filter((app) => app.kind === "owned")
          .map((app) => {
            const fetchedAtMs = Date.parse(app.lastFetchedAt ?? "");
            if (!Number.isFinite(fetchedAtMs) || nowMs - fetchedAtMs >= refreshMaxAgeMs) {
              return app.id;
            }
            return null;
          })
          .filter((id): id is string => id != null);

        if (staleOwnedAppIds.length > 0) {
          try {
            const snapshots = await fetchOwnedAppSnapshotsFromApi(
              DEFAULT_APP_DOCS_HYDRATION_COUNTRY,
              staleOwnedAppIds
            );
            if (snapshots.length > 0) {
              upsertOwnedAppSnapshots(snapshots);
            }
            apps = listOwnedApps();
          } catch (error) {
            reportDashboardError(error, {
              method: "GET",
              path: "/api/apps",
              phase: "owned-app-refresh",
              staleOwnedAppCount: staleOwnedAppIds.length,
            });
          }
        }
        const appLastAddedAt = getAppLastKeywordAddedAtMap(DEFAULT_ASO_COUNTRY);
        const payload = apps
          .map((app) => ({
            id: app.id,
            kind: app.kind,
            name: app.name,
            averageUserRating: app.averageUserRating,
            userRatingCount: app.userRatingCount,
            previousAverageUserRating: app.previousAverageUserRating,
            previousUserRatingCount: app.previousUserRatingCount,
            icon: app.icon,
            expiresAt: app.expiresAt,
            lastFetchedAt: app.lastFetchedAt,
            previousFetchedAt: app.previousFetchedAt,
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
        sendJson(res, 200, { success: true, data: payload });
        return;
      }

      if (req.method === "POST" && pathname === "/api/apps") {
        await runAsForegroundMutation(() =>
          appsHandlers.handleApiAppsPost(req, res)
        );
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
        asoRouteHandlers.handleApiAsoKeywordsGet(res, query);
        return;
      }

      if (req.method === "GET" && pathname === "/api/aso/top-apps") {
        await asoRouteHandlers.handleApiAsoTopAppsGet(res, query);
        return;
      }

      if (req.method === "GET" && pathname === "/api/aso/apps/search") {
        await asoRouteHandlers.handleApiAsoAppsSearchGet(res, query);
        return;
      }

      if (req.method === "POST" && pathname === "/api/aso/keywords") {
        await runAsForegroundMutation(() =>
          asoRouteHandlers.handleApiAsoKeywordsPost(req, res)
        );
        return;
      }

      if (req.method === "POST" && pathname === "/api/aso/keywords/retry-failed") {
        await runAsForegroundMutation(() =>
          asoRouteHandlers.handleApiAsoKeywordsRetryFailedPost(req, res)
        );
        return;
      }

      if (req.method === "DELETE" && pathname === "/api/aso/keywords") {
        await runAsForegroundMutation(() =>
          asoRouteHandlers.handleApiAsoKeywordsDelete(req, res)
        );
        return;
      }

      if (req.method === "GET" && pathname === "/api/aso/apps") {
        await asoRouteHandlers.handleApiAsoAppsGet(res, query);
        return;
      }

      if (req.method === "GET" && pathname && !pathname.startsWith("/api/")) {
        const staticPath = resolveStaticPath(DASHBOARD_PUBLIC_DIR, pathname);
        if (staticPath && staticFileExists(staticPath)) {
          sendStaticFile(res, staticPath);
          return;
        }
        sendStaticFile(res, path.join(DASHBOARD_PUBLIC_DIR, "index.html"));
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    } catch (error) {
      reportDashboardError(error, {
        method: req.method,
        path: pathname,
      });
      if (res.writableEnded) return;
      if (pathname.startsWith("/api/")) {
        sendApiError(
          res,
          500,
          "INTERNAL_ERROR",
          "Internal server error."
        );
        return;
      }
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Internal server error.");
    }
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
