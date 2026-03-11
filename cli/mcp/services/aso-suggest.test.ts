import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../execute-aso-cli", () => ({
  runAsoCommand: jest.fn(),
  toMcpToolResult: jest.fn((result: { stderr?: string; stdout?: string }) => ({
    content: [{ type: "text", text: `Error: ${result.stderr || result.stdout || ""}` }],
    isError: true,
  })),
}));

jest.mock("../../services/keywords/aso-research-keyword-service", () => ({
  saveKeywordsToDefaultResearchApp: jest.fn(),
}));

import { runAsoCommand } from "../execute-aso-cli";
import { handleAsoSuggest } from "./aso-suggest";
import { saveKeywordsToDefaultResearchApp } from "../../services/keywords/aso-research-keyword-service";

describe("aso_suggest service", () => {
  const mockRunAsoCommand = jest.mocked(runAsoCommand);
  const mockSaveKeywordsToDefaultResearchApp = jest.mocked(
    saveKeywordsToDefaultResearchApp
  );

  beforeEach(() => {
    jest.clearAllMocks();
    mockSaveKeywordsToDefaultResearchApp.mockReturnValue(0);
  });

  it("runs `aso keywords <terms> --stdout` for MCP keyword evaluation", async () => {
    mockRunAsoCommand.mockResolvedValue({
      stdout: JSON.stringify([
        { keyword: "foo", popularity: 80, difficulty: 10 },
        { keyword: "bar", popularity: 50, difficulty: 20 },
      ]),
      stderr: "",
      exitCode: 0,
    });

    await handleAsoSuggest({
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
      stdout: JSON.stringify([{ keyword: "foo", popularity: 80, difficulty: 10 }]),
      stderr: "",
      exitCode: 0,
    });

    await handleAsoSuggest({
      keywords: ["Foo, Bar"],
    });

    expect(mockRunAsoCommand).toHaveBeenCalledWith([
      "keywords",
      "foo,bar",
      "--stdout",
    ]);
  });

  it("returns MCP error when more than 100 keywords are provided", async () => {
    const result = await handleAsoSuggest({
      keywords: Array.from({ length: 101 }, (_, index) => `kw${index}`),
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain("Too many keywords");
    expect(mockRunAsoCommand).not.toHaveBeenCalled();
  });

  it("returns only accepted keywords with compact fields", async () => {
    mockRunAsoCommand.mockResolvedValue({
      stdout: JSON.stringify([
        {
          keyword: "romantic",
          popularity: 20,
          difficulty: 40,
          minDifficultyScore: 51.43,
          appCount: 179,
          keywordIncluded: 2,
        },
        {
          keyword: "story game",
          popularity: 10,
          difficulty: 30,
          minDifficultyScore: 22,
          appCount: 55,
          keywordIncluded: 3,
        },
      ]),
      stderr: "",
      exitCode: 0,
    });

    const result = await handleAsoSuggest({
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
    expect(mockSaveKeywordsToDefaultResearchApp).toHaveBeenCalledWith(
      ["romantic"],
      "US"
    );
  });
});
