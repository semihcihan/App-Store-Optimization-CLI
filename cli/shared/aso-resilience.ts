import { ASO_ENV } from "./aso-env";

export type AsoResilienceConfig = {
  maxAttempts: number;
  baseDelayMs: number;
  rateLimitBaseDelayMs: number;
  maxDelayMs: number;
  jitterFactor: number;
  keywordEnrichmentConcurrency: number;
};

export function getAsoResilienceConfig(): AsoResilienceConfig {
  const maxAttempts = ASO_ENV.retryMaxAttempts;
  const baseDelayMs = ASO_ENV.retryBaseDelayMs;
  const maxDelayMs = ASO_ENV.retryMaxDelayMs;
  const rateLimitBaseDelayMs = ASO_ENV.rateLimitBaseDelayMs;
  const jitterFactor = ASO_ENV.retryJitterFactor;
  const keywordEnrichmentConcurrency = ASO_ENV.keywordEnrichmentConcurrency;

  return {
    maxAttempts,
    baseDelayMs,
    rateLimitBaseDelayMs,
    maxDelayMs,
    jitterFactor,
    keywordEnrichmentConcurrency,
  };
}
