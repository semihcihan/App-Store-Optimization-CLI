import { getMetadataValue, setMetadataValue } from "../../db/metadata";
import { ASO_ENV } from "../../shared/aso-env";
import { promptWithCliAsoPrompt, type AsoPromptHandler } from "../prompts/aso-prompt-handler";
import type { AsoInteractivePromptResponse } from "../../shared/aso-interactive-prompts";

const ASO_POPULARITY_ADAM_ID_METADATA_KEY = "aso-popularity-adam-id";
let runtimeAdamIdOverride: string | null = null;

function normalizeAdamId(raw: string): string | null {
  const candidate = raw.trim();
  if (!/^\d+$/.test(candidate)) {
    return null;
  }
  return candidate;
}

export function getSavedAsoAdamId(): string | null {
  const saved = getMetadataValue(ASO_POPULARITY_ADAM_ID_METADATA_KEY);
  if (!saved) return null;
  return normalizeAdamId(saved);
}

export function getConfiguredAsoAdamId(): string | null {
  if (runtimeAdamIdOverride) return runtimeAdamIdOverride;
  const envAdamId = normalizeAdamId(ASO_ENV.primaryAppId || "");
  if (envAdamId) return envAdamId;
  return getSavedAsoAdamId();
}

export function saveAsoAdamId(adamId: string): string {
  const normalized = normalizeAdamId(adamId);
  if (!normalized) {
    throw new Error(
      "Invalid Primary App ID. Please provide a numeric value, e.g. 1234567890."
    );
  }
  setMetadataValue(ASO_POPULARITY_ADAM_ID_METADATA_KEY, normalized);
  runtimeAdamIdOverride = normalized;
  return normalized;
}

export async function resolveAsoAdamId(options?: {
  adamId?: string;
  allowPrompt?: boolean;
  forcePrompt?: boolean;
  promptHandler?: AsoPromptHandler;
}): Promise<string> {
  if (options?.adamId != null) {
    return saveAsoAdamId(options.adamId);
  }

  const configuredAdamId = getConfiguredAsoAdamId();
  if (configuredAdamId && !options?.forcePrompt) return configuredAdamId;

  if (options?.allowPrompt === false) {
    throw new Error(
      configuredAdamId
        ? "Primary App ID must be updated interactively. Run 'aso' in a terminal or use 'aso --primary-app-id <id>', then retry this command with --stdout."
        : "Primary App ID is missing. Run 'aso --primary-app-id <id>' or run 'aso' in a terminal to set it, then retry this command with --stdout."
    );
  }

  const promptResponse: AsoInteractivePromptResponse = options?.promptHandler
    ? await options.promptHandler.prompt({
        kind: "primary_app_id",
        title: "Primary App ID Required",
        message:
          "Enter a Primary App ID that your Apple Search Ads account can access.",
        defaultValue: configuredAdamId ?? undefined,
        placeholder: "1234567890",
      })
    : await promptWithCliAsoPrompt({
        kind: "primary_app_id",
        title: "Primary App ID Required",
        message:
          "Enter Primary App ID (Any App ID that your Apple Ads account has access to):",
        defaultValue: configuredAdamId ?? undefined,
        placeholder: "1234567890",
      });

  if (promptResponse.kind !== "primary_app_id") {
    throw new Error("Primary App ID prompt returned an unexpected response.");
  }

  return saveAsoAdamId(promptResponse.adamId);
}

export function resetAsoAdamIdRuntimeOverrideForTests(): void {
  runtimeAdamIdOverride = null;
}
