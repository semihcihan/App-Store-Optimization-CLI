import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { logger } from "../utils/logger";

jest.mock("../services/keywords/keyword-pipeline-service", () => ({
  keywordPipelineService: {
    parseKeywords: jest.fn(),
    run: jest.fn(),
  },
}));

jest.mock("../dashboard-server", () => ({
  startDashboard: jest.fn(),
}));

jest.mock("../services/auth/aso-keychain-service", () => ({
  asoKeychainService: {
    clearCredentials: jest.fn(),
  },
}));

jest.mock("../services/auth/aso-cookie-store-service", () => ({
  asoCookieStoreService: {
    clearCookies: jest.fn(),
  },
}));

jest.mock("../services/keywords/aso-adam-id-service", () => ({
  resolveAsoAdamId: jest.fn(),
}));

jest.mock("../services/auth/aso-auth-service", () => ({
  asoAuthService: {
    reAuthenticate: jest.fn(),
  },
}));

jest.mock("../services/keywords/aso-research-keyword-service", () => ({
  saveKeywordsToDefaultResearchApp: jest.fn(),
}));

jest.mock("../utils/logger", () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
  },
}));

import asoCommand from "./aso";
import { keywordPipelineService } from "../services/keywords/keyword-pipeline-service";
import { startDashboard } from "../dashboard-server";
import { asoKeychainService } from "../services/auth/aso-keychain-service";
import { asoCookieStoreService } from "../services/auth/aso-cookie-store-service";
import { resolveAsoAdamId } from "../services/keywords/aso-adam-id-service";
import { asoAuthService } from "../services/auth/aso-auth-service";
import { saveKeywordsToDefaultResearchApp } from "../services/keywords/aso-research-keyword-service";

const STDOUT_INTERACTIVE_AUTH_REQUIRED_MESSAGE =
  "This run needs interactive Apple Search Ads reauthentication. Run 'aso auth' in a terminal, then retry this command with --stdout.";

