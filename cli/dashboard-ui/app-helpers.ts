import { notifyDashboardError } from "./bugsnag";
import {
  authFlowErrorMessage as authFlowErrorMessageFromDomain,
  isAuthFlowErrorCode as isAuthFlowErrorCodeFromDomain,
  toDashboardActionableErrorMessage,
} from "../domain/errors/dashboard-errors";
import { DEFAULT_ASO_COUNTRY as DOMAIN_DEFAULT_ASO_COUNTRY } from "../domain/keywords/policy";
import {
  buildSensitiveKeyMatcher,
  pushBoundedEntry,
  sanitizeTelemetryUrl,
  sanitizeTelemetryValue,
} from "../shared/telemetry/trace-utils";
import { getStorefrontDefaultLanguage } from "../shared/aso-storefront-localizations";
import { isDashboardVerboseTraceEnabled } from "./runtime-config";

export type AppDoc = {
  appId: string;
  name: string;
  subtitle?: string;
  averageUserRating?: number | null;
  userRatingCount?: number | null;
  previousAverageUserRating?: number | null;
  previousUserRatingCount?: number | null;
  releaseDate?: string | null;
  currentVersionReleaseDate?: string | null;
  icon?: Record<string, unknown>;
  iconArtwork?: { url?: string; [key: string]: unknown };
  artworkUrl100?: string;
  artworkUrl512?: string;
};

export type Row = {
  keyword: string;
  popularity: number;
  difficultyScore: number | null;
  appCount: number | null;
  updatedAt?: string;
  previousPosition: number | null;
  currentPosition: number | null;
};

export type KeywordDetails = {
  keyword: string;
  appDocs: AppDoc[];
};

export type TopAppRow = AppDoc & {
  rank: number;
};

export const DEFAULT_ASO_COUNTRY = DOMAIN_DEFAULT_ASO_COUNTRY;

export const APP_STORE_ICON_IMAGE_URL =
  "https://support.apple.com/content/dam/edam/applecare/images/en_US/psp_content/content-block-sm-appstore-icon_2x.png";
const DASHBOARD_API_TRACE_LIMIT = 10;
const DASHBOARD_API_FAILURE_TRACE_LIMIT = 3;
const SENSITIVE_FIELD_KEYWORDS = [
  "authorization",
  "password",
  "token",
  "secret",
  "cookie",
  "apikey",
  "api-key",
  "session",
];
const isSensitiveField = buildSensitiveKeyMatcher({
  includes: SENSITIVE_FIELD_KEYWORDS,
});

type DashboardApiTrace = {
  timestamp: string;
  method: "GET" | "POST" | "DELETE";
  path: string;
  durationMs: number;
  request: {
    hasBody: boolean;
    body?: unknown;
  };
  response?: {
    status: number;
    ok: boolean;
    success: boolean;
    errorCode?: string;
  };
  error?: {
    name?: string;
    message: string;
  };
};

const recentDashboardApiTraces: DashboardApiTrace[] = [];

export class DashboardApiError extends Error {
  status: number;
  errorCode?: string;

  constructor(message: string, status: number, errorCode?: string) {
    super(message);
    this.name = "DashboardApiError";
    this.status = status;
    this.errorCode = errorCode;
  }
}

function toTraceError(error: unknown): { name?: string; message: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  return {
    message: String(error),
  };
}

function pushDashboardApiTrace(trace: DashboardApiTrace): void {
  pushBoundedEntry(recentDashboardApiTraces, trace, DASHBOARD_API_TRACE_LIMIT);
}

function getRecentDashboardApiTraces(): DashboardApiTrace[] {
  return recentDashboardApiTraces.map((trace) => ({
    ...trace,
    request: { ...trace.request },
    response: trace.response ? { ...trace.response } : undefined,
    error: trace.error ? { ...trace.error } : undefined,
  }));
}

function isFailedDashboardApiTrace(trace: DashboardApiTrace): boolean {
  if (trace.error) return true;
  if (!trace.response) return false;
  return trace.response.ok === false || trace.response.success === false;
}

