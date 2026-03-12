import { notifyDashboardError } from "./bugsnag";

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

export const DEFAULT_ASO_COUNTRY = "US";

const APP_STORE_LANGUAGE_BY_COUNTRY: Record<string, string> = {
  US: "en-us",
};

export const APP_STORE_ICON_IMAGE_URL =
  "https://support.apple.com/content/dam/edam/applecare/images/en_US/psp_content/content-block-sm-appstore-icon_2x.png";

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

export function getDashboardApiErrorCode(error: unknown): string | null {
  if (!(error instanceof DashboardApiError)) return null;
  return typeof error.errorCode === "string" ? error.errorCode : null;
}

export function isAuthFlowErrorCode(code: string | null): boolean {
  return (
    code === "AUTH_REQUIRED" ||
    code === "AUTH_IN_PROGRESS" ||
    code === "TTY_REQUIRED"
  );
}

export function authFlowErrorMessage(code: string | null): string {
  if (code === "AUTH_IN_PROGRESS") {
    return "Reauthentication is already in progress. If prompted, complete it in terminal.";
  }
  if (code === "TTY_REQUIRED") {
    return "Reauthentication requires an interactive terminal. Start dashboard from a terminal and retry.";
  }
  return "Apple Search Ads session expired. Reauthenticate to continue.";
}

export function toActionableErrorMessage(
  error: unknown,
  fallbackMessage: string
): string {
  const rawMessage = error instanceof Error ? error.message : String(error ?? "");
  const message = rawMessage.trim();
  const lower = message.toLowerCase();
  const status = error instanceof DashboardApiError ? error.status : null;
  const errorCode = error instanceof DashboardApiError ? error.errorCode : null;
  const isPrimaryAppIdAccessError =
    lower.includes("primary app id") ||
    lower.includes("no_user_owned_apps_found_code") ||
    lower.includes("no user owned apps found");

  if (errorCode === "MISSING_APPLE_CREDENTIALS") {
    return "Apple Search Ads authentication is missing or expired. Run 'aso auth' in a terminal, then retry.";
  }
  if (errorCode === "AUTH_REQUIRED") {
    return "Apple Search Ads session expired. Use Reauthenticate and retry.";
  }
  if (errorCode === "AUTH_IN_PROGRESS") {
    return "Reauthentication is in progress. If prompted, complete it in terminal, then retry.";
  }
  if (errorCode === "TTY_REQUIRED") {
    return "Reauthentication requires an interactive terminal. Start dashboard from terminal and retry.";
  }
  if (isPrimaryAppIdAccessError) {
    return message || "Primary App ID is not accessible for this Apple Ads account.";
  }
  if (errorCode === "AUTHORIZATION_FAILED") {
    return "Authorization failed. Verify your Apple account access and retry.";
  }
  if (errorCode === "RATE_LIMITED") {
    return "Rate limited by upstream API. Wait a bit and retry.";
  }
  if (errorCode === "REQUEST_TIMEOUT") {
    return "Request timed out. Retry in a moment.";
  }
  if (errorCode === "NETWORK_ERROR") {
    return "Network issue while reaching the backend. Check your connection and retry.";
  }
  if (
    status === 401 ||
    status === 403 ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden")
  ) {
    return "Authorization failed. Verify your Apple account access and retry.";
  }
  if (
    status === 429 ||
    lower.includes("too many requests") ||
    lower.includes("rate limit")
  ) {
    return "Rate limited by upstream API. Wait a bit and retry.";
  }
  if (
    lower.includes("request timed out") ||
    lower.includes("timed out") ||
    lower.includes("timeout")
  ) {
    return "Request timed out. Retry in a moment.";
  }
  if (lower.includes("failed to fetch") || lower.includes("networkerror")) {
    return "Network issue while reaching the backend. Check your connection and retry.";
  }

  return fallbackMessage;
}

export async function apiRequest<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
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
    if (!response.ok || !json?.success) {
      throw new DashboardApiError(
        json?.error || json?.message || `Request failed (${response.status})`,
        response.status,
        typeof json?.errorCode === "string" ? json.errorCode : undefined
      );
    }
    return json.data as T;
  } catch (error) {
    notifyDashboardError(error, {
      method,
      path,
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
  const normalizedCountry = country.toUpperCase();
  return (
    APP_STORE_LANGUAGE_BY_COUNTRY[normalizedCountry] ??
    APP_STORE_LANGUAGE_BY_COUNTRY[DEFAULT_ASO_COUNTRY]
  );
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
