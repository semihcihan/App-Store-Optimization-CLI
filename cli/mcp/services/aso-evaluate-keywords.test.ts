import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../execute-aso-cli", () => ({
  runAsoCommand: jest.fn(),
  toMcpToolResult: jest.fn((result: { stderr?: string; stdout?: string }) => ({
    content: [{ type: "text", text: `Error: ${result.stderr || result.stdout || ""}` }],
    isError: true,
  })),
}));

jest.mock("../../services/keywords/aso-research-keyword-service", () => ({
  saveKeywordsToResearchApp: jest.fn(),
}));

jest.mock("../../services/telemetry/error-reporter", () => ({
  reportBugsnagError: jest.fn(),
}));

import { runAsoCommand } from "../execute-aso-cli";
import { handleAsoEvaluateKeywords } from "./aso-evaluate-keywords";
import { saveKeywordsToResearchApp } from "../../services/keywords/aso-research-keyword-service";
import { reportBugsnagError } from "../../services/telemetry/error-reporter";

describe("aso_evaluate_keywords service", () => {
  const mockRunAsoCommand = jest.mocked(runAsoCommand);
  const mockSaveKeywordsToResearchApp = jest.mocked(saveKeywordsToResearchApp);
  const mockReportBugsnagError = jest.mocked(reportBugsnagError);

  beforeEach(() => {
    jest.clearAllMocks();
    mockSaveKeywordsToResearchApp.mockReturnValue(0);
  });

  it("runs `aso keywords <terms> --stdout` for MCP keyword evaluation", async () => {
    mockRunAsoCommand.mockResolvedValue({
      stdout: JSON.stringify({
        items: [
          { keyword: "foo", popularity: 80, difficulty: 10 },
          { keyword: "bar", popularity: 50, difficulty: 20 },
        ],
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
            appCount: 179,
            keywordMatch: "titleAllWords",
          },
          {
            keyword: "story game",
            popularity: 10,
            difficulty: 30,
            minDifficultyScore: 22,
            appCount: 55,
            keywordMatch: "subtitleExactPhrase",
          },
        ],
        failedKeywords: [{ keyword: "failed", stage: "enrichment" }],
      }),
      stderr: "",
      exitCode: 0,
    });

    const result = await handleAsoEvaluateKeywords({
      keywords: ["romantic", "story game"],
      minPopularity: 15,
      maxDifficulty: 50,
    });

    expect(result.content[0]?.type).toBe("text");
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual([
      {
        keyword: "romantic",
        popularity: 20,
        difficulty: 40,
        minDifficultyScore: 51.43,
      },
    ]);
    expect(mockSaveKeywordsToResearchApp).toHaveBeenCalledWith(
      ["romantic"],
      "US",
      undefined
    );
  });

  it("saves accepted keywords to the provided app id when specified", async () => {
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

    expect(mockSaveKeywordsToResearchApp).toHaveBeenCalledWith(
      ["sleep"],
      "US",
      "123456789"
    );
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

  it("reports persistence failures and rethrows", async () => {
    mockRunAsoCommand.mockResolvedValue({
      stdout: JSON.stringify({
        items: [{ keyword: "foo", popularity: 90, difficulty: 20 }],
        failedKeywords: [],
      }),
      stderr: "",
      exitCode: 0,
    });
    mockSaveKeywordsToResearchApp.mockImplementation(() => {
      throw new Error("persist failed");
    });

    await expect(
      handleAsoEvaluateKeywords({
        keywords: ["foo"],
      })
    ).rejects.toThrow("persist failed");
    expect(mockReportBugsnagError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "persist failed" }),
      expect.objectContaining({
        surface: "aso-mcp",
        tool: "aso_evaluate_keywords",
        stage: "persist",
      })
    );
  });
});
