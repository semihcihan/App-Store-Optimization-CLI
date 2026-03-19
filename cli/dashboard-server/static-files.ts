import * as fs from "fs";
import * as http from "http";
import * as path from "path";

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

export function sendStaticFile(
  res: http.ServerResponse,
  filePath: string
): void {
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

export function sendDashboardRuntimeConfig(
  res: http.ServerResponse,
  nodeEnv: string,
  bugsnagVerboseTraces: boolean
): void {
  const payload = `window.__ASO_DASHBOARD_RUNTIME__=${JSON.stringify({
    nodeEnv,
    bugsnagVerboseTraces,
  })};`;
  res.writeHead(200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
  });
  res.end(payload);
}

export function resolveStaticPath(
  dashboardPublicDir: string,
  pathname: string
): string | null {
  if (!pathname.startsWith("/")) return null;
  const decoded = decodeURIComponent(pathname);
  const relativePath = decoded.replace(/^\/+/, "");
  if (relativePath.includes("..")) return null;
  return path.join(dashboardPublicDir, relativePath);
}

export function staticFileExists(pathname: string): boolean {
  return fs.existsSync(pathname) && fs.statSync(pathname).isFile();
}
