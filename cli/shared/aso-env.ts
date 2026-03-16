export const ASO_DEFAULTS = {
  retryMaxAttempts: 4,
  retryBaseDelayMs: 1000,
  retryMaxDelayMs: 30000,
  rateLimitBaseDelayMs: 5000,
  retryJitterFactor: 0.1,
  keywordEnrichmentConcurrency: 4,
  keywordOrderTtlHours: 24,
  popularityCacheTtlHours: 720,
  appCacheTtlHours: 168,
  ownedAppDocRefreshMaxAgeHours: 24,
} as const;

export type AsoEnvConfig = {
  retryMaxAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  rateLimitBaseDelayMs: number;
  retryJitterFactor: number;
  keywordEnrichmentConcurrency: number;
  keywordOrderTtlHours: number;
  popularityCacheTtlHours: number;
  appCacheTtlHours: number;
  ownedAppDocRefreshMaxAgeMs: number;
};

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function parsePositiveNumber(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function readAsoEnv(
  env:
    | NodeJS.ProcessEnv
    | Record<string, string | undefined> = typeof process === "undefined" || !process?.env
    ? {}
    : process.env
): AsoEnvConfig {
  const retryBaseDelayMs = parsePositiveInt(
    env.ASO_RETRY_BASE_DELAY_MS,
    ASO_DEFAULTS.retryBaseDelayMs
  );
  const retryMaxDelayMs = Math.max(
    retryBaseDelayMs,
    parsePositiveInt(env.ASO_RETRY_MAX_DELAY_MS, ASO_DEFAULTS.retryMaxDelayMs)
  );
  const ownedAppDocRefreshMaxAgeHours = parsePositiveInt(
    env.ASO_OWNED_APP_DOC_REFRESH_MAX_AGE_HOURS,
    ASO_DEFAULTS.ownedAppDocRefreshMaxAgeHours
  );

  return {
    retryMaxAttempts: parsePositiveInt(
      env.ASO_RETRY_MAX_ATTEMPTS,
      ASO_DEFAULTS.retryMaxAttempts
    ),
    retryBaseDelayMs,
    retryMaxDelayMs,
    rateLimitBaseDelayMs: parsePositiveInt(
      env.ASO_RATE_LIMIT_BASE_DELAY_MS,
      ASO_DEFAULTS.rateLimitBaseDelayMs
    ),
    retryJitterFactor: Math.min(
      1,
      parsePositiveNumber(
        env.ASO_RETRY_JITTER_FACTOR,
        ASO_DEFAULTS.retryJitterFactor
      )
    ),
    keywordEnrichmentConcurrency: parsePositiveInt(
      env.ASO_KEYWORD_ENRICHMENT_CONCURRENCY,
      ASO_DEFAULTS.keywordEnrichmentConcurrency
    ),
    keywordOrderTtlHours: parsePositiveInt(
      env.ASO_KEYWORD_ORDER_TTL_HOURS,
      ASO_DEFAULTS.keywordOrderTtlHours
    ),
    popularityCacheTtlHours: parsePositiveInt(
      env.ASO_POPULARITY_CACHE_TTL_HOURS,
      ASO_DEFAULTS.popularityCacheTtlHours
    ),
    appCacheTtlHours: parseNonNegativeInt(
      env.ASO_APP_CACHE_TTL_HOURS,
      ASO_DEFAULTS.appCacheTtlHours
    ),
    ownedAppDocRefreshMaxAgeMs: ownedAppDocRefreshMaxAgeHours * 60 * 60 * 1000,
  };
}
