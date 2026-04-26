import { PostHog } from "posthog-node";

let started = false;
let posthogClient: PostHog | null = null;

function normalizeOptional(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function initializePostHog(options: {
  isDevelopment: boolean;
  apiKey: string;
  host?: string;
}): void {
  if (started) return;
  started = true;

  if (options.isDevelopment) return;

  const apiKey = normalizeOptional(options.apiKey);
  if (!apiKey) return;

  const host = normalizeOptional(options.host);

  posthogClient = host ? new PostHog(apiKey, { host }) : new PostHog(apiKey);
}

export function getPostHogClient(): PostHog | null {
  return posthogClient;
}
