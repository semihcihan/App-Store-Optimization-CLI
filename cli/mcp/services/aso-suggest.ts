import { z } from "zod";
import { runAsoCommand, toMcpToolResult } from "../execute-aso-cli";
import { saveKeywordsToDefaultResearchApp } from "../../services/keywords/aso-research-keyword-service";
import { reportBugsnagError } from "../../services/telemetry/error-reporter";
import { ASO_MAX_KEYWORDS } from "../../shared/aso-keyword-limits";
import { sanitizeKeywords } from "../../domain/keywords/policy";

const DEFAULT_MIN_POPULARITY = 15;
const DEFAULT_MAX_DIFFICULTY = 70;
const ABSOLUTE_MIN_POPULARITY = 6;

type AsoToolKeywordItem = {
  keyword?: unknown;
  popularity?: unknown;
  difficulty?: unknown;
  difficultyScore?: unknown;
  minDifficultyScore?: unknown;
};

export const asoSuggestInputSchema = z.object({
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
});

export type AsoSuggestArgs = z.infer<typeof asoSuggestInputSchema>;

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

function mapAsoResultItem(raw: unknown): {
  keyword: string;
  popularity: number | null;
  difficulty: number | null;
  minDifficultyScore: number | null;
} {
  const item = (raw ?? {}) as AsoToolKeywordItem;
  return {
    keyword: asString(item.keyword),
    popularity: asNumber(item.popularity),
    difficulty: asNumber(item.difficulty ?? item.difficultyScore),
    minDifficultyScore: asNumber(item.minDifficultyScore),
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

export async function handleAsoSuggest(args: AsoSuggestArgs) {
  const minPopularity = Math.max(
    args.minPopularity ?? DEFAULT_MIN_POPULARITY,
    ABSOLUTE_MIN_POPULARITY
  );
  const maxDifficulty = args.maxDifficulty ?? DEFAULT_MAX_DIFFICULTY;
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
  const commandResult = await runAsoCommand(["keywords", keywordsArg, "--stdout"]);
  if (commandResult.exitCode !== 0) {
    return toMcpToolResult(commandResult);
  }

  const parsedJson = parseJsonFromStdout(commandResult.stdout);
  if (parsedJson == null) {
    reportBugsnagError(new Error("MCP expected JSON output from aso keywords"), {
      surface: "aso-mcp",
      tool: "aso_suggest",
      stage: "parse-json",
      command: "keywords",
      exitCode: commandResult.exitCode,
      stdoutLength: commandResult.stdout.length,
      stderrLength: commandResult.stderr.length,
      telemetryHint: {
        classification: "actionable_bug",
        surface: "aso-mcp",
        source: "mcp.aso-suggest.parse-json",
        stage: "parse",
        tool: "aso_suggest",
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
        tool: "aso_suggest",
        stage: "parse-envelope",
        command: "keywords",
        exitCode: commandResult.exitCode,
        stdoutLength: commandResult.stdout.length,
        stderrLength: commandResult.stderr.length,
        telemetryHint: {
          classification: "actionable_bug",
          surface: "aso-mcp",
          source: "mcp.aso-suggest.parse-envelope",
          stage: "parse",
          tool: "aso_suggest",
        },
      }
    );
    return buildFailureResult(
      "ASO command succeeded but response format was not valid `{ items, failedKeywords }` payload."
    );
  }

  const analyzed = parsedItems
    .map(mapAsoResultItem)
    .filter((item) => item.keyword !== "")
    .map((item) => {
      const popularity = item.popularity;
      const difficulty = item.difficulty;
      const passesPopularity = popularity != null && popularity >= minPopularity;
      const passesDifficulty = difficulty != null && difficulty <= maxDifficulty;
      return {
        ...item,
        passes: passesPopularity && passesDifficulty,
      };
    });

  const accepted = analyzed.flatMap((item) => {
    if (!item.passes || item.popularity == null || item.difficulty == null) {
      return [];
    }
    return [
      {
        keyword: item.keyword,
        popularity: item.popularity,
        difficulty: item.difficulty,
        minDifficultyScore: item.minDifficultyScore,
      },
    ];
  });

  if (accepted.length > 0) {
    try {
      saveKeywordsToDefaultResearchApp(
        accepted.map((item) => item.keyword),
        "US"
      );
    } catch (error) {
      reportBugsnagError(error, {
        surface: "aso-mcp",
        tool: "aso_suggest",
        stage: "persist",
        acceptedCount: accepted.length,
        telemetryHint: {
          classification: "actionable_bug",
          surface: "aso-mcp",
          source: "mcp.aso-suggest.persist",
          stage: "persist",
          tool: "aso_suggest",
        },
      });
      throw error;
    }
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(accepted, null, 2),
      },
    ],
  };
}
