import { z } from "zod";
import { runAsoCommand, toMcpToolResult } from "../execute-aso-cli";
import { reportBugsnagError } from "../../services/telemetry/error-reporter";
import { ASO_MAX_KEYWORDS } from "../../shared/aso-keyword-limits";
import {
  DEFAULT_ASO_COUNTRY,
  assertSupportedCountry,
  normalizeCountry,
  sanitizeKeywords,
} from "../../domain/keywords/policy";

const DEFAULT_MIN_POPULARITY = 6;
const DEFAULT_MAX_DIFFICULTY = 70;
const ABSOLUTE_MIN_POPULARITY = 6;

type AsoToolKeywordItem = {
  keyword?: unknown;
  popularity?: unknown;
  difficulty?: unknown;
  difficultyScore?: unknown;
  minDifficultyScore?: unknown;
  isBrandKeyword?: unknown;
};

export const asoEvaluateKeywordsInputSchema = z.object({
  keywords: z
    .array(
      z
        .string()
        .min(1)
        .describe(
          "ASO search term candidate. Can be a single word or a multi-word long-tail phrase."
        )
    )
    .min(1)
    .max(ASO_MAX_KEYWORDS)
    .describe(
      "List of ASO search term candidates. Comma-separated entries are split and normalized."
    ),
  minPopularity: z.number().min(ABSOLUTE_MIN_POPULARITY).optional(),
  maxDifficulty: z.number().optional(),
  country: z
    .string()
    .trim()
    .min(2)
    .optional()
    .describe(
      "Optional App Store storefront country code, for example US, DK, GB, DE, FR. Defaults to US."
    ),
  appId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Optional local app id to associate accepted keywords with. Defaults to the research app when omitted."
    ),
});

export type AsoEvaluateKeywordsArgs = z.infer<typeof asoEvaluateKeywordsInputSchema>;

function isMeaningfulToken(token: string): boolean {
  return token.length >= 2 && /[a-z0-9]/.test(token);
}

function isKeywordCandidate(candidate: string): boolean {
  if (!candidate || candidate.length < 2 || candidate.length > 60) {
    return false;
  }
  const words = candidate.split(" ").filter(Boolean);
  if (words.length === 0 || words.length > 4) {
    return false;
  }
  return words.every((word) => isMeaningfulToken(word));
}

function splitKeywords(rawKeywords: string[]): string[] {
  return rawKeywords.flatMap((keyword) => keyword.split(","));
}

function normalizeKeywords(keywords: string[]): string[] {
  return sanitizeKeywords(keywords).filter((keyword) => isKeywordCandidate(keyword));
}

function parseJsonFromStdout(stdout: string): unknown | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function extractItemsPayload(raw: unknown): unknown[] | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const parsed = raw as {
    items?: unknown;
    failedKeywords?: unknown;
  };
  if (!Array.isArray(parsed.items) || !Array.isArray(parsed.failedKeywords)) {
    return null;
  }
  return parsed.items;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
    if (normalized === "1") return true;
    if (normalized === "0") return false;
  }
  return null;
}

function mapAsoResultItem(raw: unknown): {
  keyword: string;
  popularity: number | null;
  difficulty: number | null;
  minDifficultyScore: number | null;
  isBrandKeyword: boolean | null;
} {
  const item = (raw ?? {}) as AsoToolKeywordItem;
  return {
    keyword: asString(item.keyword),
    popularity: asNumber(item.popularity),
    difficulty: asNumber(item.difficulty ?? item.difficultyScore),
    minDifficultyScore: asNumber(item.minDifficultyScore),
    isBrandKeyword: asBoolean(item.isBrandKeyword),
  };
}

function buildFailureResult(message: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: message,
      },
    ],
    isError: true,
  };
}