describe("aso command", () => {
  const mockLogger = jest.mocked(logger);
  const consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(keywordPipelineService.parseKeywords).mockReturnValue([]);
    jest
      .mocked(keywordPipelineService.run)
      .mockResolvedValue({ items: [], failedKeywords: [] } as any);
    jest.mocked(resolveAsoAdamId).mockResolvedValue("1234567890");
    jest.mocked(saveKeywordsToDefaultResearchApp).mockReturnValue(0);
    jest.mocked(asoAuthService.reAuthenticate).mockResolvedValue(
      "cookie=value"
    );
  });

  it("starts dashboard when no keywords are provided", async () => {
    await asoCommand.handler?.({
      country: "US",
      terms: undefined,
    } as any);

    expect(startDashboard).toHaveBeenCalledWith(true);
    expect(resolveAsoAdamId).toHaveBeenCalledWith({
      adamId: undefined,
      allowPrompt: true,
    });
    expect(keywordPipelineService.run).not.toHaveBeenCalled();
  });

  it("resets saved ASO auth state with reset-credentials subcommand", async () => {
    await asoCommand.handler?.({
      subcommand: "reset-credentials",
    } as any);

    expect(asoKeychainService.clearCredentials).toHaveBeenCalledTimes(1);
    expect(asoCookieStoreService.clearCookies).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith(
      "Reset ASO credentials/cookies."
    );
    expect(startDashboard).not.toHaveBeenCalled();
    expect(keywordPipelineService.run).not.toHaveBeenCalled();
    expect(resolveAsoAdamId).not.toHaveBeenCalled();
  });

  it("fetches keywords in `aso keywords` mode", async () => {
    jest.mocked(keywordPipelineService.parseKeywords).mockReturnValue(["term"]);
    jest
      .mocked(keywordPipelineService.run)
      .mockResolvedValue({
        items: [{ keyword: "term", popularity: 42 } as any],
        failedKeywords: [],
      } as any);
    jest.mocked(saveKeywordsToDefaultResearchApp).mockReturnValue(1);

    await asoCommand.handler?.({
      subcommand: "keywords",
      country: "US",
      terms: "term",
    } as any);

    expect(keywordPipelineService.run).toHaveBeenCalledWith("US", ["term"]);
    expect(resolveAsoAdamId).toHaveBeenCalledWith({
      adamId: undefined,
      allowPrompt: true,
    });
    expect(saveKeywordsToDefaultResearchApp).toHaveBeenCalledWith(
      ["term"],
      "US"
    );
    expect(mockLogger.debug).toHaveBeenCalledWith(
      "[aso-keywords] persisted requested keywords to default research app",
      {
        savedCount: 1,
        country: "US",
      }
    );
    expect(startDashboard).not.toHaveBeenCalled();
  });

  it("saves requested keywords when command ends with all-keywords-failed error", async () => {
    jest.mocked(keywordPipelineService.parseKeywords).mockReturnValue(["failed-term"]);
    jest
      .mocked(keywordPipelineService.run)
      .mockRejectedValue(new Error("All keywords failed (1): failed-term:FAILED(500)"));
    jest.mocked(saveKeywordsToDefaultResearchApp).mockReturnValue(1);

    await expect(
      asoCommand.handler?.({
        subcommand: "keywords",
        country: "US",
        terms: "failed-term",
      } as any)
    ).rejects.toThrow("All keywords failed");

    expect(saveKeywordsToDefaultResearchApp).toHaveBeenCalledWith(
      ["failed-term"],
      "US"
    );
    expect(mockLogger.debug).toHaveBeenCalledWith(
      "[aso-keywords] persisted requested keywords to default research app",
      {
        savedCount: 1,
        country: "US",
      }
    );
  });

  it("saves provided primary app id and reuses it for this run", async () => {
    await asoCommand.handler?.({
      country: "US",
      terms: undefined,
      "primary-app-id": "555666777",
    } as any);

    expect(resolveAsoAdamId).toHaveBeenCalledWith({
      adamId: "555666777",
      allowPrompt: true,
    });
    expect(startDashboard).toHaveBeenCalledWith(true);
  });

  it("runs `aso auth` subcommand and only performs reauthentication", async () => {
    await asoCommand.handler?.({
      subcommand: "auth",
    } as any);

    expect(asoAuthService.reAuthenticate).toHaveBeenCalledTimes(1);
    expect(resolveAsoAdamId).not.toHaveBeenCalled();
    expect(startDashboard).not.toHaveBeenCalled();
    expect(keywordPipelineService.run).not.toHaveBeenCalled();
  });

  it("fails fast when --stdout is used without keyword terms in keywords mode", async () => {
    await expect(
      asoCommand.handler?.({
        subcommand: "keywords",
        country: "US",
        stdout: true,
        terms: undefined,
      } as any)
    ).rejects.toThrow(
      "`aso keywords` requires a comma-separated keyword argument."
    );

    expect(resolveAsoAdamId).not.toHaveBeenCalled();
    expect(keywordPipelineService.run).not.toHaveBeenCalled();
  });

  it("fails fast when more than 100 keywords are provided", async () => {
    const tooManyKeywords = Array.from({ length: 101 }, (_, index) => `term-${index}`);
    jest.mocked(keywordPipelineService.parseKeywords).mockReturnValue(tooManyKeywords);

    await expect(
      asoCommand.handler?.({
        subcommand: "keywords",
        country: "US",
        terms: tooManyKeywords.join(","),
      } as any)
    ).rejects.toThrow("A maximum of 100 keywords is supported per call");

    expect(resolveAsoAdamId).not.toHaveBeenCalled();
    expect(keywordPipelineService.run).not.toHaveBeenCalled();
  });

  it("rejects keyword flags on dashboard command", async () => {
    await expect(
      asoCommand.handler?.({
        country: "US",
        terms: "term",
      } as any)
    ).rejects.toThrow(
      "Keyword options are only supported in `aso keywords`."
    );
  });

  it("uses non-interactive keyword fetch in --stdout mode and prints JSON", async () => {
    const result = {
      items: [{ keyword: "term", popularity: 42 }],
      failedKeywords: [],
    };
    jest.mocked(keywordPipelineService.parseKeywords).mockReturnValue(["term"]);
    jest.mocked(keywordPipelineService.run).mockResolvedValue(result as any);

    await asoCommand.handler?.({
      subcommand: "keywords",
      country: "US",
      stdout: true,
      terms: "term",
    } as any);

    expect(keywordPipelineService.run).toHaveBeenCalledWith("US", ["term"], {
      allowInteractiveAuthRecovery: false,
    });
    expect(resolveAsoAdamId).toHaveBeenCalledWith({
      adamId: undefined,
      allowPrompt: false,
    });
    expect(saveKeywordsToDefaultResearchApp).toHaveBeenCalledWith(
      ["term"],
      "US"
    );
    expect(mockLogger.info).not.toHaveBeenCalled();
    expect(mockLogger.debug).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(JSON.stringify(result, null, 2));
    expect(asoAuthService.reAuthenticate).not.toHaveBeenCalled();
  });

  it("saves requested keywords when --stdout run ends with all-keywords-failed error", async () => {
    jest.mocked(keywordPipelineService.parseKeywords).mockReturnValue(["failed-term"]);
    jest
      .mocked(keywordPipelineService.run)
      .mockRejectedValue(new Error("All keywords failed (1): failed-term:FAILED(500)"));
    jest.mocked(saveKeywordsToDefaultResearchApp).mockReturnValue(1);

    await expect(
      asoCommand.handler?.({
        subcommand: "keywords",
        country: "US",
        stdout: true,
        terms: "failed-term",
      } as any)
    ).rejects.toThrow("All keywords failed");

    expect(saveKeywordsToDefaultResearchApp).toHaveBeenCalledWith(
      ["failed-term"],
      "US"
    );
    expect(mockLogger.info).not.toHaveBeenCalled();
    expect(mockLogger.debug).not.toHaveBeenCalled();
  });

  it("reauthenticates silently and retries once in --stdout mode on auth-required error", async () => {
    const authRequiredError = Object.assign(new Error("auth required"), {
      code: "ASO_AUTH_REAUTH_REQUIRED",
    });
    jest.mocked(keywordPipelineService.parseKeywords).mockReturnValue(["term"]);
    jest
      .mocked(keywordPipelineService.run)
      .mockRejectedValueOnce(authRequiredError)
      .mockResolvedValueOnce({
        items: [{ keyword: "term", popularity: 42 }],
        failedKeywords: [],
      } as any);

    await asoCommand.handler?.({
      subcommand: "keywords",
      country: "US",
      stdout: true,
      terms: "term",
    } as any);

    expect(asoAuthService.reAuthenticate).toHaveBeenCalledTimes(1);
    expect(asoAuthService.reAuthenticate).toHaveBeenCalledWith(
      expect.objectContaining({
        onUserActionRequired: expect.any(Function),
      })
    );
    expect(keywordPipelineService.run).toHaveBeenNthCalledWith(1, "US", ["term"], {
      allowInteractiveAuthRecovery: false,
    });
    expect(keywordPipelineService.run).toHaveBeenNthCalledWith(2, "US", ["term"], {
      allowInteractiveAuthRecovery: false,
    });
  });

  it("fails with actionable message when --stdout reauth requires user interaction", async () => {
    const authRequiredError = Object.assign(new Error("auth required"), {
      code: "ASO_AUTH_REAUTH_REQUIRED",
    });
    jest.mocked(keywordPipelineService.parseKeywords).mockReturnValue(["term"]);
    jest
      .mocked(keywordPipelineService.run)
      .mockRejectedValueOnce(authRequiredError);
    jest
      .mocked(asoAuthService.reAuthenticate)
      .mockImplementation(async (options?: any) => {
        options?.onUserActionRequired?.("credentials");
        return "cookie=value";
      });

    await expect(
      asoCommand.handler?.({
        subcommand: "keywords",
        country: "US",
        stdout: true,
        terms: "term",
      } as any)
    ).rejects.toThrow(STDOUT_INTERACTIVE_AUTH_REQUIRED_MESSAGE);

    expect(keywordPipelineService.run).toHaveBeenCalledTimes(1);
  });
});
