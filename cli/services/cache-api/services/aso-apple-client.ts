import axios, { AxiosError, AxiosRequestConfig, AxiosResponse } from "axios";
import { ContextualError } from "../../../utils/error-handling-helpers";
import { logger } from "../../../utils/logger";
import { getAsoResilienceConfig } from "../../../shared/aso-resilience";
import { getRetryDelayMs } from "../../../shared/aso-retry-delay";
import {
  isRetryableTransientStatusCode,
  isTransientTransportFailure,
} from "../../../shared/aso-transient-error";
import { attachAppleHttpTracing } from "../../keywords/apple-http-trace";

const SENSITIVE_HEADER_KEYS = ["authorization", "cookie", "set-cookie", "x-api-key"];
const asoAppleHttpClient = axios.create();
attachAppleHttpTracing(asoAppleHttpClient, "apple-appstore");

type AsoAppleGetConfig<T = unknown> = AxiosRequestConfig<T> & {
  operation: string;
  maxAttempts?: number;
  delayMs?: number;
};

function generateRequestId(): string {
  return (
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 10)
  );
}

function sanitizeHeaders(
  headers: Record<string, unknown> | undefined
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const sanitized: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    const value = Array.isArray(rawValue) ? rawValue.join(",") : String(rawValue);
    if (SENSITIVE_HEADER_KEYS.some((sensitiveKey) => key.includes(sensitiveKey))) {
      sanitized[rawKey] = "[REDACTED]";
      continue;
    }
    sanitized[rawKey] = value;
  }
  return sanitized;
}

function shouldRetry(error: AxiosError): boolean {
  if (isRetryableTransientStatusCode(error.response?.status)) {
    return true;
  }
  return isTransientTransportFailure({
    code: error.code,
    message: error.message,
  });
}

async function waitBeforeRetry(
  error: AxiosError,
  attempt: number,
  delayMs: number
): Promise<number> {
  const waitedMs = getRetryDelayMs({
    statusCode: error.response?.status,
    headers: error.response?.headers as Record<string, unknown> | undefined,
    attempt,
    defaultBaseDelayMs: delayMs,
    rateLimitBaseDelayMs: getAsoResilienceConfig().rateLimitBaseDelayMs,
  });
  await new Promise((resolve) => setTimeout(resolve, waitedMs));
  return waitedMs;
}

export async function asoAppleGet<T = unknown>(
  url: string,
  config: AsoAppleGetConfig<T>
): Promise<AxiosResponse<T>> {
  const {
    operation,
    maxAttempts = getAsoResilienceConfig().maxAttempts,
    delayMs = getAsoResilienceConfig().baseDelayMs,
    ...requestConfig
  } = config;
  const requestId = generateRequestId();
  const startedAt = Date.now();

  logger.debug(`[${requestId}] ASO APPLE REQ GET ${operation}`, {
    requestId,
    operation,
    method: "GET",
    url,
    params: requestConfig.params,
    headers: sanitizeHeaders(requestConfig.headers as Record<string, unknown> | undefined),
    timeout: requestConfig.timeout,
    maxAttempts,
    timestamp: new Date().toISOString(),
  });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await asoAppleHttpClient.get<T>(url, requestConfig);
      logger.debug(`[${requestId}] ASO APPLE RES GET ${operation}`, {
        requestId,
        operation,
        method: "GET",
        url,
        status: response.status,
        statusText: response.statusText,
        attempt,
        durationMs: Date.now() - startedAt,
        responseHeaders: sanitizeHeaders(
          response.headers as Record<string, unknown> | undefined
        ),
        timestamp: new Date().toISOString(),
      });
      return response;
    } catch (error) {
      const axiosError = error as AxiosError;
      const retryable = shouldRetry(axiosError);

      if (!retryable || attempt >= maxAttempts) {
        logger.error(`[${requestId}] ASO APPLE ERR GET ${operation}`, {
          requestId,
          operation,
          method: "GET",
          url,
          attempt,
          maxAttempts,
          retryable,
          durationMs: Date.now() - startedAt,
          status: axiosError.response?.status,
          statusText: axiosError.response?.statusText,
          code: axiosError.code,
          message: axiosError.message,
          responseHeaders: sanitizeHeaders(
            axiosError.response?.headers as Record<string, unknown> | undefined
          ),
          timestamp: new Date().toISOString(),
        });
        throw error;
      }

      const waitedMs = await waitBeforeRetry(
        axiosError,
        attempt,
        delayMs
      );

      logger.debug(`[${requestId}] ASO APPLE RETRY GET ${operation}`, {
        requestId,
        operation,
        method: "GET",
        url,
        attempt,
        nextAttempt: attempt + 1,
        retryCause:
          axiosError.response?.status === 429
            ? "rate_limit"
            : axiosError.response?.status != null
              ? "upstream_5xx"
              : "network",
        waitedMs: Math.round(waitedMs),
        status: axiosError.response?.status,
        code: axiosError.code,
        message: axiosError.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  throw new ContextualError("ASO apple request loop exhausted unexpectedly", {
    operation,
    url,
    maxAttempts,
  });
}
