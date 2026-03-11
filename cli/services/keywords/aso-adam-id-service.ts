import inquirer from "inquirer";
import { getMetadataValue, setMetadataValue } from "../../db/metadata";

const ASO_POPULARITY_ADAM_ID_METADATA_KEY = "aso-popularity-adam-id";

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

export function saveAsoAdamId(adamId: string): string {
  const normalized = normalizeAdamId(adamId);
  if (!normalized) {
    throw new Error(
      "Invalid Primary App ID. Please provide a numeric value, e.g. 1234567890."
    );
  }
  setMetadataValue(ASO_POPULARITY_ADAM_ID_METADATA_KEY, normalized);
  return normalized;
}

export async function resolveAsoAdamId(options?: {
  adamId?: string;
  allowPrompt?: boolean;
}): Promise<string> {
  if (options?.adamId != null) {
    return saveAsoAdamId(options.adamId);
  }

  const saved = getSavedAsoAdamId();
  if (saved) return saved;

  if (options?.allowPrompt === false) {
    throw new Error(
      "Primary App ID is missing. Run 'aso --primary-app-id <id>' or run 'aso' in a terminal to set it, then retry this command with --stdout."
    );
  }

  const { adamId } = await inquirer.prompt([
    {
      type: "input",
      name: "adamId",
      message:
        "Enter Primary App ID (Any App ID that your Apple Ads account has access to):",
      validate: (input: string) =>
        normalizeAdamId(input)
          ? true
          : "Please enter a numeric Primary App ID, e.g. 1234567890.",
    },
  ]);

  return saveAsoAdamId(String(adamId));
}
