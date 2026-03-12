import type { CommandModule } from "yargs";
import {
  parseKeywords,
  fetchAndPersistKeywords,
} from "../services/keywords/aso-keyword-service";
import { startDashboard } from "../dashboard-server";
import { asoKeychainService } from "../services/auth/aso-keychain-service";
import { asoCookieStoreService } from "../services/auth/aso-cookie-store-service";
import { resolveAsoAdamId } from "../services/keywords/aso-adam-id-service";
import { asoAuthService } from "../services/auth/aso-auth-service";
import { saveKeywordsToDefaultResearchApp } from "../services/keywords/aso-research-keyword-service";
import { logger } from "../utils/logger";

const DEFAULT_COUNTRY = "US";
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

async function fetchKeywordsForStdout(
  country: string,
  keywords: string[]
): Promise<Awaited<ReturnType<typeof fetchAndPersistKeywords>>> {
  try {
    return await fetchAndPersistKeywords(country, keywords, {
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

  return fetchAndPersistKeywords(country, keywords, {
    allowInteractiveAuthRecovery: false,
  });
}

const asoCommand: CommandModule = {
  command: "$0 [subcommand] [terms]",
  describe:
    "Open ASO dashboard (default), fetch ASO keyword metrics (`aso keywords`), reauthenticate (`aso auth`), or reset saved ASO auth state (`aso reset-credentials`). Accepted `aso keywords` results are saved to the default research app.",
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
        default: DEFAULT_COUNTRY,
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

    const country = (argv.country as string).toUpperCase();
    if (country !== DEFAULT_COUNTRY) {
      throw new Error("Only US is supported for now");
    }

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

    const keywords = parseKeywords(argv.terms as string | undefined);
    if (keywords.length === 0) {
      throw new Error(
        "`aso keywords` requires a comma-separated keyword argument."
      );
    }

    await resolveAsoAdamId({ adamId: primaryAppId, allowPrompt: !stdout });

    const result = stdout
      ? await fetchKeywordsForStdout(country, keywords)
      : await fetchAndPersistKeywords(country, keywords);
    if (!stdout) {
      const savedCount = saveKeywordsToDefaultResearchApp(
        result.items.map((item) => item.keyword),
        country
      );
      logger.info(
        `Saved ${savedCount} accepted keyword(s) to the default research app (${country}).`
      );
    }
    console.log(JSON.stringify(result, null, 2));
  },
};

export default asoCommand;