export async function handleAsoEvaluateKeywords(args: AsoEvaluateKeywordsArgs) {
  const country = normalizeCountry(args.country ?? DEFAULT_ASO_COUNTRY);
  try {
    assertSupportedCountry(country);
  } catch (error) {
    return buildFailureResult(
      error instanceof Error ? error.message : "Unsupported country code."
    );
  }
  const minPopularity = Math.max(
    args.minPopularity ?? DEFAULT_MIN_POPULARITY,
    ABSOLUTE_MIN_POPULARITY
  );
  const maxDifficulty = args.maxDifficulty ?? DEFAULT_MAX_DIFFICULTY;
  const appId = args.appId;
  const providedKeywords = splitKeywords(args.keywords);
  const keywords = normalizeKeywords(providedKeywords);

  if (providedKeywords.length > ASO_MAX_KEYWORDS) {
    return buildFailureResult(
      `Too many keywords: received ${providedKeywords.length}, max is ${ASO_MAX_KEYWORDS}.`
    );
  }
  if (keywords.length === 0) {
    return buildFailureResult("No valid keywords were found in `keywords`.");
  }

  const keywordsArg = keywords.join(",");
  const commandArgs = [
    "keywords",
    keywordsArg,
    "--stdout",
    "--country",
    country,
    "--min-popularity",
    String(minPopularity),
    "--max-difficulty",
    String(maxDifficulty),
  ];
  if (appId) {
    commandArgs.push("--app-id", appId);
  }

  const commandResult = await runAsoCommand(commandArgs);
  if (commandResult.exitCode !== 0) {
    return toMcpToolResult(commandResult);
  }

  const parsedJson = parseJsonFromStdout(commandResult.stdout);
  if (parsedJson == null) {
    reportBugsnagError(new Error("MCP expected JSON output from aso keywords"), {
      surface: "aso-mcp",
      tool: "aso_evaluate_keywords",
      stage: "parse-json",
      operation: "aso_evaluate_keywords.parse-json",
      command: "keywords",
      exitCode: commandResult.exitCode,
      stdoutLength: commandResult.stdout.length,
      stderrLength: commandResult.stderr.length,
      noise_class: "mcp_parse_shape",
      telemetryHint: {
        classification: "user_fault",
        surface: "aso-mcp",
        source: "mcp.aso-evaluate-keywords.parse-json",
        operation: "aso_evaluate_keywords.parse-json",
        stage: "parse",
        tool: "aso_evaluate_keywords",
        isTerminal: true,
      },
    });
    return buildFailureResult(
      "ASO command succeeded but response was not valid JSON."
    );
  }

  const parsedItems = extractItemsPayload(parsedJson);
  if (parsedItems == null) {
    reportBugsnagError(
      new Error(
        "MCP expected `{ items, failedKeywords }` envelope from aso keywords"
      ),
      {
        surface: "aso-mcp",
        tool: "aso_evaluate_keywords",
        stage: "parse-envelope",
        command: "keywords",
        exitCode: commandResult.exitCode,
        stdoutLength: commandResult.stdout.length,
        stderrLength: commandResult.stderr.length,
        telemetryHint: {
          classification: "actionable_bug",
          surface: "aso-mcp",
          source: "mcp.aso-evaluate-keywords.parse-envelope",
          stage: "parse",
          tool: "aso_evaluate_keywords",
        },
      }
    );
    return buildFailureResult(
      "ASO command succeeded but response format was not valid `{ items, failedKeywords }` payload."
    );
  }

  const accepted = parsedItems
    .map(mapAsoResultItem)
    .filter((item) => item.keyword !== "")
    .flatMap((item) => {
      if (item.popularity == null || item.difficulty == null) {
        return [];
      }
      return [
        {
          keyword: item.keyword,
          popularity: item.popularity,
          difficulty: item.difficulty,
          minDifficultyScore: item.minDifficultyScore,
          isBrandKeyword: item.isBrandKeyword ?? false,
        },
      ];
    });

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(accepted, null, 2),
      },
    ],
  };
}
