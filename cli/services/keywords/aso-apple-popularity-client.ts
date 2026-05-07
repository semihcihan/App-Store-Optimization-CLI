import axios from "axios";
import { logger } from "../../utils/logger";
import { getAsoResilienceConfig } from "../../shared/aso-resilience";
import { getRetryDelayMs as getSharedRetryDelayMs } from "../../shared/aso-retry-delay";
import {
  isKnownTransientStatusCode,
  isRetryableTransientStatusCode,
  isTransientTransportFailure,
} from "../../shared/aso-transient-error";
import {
  attachAppleHttpTracing,
  withAppleHttpTraceContext,
} from "./apple-http-trace";

const APPLE_POPULARITY_URL =
  "https://app-ads.apple.com/cm/api/v2/keywords/popularities";
const KWS_NO_ORG_CONTENT_PROVIDERS = "KWS_NO_ORG_CONTENT_PROVIDERS";

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
      isTerminal: false,
    });
  }
}

function getRetryDelayMs(params: {
  statusCode: number;
  headers?: Record<string, unknown>;
  attempt: number;
}): number {
  const { baseDelayMs, rateLimitBaseDelayMs } = getAsoResilienceConfig();
  return getSharedRetryDelayMs({
    statusCode: params.statusCode,
    headers: params.headers,
    attempt: params.attempt,
    defaultBaseDelayMs: baseDelayMs,
    rateLimitBaseDelayMs,
  });
}

function isTransientStatus(statusCode: number, data: PopularityResponse): boolean {
  if (isNoOrgContentProvidersError(statusCode, data)) return true;
  return isKnownTransientStatusCode(statusCode);
}

function isTransientAxiosError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  if (isRetryableTransientStatusCode(error.response?.status)) return true;
  return isTransientTransportFailure({
    code: error.code,
    message: error.message,
  });
}

export async function requestPopularitiesWithKwsRetry(
  terms: string[],
  cookieHeader: string,
  adamId: string,
  options?: { maxAttempts?: number }
): Promise<{ statusCode: number; data: PopularityResponse; attempts: number }> {
  const maxAttempts = Math.max(
    1,
    options?.maxAttempts ?? getAsoResilienceConfig().maxAttempts
  );
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
        throw withAppleHttpTraceContext(error, {
          provider: "apple-search-ads",
          operation: "keywords-popularities-request",
          context: {
            adamId,
            termsCount: terms.length,
            attempt,
            maxAttempts,
          },
          isTerminal: true,
        });
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
