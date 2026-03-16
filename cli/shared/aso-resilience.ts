import { readAsoEnv } from "./aso-env";

export type AsoResilienceConfig = {
  maxAttempts: number;
  baseDelayMs: number;
  rateLimitBaseDelayMs: number;
  maxDelayMs: number;
  jitterFactor: number;
  keywordEnrichmentConcurrency: number;
};

export function getAsoResilienceConfig(): AsoResilienceConfig {
  const env = readAsoEnv();
  const maxAttempts = env.retryMaxAttempts;
  const baseDelayMs = env.retryBaseDelayMs;
  const maxDelayMs = env.retryMaxDelayMs;
  const rateLimitBaseDelayMs = env.rateLimitBaseDelayMs;
  const jitterFactor = env.retryJitterFactor;
  const keywordEnrichmentConcurrency = env.keywordEnrichmentConcurrency;

  return {
    maxAttempts,
    baseDelayMs,
    rateLimitBaseDelayMs,
    maxDelayMs,
    jitterFactor,
    keywordEnrichmentConcurrency,
  };
}
