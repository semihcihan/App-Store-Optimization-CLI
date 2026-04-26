import { randomUUID } from "crypto";
import { version } from "../../../package.json";
import { getPostHogClient } from "../../shared/telemetry/posthog-shared";
import {
  readAsoConfig,
  writeAsoConfig,
} from "../runtime/aso-config-service";

type PostHogWithPromiseShutdown = {
  shutdown: (shutdownTimeoutMs?: number) => Promise<void> | void;
};

export function getOrCreatePostHogUserId(configPath?: string): string {
  const config = readAsoConfig(configPath);
  const persistedUserId =
    typeof config.userId === "string" ? config.userId.trim() : "";

  if (persistedUserId) {
    return persistedUserId;
  }

  const generatedUserId = randomUUID();

  try {
    writeAsoConfig(
      {
        ...config,
        userId: generatedUserId,
      },
      configPath
    );
  } catch {
    return generatedUserId;
  }

  return generatedUserId;
}

export function trackCliStarted(options?: {
  command?: string;
  now?: Date;
  distinctId?: string;
}): void {
  const client = getPostHogClient();
  if (!client) return;

  const distinctId = options?.distinctId || getOrCreatePostHogUserId();
  const timestamp = (options?.now || new Date()).toISOString();
  const command = options?.command?.trim();

  const userProperties = {
    cli_version: version,
    node_version: process.version,
    ...(command ? { command } : {}),
  };

  client.identify({
    distinctId,
    properties: userProperties,
  });

  client.capture({
    distinctId,
    event: "cli_started",
    properties: {
      $set_once: {
        first_seen_at: timestamp,
      },
      $set: {
        last_seen_at: timestamp,
        ...userProperties,
      },
    },
  });
}

export async function shutdownPostHog(shutdownTimeoutMs = 5000): Promise<void> {
  const client = getPostHogClient() as PostHogWithPromiseShutdown | null;
  if (!client) return;

  try {
    const result = client.shutdown(shutdownTimeoutMs);
    if (
      result &&
      typeof result === "object" &&
      typeof (result as Promise<void>).then === "function"
    ) {
      await result;
    }
  } catch {
    return;
  }
}
