import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../execute-aso-cli", () => ({
  runAsoCommand: jest.fn(),
  toMcpToolResult: jest.fn((result: { stderr?: string; stdout?: string }) => ({
    content: [{ type: "text", text: `Error: ${result.stderr || result.stdout || ""}` }],
    isError: true,
  })),
}));

jest.mock("../../services/telemetry/error-reporter", () => ({
  reportBugsnagError: jest.fn(),
}));

import { runAsoCommand } from "../execute-aso-cli";
import {
  asoEvaluateKeywordsInputSchema,
  handleAsoEvaluateKeywords,
} from "./aso-evaluate-keywords";
import { reportBugsnagError } from "../../services/telemetry/error-reporter";

describe("aso_evaluate_keywords service", () => {
  const mockRunAsoCommand = jest.mocked(runAsoCommand);
  const mockReportBugsnagError = jest.mocked(reportBugsnagError);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("runs `aso keywords <terms> --stdout` with default thresholds", async () => {
    mockRunAsoCommand.mockResolvedValue({
      stdout: JSON.stringify({
        items: [{ keyword: "foo", popularity: 80, difficulty: 10 }],
        failedKeywords: [],
      }),
      stderr: "",
      exitCode: 0,
    });

    await handleAsoEvaluateKeywords({
      keywords: ["Foo", "Bar"],
    });

    expect(mockRunAsoCommand).toHaveBeenCalledWith([
      "keywords",
      "foo,bar",
      "--stdout",
      "--country",
      "US",
      "--min-popularity",
      "6",
      "--max-difficulty",
      "70",
    ]);
  });

  it("accepts comma-separated keywords inside array entries", async () => {
    mockRunAsoCommand.mockResolvedValue({
      stdout: JSON.stringify({
        items: [{ keyword: "foo", popularity: 80, difficulty: 10 }],
        failedKeywords: [],
      }),
      stderr: "",
      exitCode: 0,
    });

    await handleAsoEvaluateKeywords({
      keywords: ["Foo, Bar"],
    });

    expect(mockRunAsoCommand).toHaveBeenCalledWith([
      "keywords",
      "foo,bar",
      "--stdout",
      "--country",
      "US",
      "--min-popularity",
      "6",
      "--max-difficulty",
      "70",
    ]);
  });

  it("returns MCP error when more than 100 keywords are provided", async () => {
    const result = await handleAsoEvaluateKeywords({
      keywords: Array.from({ length: 101 }, (_, index) => `kw${index}`),
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain("Too many keywords");
    expect(mockRunAsoCommand).not.toHaveBeenCalled();
  });

  it("returns only accepted keywords with compact fields", async () => {
    mockRunAsoCommand.mockResolvedValue({
      stdout: JSON.stringify({
        items: [
          {
            keyword: "romantic",
            popularity: 20,
            difficulty: 40,
            minDifficultyScore: 51.43,
            isBrandKeyword: true,
            appCount: 179,
            keywordMatch: "titleAllWords",
          },
        ],
        failedKeywords: [{ keyword: "failed", stage: "enrichment" }],
        filteredOut: [
          { keyword: "story game", reason: "low_popularity", popularity: 10 },
        ],
      }),
      stderr: "",
      exitCode: 0,
    });

    const result = await handleAsoEvaluateKeywords({
      keywords: ["romantic", "story game"],
      minPopularity: 15,
      maxDifficulty: 50,
    });

    expect(mockRunAsoCommand).toHaveBeenCalledWith([
      "keywords",
      "romantic,story game",
      "--stdout",
      "--country",
      "US",
      "--min-popularity",
      "15",
      "--max-difficulty",
      "50",
    ]);
    expect(result.content[0]?.type).toBe("text");
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual([
      {
        keyword: "romantic",
        popularity: 20,
        difficulty: 40,
        minDifficultyScore: 51.43,
        isBrandKeyword: true,
      },
    ]);
  });

  it("passes app id to CLI when provided", async () => {
    mockRunAsoCommand.mockResolvedValue({
      stdout: JSON.stringify({
        items: [{ keyword: "sleep", popularity: 30, difficulty: 20 }],
        failedKeywords: [],
      }),
      stderr: "",
      exitCode: 0,
    });

    await handleAsoEvaluateKeywords({
      keywords: ["sleep"],
      appId: "123456789",
    });

    expect(mockRunAsoCommand).toHaveBeenCalledWith([
      "keywords",
      "sleep",
      "--stdout",
      "--country",
      "US",
      "--min-popularity",
      "6",
      "--max-difficulty",
      "70",
      "--app-id",
      "123456789",
    ]);
  });

  it("passes country to CLI when provided", async () => {
    mockRunAsoCommand.mockResolvedValue({
      stdout: JSON.stringify({
        items: [{ keyword: "højde", popularity: 5, difficulty: 20 }],
        failedKeywords: [],
      }),
      stderr: "",
      exitCode: 0,
    });

    await handleAsoEvaluateKeywords({
      keywords: ["højde"],
      country: "DK",
    });

    expect(mockRunAsoCommand).toHaveBeenCalledWith([
      "keywords",
      "højde",
      "--stdout",
      "--country",
      "DK",
      "--min-popularity",
      "6",
      "--max-difficulty",
      "70",
    ]);
  });

  it("returns MCP error for unsupported country", async () => {
    const result = await handleAsoEvaluateKeywords({
      keywords: ["height"],
      country: "XX",
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(result.content[0]?.text).toContain('Unsupported country code "XX"');
    expect(mockRunAsoCommand).not.toHaveBeenCalled();
  });

  it("rejects minPopularity lower than 6 at MCP schema boundary", () => {
    const parsed = asoEvaluateKeywordsInputSchema.safeParse({
      keywords: ["sleep"],
      minPopularity: 5,
    });

    expect(parsed.success).toBe(false);
  });

  it("returns MCP error when stdout is not strict envelope payload", async () => {
    mockRunAsoCommand.mockResolvedValue({
      stdout: JSON.stringify([{ keyword: "foo", popularity: 80, difficulty: 10 }]),
      stderr: "",
      exitCode: 0,
    });

    const result = await handleAsoEvaluateKeywords({
      keywords: ["foo"],
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain("not valid `{ items, failedKeywords }` payload");
    expect(mockReportBugsnagError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        surface: "aso-mcp",
        tool: "aso_evaluate_keywords",
        stage: "parse-envelope",
        exitCode: 0,
      })
    );
  });

  it("reports malformed JSON stdout as dedupable user-fault parse noise", async () => {
    mockRunAsoCommand.mockResolvedValue({
      stdout: "not-json",
      stderr: "",
      exitCode: 0,
    });

    const result = await handleAsoEvaluateKeywords({
      keywords: ["foo"],
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(result.content[0]?.text).toContain("not valid JSON");
    expect(mockReportBugsnagError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        surface: "aso-mcp",
        tool: "aso_evaluate_keywords",
        stage: "parse-json",
        operation: "aso_evaluate_keywords.parse-json",
        noise_class: "mcp_parse_shape",
        exitCode: 0,
        telemetryHint: expect.objectContaining({
          classification: "user_fault",
          operation: "aso_evaluate_keywords.parse-json",
          isTerminal: true,
        }),
      })
    );
  });
});
