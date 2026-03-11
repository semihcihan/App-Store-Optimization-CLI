const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_RATE_LIMIT_BASE_DELAY_MS = 5000;
const DEFAULT_MAX_DELAY_MS = 30000;
const DEFAULT_JITTER_FACTOR = 0.1;
const DEFAULT_KEYWORD_ENRICHMENT_CONCURRENCY = 4;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parsePositiveNumber(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function envValue(name: string): string | undefined {
  if (typeof process === "undefined" || !process?.env) return undefined;
  return process.env[name];
}

export type AsoResilienceConfig = {
  maxAttempts: number;
  baseDelayMs: number;
  rateLimitBaseDelayMs: number;
  maxDelayMs: number;
  jitterFactor: number;
  keywordEnrichmentConcurrency: number;
};

export function getAsoResilienceConfig(): AsoResilienceConfig {
  const maxAttempts = parsePositiveInt(
    envValue("ASO_RETRY_MAX_ATTEMPTS"),
    DEFAULT_MAX_ATTEMPTS
  );
  const baseDelayMs = parsePositiveInt(
    envValue("ASO_RETRY_BASE_DELAY_MS"),
    DEFAULT_BASE_DELAY_MS
  );
  const maxDelayMs = Math.max(
    baseDelayMs,
    parsePositiveInt(
      envValue("ASO_RETRY_MAX_DELAY_MS"),
      DEFAULT_MAX_DELAY_MS
    )
  );
  const rateLimitBaseDelayMs = parsePositiveInt(
    envValue("ASO_RATE_LIMIT_BASE_DELAY_MS"),
    DEFAULT_RATE_LIMIT_BASE_DELAY_MS
  );
  const jitterFactor = Math.min(
    1,
    parsePositiveNumber(envValue("ASO_RETRY_JITTER_FACTOR"), DEFAULT_JITTER_FACTOR)
  );
  const keywordEnrichmentConcurrency = parsePositiveInt(
    envValue("ASO_KEYWORD_ENRICHMENT_CONCURRENCY"),
    DEFAULT_KEYWORD_ENRICHMENT_CONCURRENCY
  );

  return {
    maxAttempts,
    baseDelayMs,
    rateLimitBaseDelayMs,
    maxDelayMs,
    jitterFactor,
    keywordEnrichmentConcurrency,
  };
}