function getTelemetryDashboardApiTraces(): DashboardApiTrace[] {
  const traces = getRecentDashboardApiTraces();
  if (isDashboardVerboseTraceEnabled()) {
    return traces;
  }
  return traces
    .filter((trace) => isFailedDashboardApiTrace(trace))
    .slice(-DASHBOARD_API_FAILURE_TRACE_LIMIT);
}

function toDashboardApiOperation(
  method: "GET" | "POST" | "DELETE",
  path: string
): string {
  const operationPath = path.split("?")[0] || path;
  return `${method} ${operationPath}`;
}

export function resetRecentDashboardApiTracesForTests(): void {
  recentDashboardApiTraces.length = 0;
}

export function getDashboardApiErrorCode(error: unknown): string | null {
  if (!(error instanceof DashboardApiError)) return null;
  return typeof error.errorCode === "string" ? error.errorCode : null;
}

export function isAuthFlowErrorCode(code: string | null): boolean {
  return isAuthFlowErrorCodeFromDomain(code);
}

export function authFlowErrorMessage(code: string | null): string {
  return authFlowErrorMessageFromDomain(code);
}

export function toActionableErrorMessage(
  error: unknown,
  fallbackMessage: string
): string {
  return toDashboardActionableErrorMessage(error, fallbackMessage);
}

export async function apiRequest<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  const sanitizedPath = sanitizeTelemetryUrl(path, {
    isSensitiveKey: isSensitiveField,
    baseUrl: "http://dashboard.local",
  });
  const startedAt = Date.now();

  const pushTrace = (entry: Omit<DashboardApiTrace, "timestamp" | "method" | "path" | "durationMs" | "request"> & {
    request?: DashboardApiTrace["request"];
  }) => {
    pushDashboardApiTrace({
      timestamp: new Date().toISOString(),
      method,
      path: sanitizedPath,
      durationMs: Date.now() - startedAt,
      request: entry.request ?? {
        hasBody: body !== undefined,
        body:
          body === undefined
            ? undefined
            : sanitizeTelemetryValue(body, { isSensitiveKey: isSensitiveField }),
      },
      response: entry.response,
      error: entry.error,
    });
  };

  try {
    const response = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: any;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    const responseTrace = {
      status: response.status,
      ok: response.ok,
      success: json?.success === true,
      errorCode: typeof json?.errorCode === "string" ? json.errorCode : undefined,
    };
    if (!response.ok || !json?.success) {
      const dashboardError = new DashboardApiError(
        json?.error || json?.message || `Request failed (${response.status})`,
        response.status,
        typeof json?.errorCode === "string" ? json.errorCode : undefined
      );
      pushTrace({
        response: responseTrace,
        error: toTraceError(dashboardError),
      });
      throw dashboardError;
    }
    pushTrace({
      response: responseTrace,
    });
    return json.data as T;
  } catch (error) {
    if (!(error instanceof DashboardApiError)) {
      pushTrace({
        error: toTraceError(error),
      });
    }
    notifyDashboardError(error, {
      method,
      path: sanitizedPath,
      source: "dashboard-ui.api-request",
      operation: toDashboardApiOperation(method, sanitizedPath),
      isTerminal: true,
      recentApiTraces: getTelemetryDashboardApiTraces(),
    });
    throw error;
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  return apiRequest<T>("GET", path);
}

export async function apiWrite<T>(
  method: "POST" | "DELETE",
  path: string,
  body: unknown
): Promise<T> {
  return apiRequest<T>(method, path, body);
}

export async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  if (typeof document === "undefined") {
    throw new Error("Clipboard is unavailable in this environment.");
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const didCopy = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!didCopy) {
    throw new Error("Copy action was blocked by the browser.");
  }
}

export const normalizeIconUrl = (rawUrl: string): string =>
  String(rawUrl)
    .replace(/\{w\}/g, "100")
    .replace(/\{h\}/g, "100")
    .replace(/\{c\}/g, "")
    .replace(/\{f\}/g, rawUrl.includes("Placeholder.mill") ? "jpeg" : "jpg");

export const getNestedString = (value: unknown, key: string): string | null => {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const v = obj[key];
  return typeof v === "string" ? v : null;
};

