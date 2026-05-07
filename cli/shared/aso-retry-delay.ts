import { getAsoResilienceConfig } from "./aso-resilience";

export function getHeaderValue(
  headers: Record<string, unknown> | undefined,
  headerName: string
): string | undefined {
  if (!headers) return undefined;
  const match = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === headerName.toLowerCase()
  );
  if (!match) return undefined;
  const value = match[1];
  if (Array.isArray(value)) {
    return value[0] != null ? String(value[0]) : undefined;
  }
  return value != null ? String(value) : undefined;
}

export function parseRetryAfterMs(
  headers: Record<string, unknown> | undefined
): number | null {
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

export function calculateJitteredDelay(baseDelayMs: number): number {
  const { jitterFactor, maxDelayMs } = getAsoResilienceConfig();
  const jittered = baseDelayMs + Math.random() * jitterFactor * baseDelayMs;
  return Math.min(maxDelayMs, jittered);
}

export function getRetryDelayMs(params: {
  statusCode?: number;
  headers?: Record<string, unknown>;
  attempt: number;
  defaultBaseDelayMs: number;
  rateLimitBaseDelayMs: number;
}): number {
  const retryAfterMs =
    params.statusCode === 429 ? parseRetryAfterMs(params.headers) : null;
  if (retryAfterMs != null) {
    return calculateJitteredDelay(retryAfterMs);
  }

  const { maxDelayMs } = getAsoResilienceConfig();
  const fallbackBaseDelayMs =
    params.statusCode === 429
      ? params.rateLimitBaseDelayMs
      : params.defaultBaseDelayMs;
  const exponentialDelay =
    fallbackBaseDelayMs * Math.pow(2, params.attempt - 1);
  return Math.min(maxDelayMs, calculateJitteredDelay(exponentialDelay));
}
