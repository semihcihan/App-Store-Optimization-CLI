import { getMetadataValue, setMetadataValue } from "../../db/metadata";
import { getDb } from "../../db/store";
import { getAppleRetryAfterMs } from "../../shared/aso-retry-delay";

export type AppleRetryCooldown = {
  statusCode: 429 | 503;
  retryAt: number;
};

export class AppleRetryCooldownError extends Error {
  constructor(
    readonly statusCode: number,
    readonly retryAt: number,
    message = `Apple request deferred (HTTP ${statusCode}).`
  ) {
    super(`${message} Retry after ${new Date(retryAt).toISOString()}.`);
    this.name = "AppleRetryCooldownError";
  }
}

export function getAppleRetryCooldown(scope: string): AppleRetryCooldown | null {
  const value = getMetadataValue(`apple-retry-until:${scope}`);
  if (!value) return null;
  try {
    const cooldown = JSON.parse(value) as Partial<AppleRetryCooldown> | null;
    if (
      (cooldown?.statusCode === 429 || cooldown?.statusCode === 503) &&
      typeof cooldown.retryAt === "number" &&
      Number.isFinite(new Date(cooldown.retryAt).getTime()) &&
      cooldown.retryAt > Date.now()
    ) {
      return { statusCode: cooldown.statusCode, retryAt: cooldown.retryAt };
    }
  } catch {
    return null;
  }
  return null;
}

export function recordAppleRetryAfter(
  scope: string,
  statusCode: number | undefined,
  headers: Record<string, unknown> | undefined
): AppleRetryCooldown | null {
  if (statusCode !== 429 && statusCode !== 503) return null;
  const now = Date.now();
  const delayMs = getAppleRetryAfterMs(statusCode, headers, now);
  if (delayMs == null || delayMs === 0) return null;
  const cooldown: AppleRetryCooldown = { statusCode, retryAt: now + delayMs };
  return getDb().transaction(() => {
    const active = getAppleRetryCooldown(scope);
    if (active && active.retryAt >= cooldown.retryAt) return active;
    setMetadataValue(`apple-retry-until:${scope}`, JSON.stringify(cooldown));
    return cooldown;
  }).immediate();
}
