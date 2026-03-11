import axios, { AxiosError, AxiosRequestConfig, AxiosResponse } from "axios";
import { ContextualError } from "../../../utils/error-handling-helpers";
import { logger } from "../../../utils/logger";
import { getAsoResilienceConfig } from "../../keywords/aso-resilience";

const SENSITIVE_HEADER_KEYS = ["authorization", "cookie", "set-cookie", "x-api-key"];

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
  if (Array.isArray(value)) return value[0];
  return value != null ? String(value) : undefined;
}

function shouldRetry(error: AxiosError): boolean {
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
  return message.includes("network") || message.includes("timeout") || message.includes("fetch failed");
}

function calculateJitteredDelay(baseDelay: number): number {
  const { jitterFactor, maxDelayMs } = getAsoResilienceConfig();
  const delayWithJitter = baseDelay + Math.random() * jitterFactor * baseDelay;
  return Math.min(maxDelayMs, delayWithJitter);
}

function parseRetryAfterMs(error: AxiosError): number | null {
  if (error.response?.status !== 429) return null;
  const retryAfterRaw = getHeaderValue(
    error.response.headers as Record<string, unknown> | undefined,
    "retry-after"
  );
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

async function waitBeforeRetry(
  error: AxiosError,
  attempt: number,
  delayMs: number
): Promise<number> {
  const retryAfterMs = parseRetryAfterMs(error);
  if (retryAfterMs != null) {
    const waitedMs = calculateJitteredDelay(retryAfterMs);
    await new Promise((resolve) => setTimeout(resolve, waitedMs));
    return waitedMs;
  }

  if (error.response?.status === 429) {
    const { rateLimitBaseDelayMs, maxDelayMs } = getAsoResilienceConfig();
    const exponentialDelay = rateLimitBaseDelayMs * Math.pow(2, attempt - 1);
    const waitedMs = calculateJitteredDelay(
      Math.min(maxDelayMs, exponentialDelay)
    );
    await new Promise((resolve) => setTimeout(resolve, waitedMs));
    return waitedMs;
  }

  const exponentialDelay = delayMs * Math.pow(2, attempt - 1);
  const waitedMs = calculateJitteredDelay(exponentialDelay);
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

  logger.info(`[${requestId}] ASO APPLE REQ GET ${operation}`, {
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
      const response = await axios.get<T>(url, requestConfig);
      logger.info(`[${requestId}] ASO APPLE RES GET ${operation}`, {
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

      logger.warn(`[${requestId}] ASO APPLE RETRY GET ${operation}`, {
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
