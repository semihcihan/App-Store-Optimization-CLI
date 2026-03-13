import type { CommandModule } from "yargs";
import { keywordPipelineService } from "../services/keywords/keyword-pipeline-service";
import { startDashboard } from "../dashboard-server";
import { asoKeychainService } from "../services/auth/aso-keychain-service";
import { asoCookieStoreService } from "../services/auth/aso-cookie-store-service";
import { resolveAsoAdamId } from "../services/keywords/aso-adam-id-service";
import { asoAuthService } from "../services/auth/aso-auth-service";
import { saveKeywordsToDefaultResearchApp } from "../services/keywords/aso-research-keyword-service";
import { logger } from "../utils/logger";
import {
  ASO_MAX_KEYWORDS,
  ASO_MAX_KEYWORDS_PER_CALL_ERROR,
} from "../shared/aso-keyword-limits";
import {
  DEFAULT_ASO_COUNTRY,
  assertSupportedCountry,
  normalizeCountry,
} from "../domain/keywords/policy";

const AUTH_REAUTH_REQUIRED_ERROR_CODE = "ASO_AUTH_REAUTH_REQUIRED";
const STDOUT_INTERACTIVE_AUTH_REQUIRED_MESSAGE =
  "This run needs interactive Apple Search Ads reauthentication. Run 'aso auth' in a terminal, then retry this command with --stdout.";

function isAuthReauthRequiredError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === AUTH_REAUTH_REQUIRED_ERROR_CODE
  );
}

function isAllKeywordsFailedError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("All keywords failed");
}

async function fetchKeywordsForStdout(
  country: string,
  keywords: string[]
): Promise<Awaited<ReturnType<typeof keywordPipelineService.run>>> {
  try {
    return await keywordPipelineService.run(country, keywords, {
      allowInteractiveAuthRecovery: false,
    });
  } catch (error) {
    if (!isAuthReauthRequiredError(error)) {
      throw error;
    }
  }

  await asoAuthService.reAuthenticate({
    onUserActionRequired: () => {
      throw new Error(STDOUT_INTERACTIVE_AUTH_REQUIRED_MESSAGE);
    },
  });

  return keywordPipelineService.run(country, keywords, {
    allowInteractiveAuthRecovery: false,
  });
}

const asoCommand: CommandModule = {
  command: "$0 [subcommand] [terms]",
  describe:
    "Open ASO dashboard (default), fetch ASO keyword metrics (`aso keywords`), reauthenticate (`aso auth`), or reset saved ASO auth state (`aso reset-credentials`). Interactive `aso keywords` runs save requested keywords to the default research app.",
  builder: (yargs) =>
    yargs
      .positional("subcommand", {
        type: "string",
        choices: ["keywords", "auth", "reset-credentials"],
        describe: "ASO subcommand",
      })
      .positional("terms", {
        type: "string",
        describe:
          'Comma-separated keywords for `keywords`, e.g. aso keywords "x,y,z"',
      })
      .option("country", {
        type: "string",
        default: DEFAULT_ASO_COUNTRY,
        describe: "Storefront country code (currently US only)",
      })
      .option("stdout", {
        type: "boolean",
        default: false,
        describe:
          "Output keyword metrics to stdout in machine-safe mode (`aso keywords` only)",
      })
      .option("primary-app-id", {
        type: "string",
        demandOption: false,
        describe:
          "Primary App ID for popularity requests; saved locally and reused for future ASO runs",
      }),
  handler: async (argv) => {
    const subcommand = argv.subcommand as string | undefined;
    const stdout = (argv.stdout as boolean) ?? false;
    const primaryAppId = argv["primary-app-id"] as string | undefined;

    if (subcommand === "reset-credentials") {
      asoKeychainService.clearCredentials();
      asoCookieStoreService.clearCookies();
      logger.info("Reset ASO credentials/cookies.");
      return;
    }

    if (subcommand === "auth") {
      await asoAuthService.reAuthenticate();
      return;
    }

    const country = normalizeCountry(argv.country as string);
    assertSupportedCountry(country);

    if (!subcommand) {
      if (stdout || argv.terms != null) {
        throw new Error(
          "Keyword options are only supported in `aso keywords`."
        );
      }
      await resolveAsoAdamId({ adamId: primaryAppId, allowPrompt: true });
      await startDashboard(true);
      return;
    }

    if (subcommand !== "keywords") {
      throw new Error(`Unsupported ASO subcommand: ${subcommand}`);
    }

    const keywords = keywordPipelineService.parseKeywords(
      argv.terms as string | undefined
    );
    if (keywords.length === 0) {
      throw new Error(
        "`aso keywords` requires a comma-separated keyword argument."
      );
    }
    if (keywords.length > ASO_MAX_KEYWORDS) {
      throw new Error(ASO_MAX_KEYWORDS_PER_CALL_ERROR);
    }

    await resolveAsoAdamId({ adamId: primaryAppId, allowPrompt: !stdout });

    let result: Awaited<ReturnType<typeof keywordPipelineService.run>>;
    try {
      result = stdout
        ? await fetchKeywordsForStdout(country, keywords)
        : await keywordPipelineService.run(country, keywords);
    } catch (error) {
      if (!stdout && isAllKeywordsFailedError(error)) {
        const savedCount = saveKeywordsToDefaultResearchApp(keywords, country);
        logger.info(
          `Saved ${savedCount} requested keyword(s) to the default research app (${country}).`
        );
      }
      throw error;
    }
    if (!stdout) {
      const savedCount = saveKeywordsToDefaultResearchApp(
        keywords,
        country
      );
      logger.info(
        `Saved ${savedCount} requested keyword(s) to the default research app (${country}).`
      );
    }
    console.log(JSON.stringify(result, null, 2));
  },
};

export default asoCommand;
