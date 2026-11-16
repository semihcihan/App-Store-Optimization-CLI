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
  headers: Record<string, unknown> | undefined,
  now = Date.now()
): number | null {
  const retryAfterRaw = getHeaderValue(headers, "retry-after")?.trim();
  if (!retryAfterRaw) return null;

  if (/^\d+$/.test(retryAfterRaw)) {
    const delay = Number(retryAfterRaw) * 1000;
    return Number.isFinite(new Date(now + delay).getTime()) ? delay : null;
  }

  if (!/^[a-z]{3}/i.test(retryAfterRaw)) return null;
  const retryAfterDateMs = Date.parse(retryAfterRaw);
  if (Number.isFinite(retryAfterDateMs)) {
    return Math.max(0, retryAfterDateMs - now);
  }

  return null;
}

export function getAppleRetryAfterMs(
  statusCode: number | undefined,
  headers: Record<string, unknown> | undefined,
  now = Date.now()
): number | null {
  return statusCode === 429 || statusCode === 503
    ? parseRetryAfterMs(headers, now)
    : null;
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
  const retryAfterMs = getAppleRetryAfterMs(params.statusCode, params.headers);
  if (retryAfterMs != null) return retryAfterMs;

  const { maxDelayMs } = getAsoResilienceConfig();
  const fallbackBaseDelayMs =
    params.statusCode === 429
      ? params.rateLimitBaseDelayMs
      : params.defaultBaseDelayMs;
  const exponentialDelay =
    fallbackBaseDelayMs * Math.pow(2, params.attempt - 1);
  return Math.min(maxDelayMs, calculateJitteredDelay(exponentialDelay));
}
