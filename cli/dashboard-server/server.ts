import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { logger } from "../utils/logger";
import { getAppById, listApps, upsertApps } from "../db/apps";
import { listKeywords } from "../db/aso-keywords";
import { upsertOwnedAppDocs } from "../db/aso-apps";
import {
  listAllAppKeywords,
  getAppLastKeywordAddedAtMap,
} from "../db/app-keywords";
import {
  refreshKeywordsForStartup,
} from "../services/keywords/aso-keyword-service";
import {
  asoAuthService,
} from "../services/auth/aso-auth-service";
import { isAsoAuthReauthRequiredError } from "../services/keywords/aso-popularity-service";
import { reportBugsnagError } from "../services/telemetry/error-reporter";
import {
  DEFAULT_RESEARCH_APP_ID,
  DEFAULT_RESEARCH_APP_NAME,
} from "../shared/aso-research";
import {
  createStartupRefreshManager,
  type StartupRefreshState,
} from "./startup-refresh-manager";
import {
  createAsoRouteHandlers,
  fetchAsoAppDocsFromApi,
} from "./routes/aso-routes";

const DEFAULT_PORT = 3456;
const DEFAULT_APP_DOCS_HYDRATION_COUNTRY = "US";
const DASHBOARD_PUBLIC_DIR = path.resolve(__dirname, "dashboard-public");
const DASHBOARD_RUNTIME_CONFIG_PATH = "/runtime-config.js";
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
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

type DashboardErrorCode =
  | "INVALID_REQUEST"
  | "PAYLOAD_TOO_LARGE"
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
  if (errorCode === "PAYLOAD_TOO_LARGE") return 413;
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
  errorCode: string,
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

class RequestBodyTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestBodyTooLargeError";
  }
}

function getRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      const chunkBuffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(String(chunk));
      totalBytes += chunkBuffer.length;
      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        settled = true;
        reject(
          new RequestBodyTooLargeError(
            `Request payload exceeds ${MAX_REQUEST_BODY_BYTES} bytes`
          )
        );
        req.destroy();
        return;
      }
      chunks.push(chunkBuffer);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function parseJsonBody<T>(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<T | null> {
  try {
    const raw = await getRequestBody(req);
    return JSON.parse(raw) as T;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      sendApiError(
        res,
        413,
        "PAYLOAD_TOO_LARGE",
        "Request payload is too large."
      );
      return null;
    }
    sendApiError(res, 400, "INVALID_REQUEST", "Invalid request payload.");
    return null;
  }
}

async function handleApiAppsPost(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const body = await parseJsonBody<ManualAppAddRequest>(req, res);
  if (!body) {
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
const asoRouteHandlers = createAsoRouteHandlers({
  parseJsonBody,
  sendJson,
  sendApiError,
  reportDashboardError,
  toUserSafeError,
  statusForDashboardErrorCode: (errorCode) =>
    statusForDashboardErrorCode(errorCode as DashboardErrorCode),
  isDashboardAuthInProgress: () => dashboardAuthPromise != null,
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
        asoRouteHandlers.handleApiAsoKeywordsGet(res, query);
        return;
      }

      if (req.method === "GET" && pathname === "/api/aso/top-apps") {
        await asoRouteHandlers.handleApiAsoTopAppsGet(res, query);
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
        const staticPath = resolveStaticPath(pathname);
        if (
          staticPath &&
          fs.existsSync(staticPath) &&
          fs.statSync(staticPath).isFile()
        ) {
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
