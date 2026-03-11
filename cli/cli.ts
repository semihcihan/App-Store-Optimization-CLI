#!/usr/bin/env node
import "./load-env";
import "./services/telemetry/instrument";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { logger, processNestedErrors } from "./utils/logger";
import path from "path";
import asoCmd from "./commands/aso";
import { checkVersionUpdateSync } from "./services/runtime/version-check-service";
import { reportBugsnagError } from "./services/telemetry/error-reporter";

const isDebugEnabled = process.env.NODE_ENV == "development";

if (isDebugEnabled) {
  const logFilePath = path.resolve(process.cwd(), "aso-debug.log");
  logger.setOutputModes([{ mode: "file", showErrorStack: true }], logFilePath);
  logger.setLevel("debug");
  logger.debug(`Debug logging enabled. File: ${logFilePath}`);
} else {
  logger.setOutputModes([{ mode: "console", showErrorStack: false }]);
  logger.setLevel("info");
}

async function main() {
  checkVersionUpdateSync();

  const parser = yargs(hideBin(process.argv))
    .command(asoCmd)
    .strict()
    .fail(async (msg) => {
      if (msg) {
        logger.error(msg, "Use 'aso --help' to see available commands and options.");
        process.exit(1);
      }
    })
    .help();

  await parser.parseAsync();
}

main().catch((err) => {
  let command = "unknown";

  try {
    const processArgs = process.argv?.slice(2) || [];
    command = processArgs[0] || "unknown";
  } catch {
    command = "unknown";
  }

  const processedError = processNestedErrors(err, false);

  logger.error(`Command '${command}' failed`, processedError);
  reportBugsnagError(err, { command, context: processedError });
  process.exitCode = 1;
});
