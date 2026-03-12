import axios from "axios";
import { logger } from "../../utils/logger";
import { getAsoResilienceConfig } from "./aso-resilience";
import {
  attachAppleHttpTracing,
  withAppleHttpTraceContext,
} from "./apple-http-trace";

const APPLE_POPULARITY_URL =
  "https://app-ads.apple.com/cm/api/v2/keywords/popularities";
const KWS_NO_ORG_CONTENT_PROVIDERS = "KWS_NO_ORG_CONTENT_PROVIDERS";
const TRANSIENT_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

export interface PopularityItem {
  name: string;
  popularity: number | null;
}

export interface PopularityResponse {
  status?: string;
  data?: PopularityItem[];
  internalErrorCode?: string;
  requestID?: string;
  error?: {
    errors?: Array<{
      messageCode?: string;
      message?: string;
      field?: string;
    }>;
  };
}

const applePopularityClient = axios.create({
  timeout: 30000,
  validateStatus: () => true,
});
attachAppleHttpTracing(applePopularityClient, "apple-search-ads");

function firstMessageCode(data: PopularityResponse): string | undefined {
  return data.error?.errors?.[0]?.messageCode;
}

function isNoOrgContentProvidersError(
  statusCode: number,
  data: PopularityResponse
): boolean {
  return statusCode === 403 && firstMessageCode(data) === KWS_NO_ORG_CONTENT_PROVIDERS;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestPopularitiesOnce(
  terms: string[],
  cookieHeader: string,
  adamId: string
): Promise<{
  statusCode: number;
  data: PopularityResponse;
  headers?: Record<string, unknown>;
}> {
  const requestUrl = `${APPLE_POPULARITY_URL}?adamId=${encodeURIComponent(adamId)}`;
  const requestBody = {
    storefronts: [],
    terms,
  };
  const requestHeaders = {
    Origin: "https://app-ads.apple.com",
    Cookie: cookieHeader,
  };
  try {
    const response = await applePopularityClient.post<PopularityResponse>(
      requestUrl,
      requestBody,
      {
        headers: requestHeaders,
      }
    );

    return {
      statusCode: response.status,
      data: response.data || {},
      headers: response.headers as Record<string, unknown> | undefined,
    };
  } catch (error) {
    throw withAppleHttpTraceContext(error, {
      provider: "apple-search-ads",
      operation: "keywords-popularities-request",
      context: {
        adamId,
        termsCount: terms.length,
      },
    });
  }
}

function getHeaderValue(
  headers: Record<string, unknown> | undefined,
  headerName: string
): string | undefined {
  if (!headers) return undefined;
  const match = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === headerName.toLowerCase()
  );
  if (!match) return undefined;
  const value = match[1];
  if (Array.isArray(value)) return value[0] != null ? String(value[0]) : undefined;
  return value != null ? String(value) : undefined;
}

function parseRetryAfterMs(headers: Record<string, unknown> | undefined): number | null {
  const retryAfterRaw = getHeaderValue(headers, "retry-after");
  if (!retryAfterRaw) return null;

  const retryAfterSeconds = Number.parseInt(retryAfterRaw, 10);
  if (Number.isFinite(retryAfterSeconds)) {
    return Math.max(0, retryAfterSeconds * 1000);
  }

  const retryAfterDateMs = Date.parse(retryAfterRaw);
  if (Number.isFinite(retryAfterDateMs)) {
    return Math.max(0, retryAfterDateMs - Date.now());
  }

  return null;
}

function calculateJitteredDelay(baseDelayMs: number): number {
  const { jitterFactor, maxDelayMs } = getAsoResilienceConfig();
  const jittered = baseDelayMs + Math.random() * jitterFactor * baseDelayMs;
  return Math.min(maxDelayMs, jittered);
}

function getRetryDelayMs(params: {
  statusCode: number;
  headers?: Record<string, unknown>;
  attempt: number;
}): number {
  const retryAfterMs =
    params.statusCode === 429 ? parseRetryAfterMs(params.headers) : null;
  if (retryAfterMs != null) {
    return calculateJitteredDelay(retryAfterMs);
  }

  const { baseDelayMs, rateLimitBaseDelayMs, maxDelayMs } =
    getAsoResilienceConfig();
  const fallbackBaseDelayMs =
    params.statusCode === 429 ? rateLimitBaseDelayMs : baseDelayMs;
  const exponentialDelay =
    fallbackBaseDelayMs * Math.pow(2, params.attempt - 1);
  return Math.min(maxDelayMs, calculateJitteredDelay(exponentialDelay));
}

function isTransientStatus(statusCode: number, data: PopularityResponse): boolean {
  if (isNoOrgContentProvidersError(statusCode, data)) return true;
  return TRANSIENT_STATUS_CODES.has(statusCode);
}

function isTransientAxiosError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  if (error.response?.status != null) {
    return error.response.status === 429 || error.response.status >= 500;
  }
  const code = error.code ?? "";
  if (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_SOCKET" ||
    code === "UND_ERR_ABORTED" ||
    code === "UND_ERR_DESTROYED"
  ) {
    return true;
  }
  const message = (error.message ?? "").toLowerCase();
  return (
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("fetch failed")
  );
}

export async function requestPopularitiesWithKwsRetry(
  terms: string[],
  cookieHeader: string,
  adamId: string
): Promise<{ statusCode: number; data: PopularityResponse; attempts: number }> {
  const { maxAttempts } = getAsoResilienceConfig();
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await requestPopularitiesOnce(terms, cookieHeader, adamId);
      const retryable = isTransientStatus(response.statusCode, response.data);
      if (!retryable || attempt >= maxAttempts) {
        return {
          statusCode: response.statusCode,
          data: response.data,
          attempts: attempt,
        };
      }
      const delayMs = getRetryDelayMs({
        statusCode: response.statusCode,
        headers: response.headers,
        attempt,
      });
      const cause = isNoOrgContentProvidersError(response.statusCode, response.data)
        ? "kws_no_org_content_providers"
        : response.statusCode === 429
          ? "rate_limit"
          : "upstream_error";
      logger.debug(
        `[aso-popularity] transient response status=${response.statusCode} requestID=${
          response.data.requestID || "none"
        } cause=${cause}; retrying (${attempt + 1}/${maxAttempts}) after ${Math.round(delayMs)}ms`
      );
      await wait(delayMs);
    } catch (error) {
      const retryable = isTransientAxiosError(error);
      if (!retryable || attempt >= maxAttempts) {
        throw error;
      }
      const delayMs = getRetryDelayMs({
        statusCode: (axios.isAxiosError(error) ? error.response?.status : 0) ?? 0,
        headers: axios.isAxiosError(error)
          ? (error.response?.headers as Record<string, unknown> | undefined)
          : undefined,
        attempt,
      });
      logger.debug(
        `[aso-popularity] transient request error cause=network; retrying (${attempt + 1}/${maxAttempts}) after ${Math.round(delayMs)}ms`
      );
      await wait(delayMs);
    }
  }
  throw new Error("Popularity request retry loop exhausted unexpectedly");
}