export const getIconUrl = (doc: AppDoc | undefined): string | null => {
  if (!doc) return null;

  const iconObj = doc.icon as Record<string, unknown> | undefined;
  const iconTemplate = getNestedString(iconObj, "template");
  const iconUrl = getNestedString(iconObj, "url");
  const iconArtworkUrl =
    typeof doc.iconArtwork?.url === "string" ? doc.iconArtwork.url : null;

  const placeholder = [iconTemplate, iconUrl, iconArtworkUrl].find(
    (v) => typeof v === "string" && v.includes("Placeholder.mill")
  );
  if (placeholder) return normalizeIconUrl(placeholder);

  const candidates = [
    iconTemplate,
    iconUrl,
    iconArtworkUrl,
    doc.artworkUrl512,
    doc.artworkUrl100,
  ].filter((v): v is string => typeof v === "string" && v.length > 0);
  if (candidates.length > 0) return normalizeIconUrl(candidates[0]);

  const srcSet = iconObj?.srcSet;
  if (Array.isArray(srcSet) && srcSet.length > 0) {
    const last = srcSet[srcSet.length - 1];
    if (typeof last === "string") return normalizeIconUrl(last);
    if (last && typeof last === "object") {
      const src = getNestedString(last, "src") ?? getNestedString(last, "url");
      if (src) return normalizeIconUrl(src);
    }
  }

  return null;
};

export const getBrowserLocale = (): string | undefined => {
  if (typeof navigator === "undefined") return undefined;
  if (Array.isArray(navigator.languages) && navigator.languages.length > 0) {
    const first = navigator.languages[0]?.trim();
    if (first) return first;
  }
  const fallback = navigator.language?.trim();
  return fallback || undefined;
};

export const getAppStoreLanguageForCountry = (country: string): string => {
  return getStorefrontDefaultLanguage(country);
};

export const buildAppStoreUrl = (appId: string, country: string): string => {
  const normalizedAppId = appId.trim();
  const countryCode = country.toLowerCase();
  const language = getAppStoreLanguageForCountry(country);
  return `https://apps.apple.com/${countryCode}/app/id${encodeURIComponent(normalizedAppId)}?l=${encodeURIComponent(language)}`;
};

export const getChange = (row: Row): number | null => {
  if (row.previousPosition == null || row.currentPosition == null) return null;
  return row.currentPosition - row.previousPosition;
};

export const formatDate = (value?: string, locale?: string): string => {
  if (!value) return "-";
  const updatedAt = new Date(value);
  if (Number.isNaN(updatedAt.getTime())) return "-";
  const absoluteDate = new Intl.DateTimeFormat(locale).format(updatedAt);

  const diffMs = Date.now() - updatedAt.getTime();
  if (diffMs < 0) return absoluteDate;

  const numberFormatter = new Intl.NumberFormat(locale);
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  if (diffMs < hourMs) {
    const minutes = Math.max(1, Math.floor(diffMs / minuteMs));
    return `${numberFormatter.format(minutes)} min ago`;
  }
  if (diffMs < dayMs) {
    const hours = Math.floor(diffMs / hourMs);
    return `${numberFormatter.format(hours)} hr ago`;
  }
  if (diffMs <= 7 * dayMs) {
    const days = Math.floor(diffMs / dayMs);
    return `${numberFormatter.format(days)} d ago`;
  }

  return absoluteDate;
};

export const formatCalendarDate = (value?: string | null, locale?: string): string => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale).format(date);
};

export const formatCount = (value: number, locale?: string): string =>
  new Intl.NumberFormat(locale).format(value);

export const formatRatingValue = (value: number, locale?: string): string =>
  new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);

export const getNumberDelta = (
  current: number | null | undefined,
  previous: number | null | undefined
): number | null => {
  if (typeof current !== "number" || typeof previous !== "number") return null;
  return current - previous;
};

export const formatSignedNumber = (
  value: number,
  locale?: string,
  fractionDigits: number = 0
): string => {
  const abs = new Intl.NumberFormat(locale, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(Math.abs(value));
  if (value > 0) return `+${abs}`;
  if (value < 0) return `-${abs}`;
  return abs;
};

export const roundTo = (value: number, fractionDigits: number): number =>
  Number(value.toFixed(fractionDigits));

export const buildTopAppRows = (data: KeywordDetails): TopAppRow[] =>
  data.appDocs.map((doc, index) => ({
    rank: index + 1,
    ...doc,
  }));
