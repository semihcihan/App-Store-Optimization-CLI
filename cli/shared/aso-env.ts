import * as os from "os";
import * as path from "path";

const DEFAULT_DB_PATH = path.join(os.homedir(), ".aso", "aso-db.sqlite");

export const ASO_DEFAULTS = {
  dbPath: DEFAULT_DB_PATH,
  appleWidgetKeyFallback:
    "a01459d797984726ee0914a7097e53fad42b70e1f08d09294d14523a1d4f61e1",
  authMode: "auto",
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
  dbPath: string;
  primaryAppId: string | null;
  authMode: "auto" | "sirp" | "legacy";
  appleWidgetKey: string | null;
  appleWidgetKeyFallback: string;
  sirpRubyOracle: boolean;
  sirpUseRubyProof: boolean;
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

function parseMode(
  raw: string | undefined
): "auto" | "sirp" | "legacy" {
  if (!raw) return ASO_DEFAULTS.authMode;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "auto" || normalized === "sirp" || normalized === "legacy") {
    return normalized;
  }
  return ASO_DEFAULTS.authMode;
}

function parseTrimmed(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

function parseEnabled(raw: string | undefined): boolean {
  return raw === "1";
}

function readAsoEnv(
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
    dbPath: path.resolve(parseTrimmed(env.ASO_DB_PATH) || ASO_DEFAULTS.dbPath),
    primaryAppId: parseTrimmed(env.ASO_PRIMARY_APP_ID),
    authMode: parseMode(env.ASO_AUTH_MODE),
    appleWidgetKey: parseTrimmed(env.ASO_APPLE_WIDGET_KEY),
    appleWidgetKeyFallback: ASO_DEFAULTS.appleWidgetKeyFallback,
    sirpRubyOracle: parseEnabled(env.ASO_SIRP_RUBY_ORACLE),
    sirpUseRubyProof: parseEnabled(env.ASO_SIRP_USE_RUBY_PROOF),
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

const RESOLVED_ASO_ENV: Readonly<AsoEnvConfig> = Object.freeze(readAsoEnv());

export const ASO_ENV: Readonly<AsoEnvConfig> =
  process.env.NODE_ENV === "test"
    ? new Proxy({} as AsoEnvConfig, {
        get(_target, property: keyof AsoEnvConfig) {
          return readAsoEnv()[property];
        },
      })
    : RESOLVED_ASO_ENV;
