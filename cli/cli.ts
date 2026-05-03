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
import { assertSupportedNodeVersion } from "./services/runtime/node-version-guard";
import {
  CliValidationError,
  emitStdoutRuntimeFailure,
  emitStdoutValidationFailure,
  isCliValidationError,
  isStdoutKeywordsRun,
  toMachineReadableErrorMessage,
} from "./services/runtime/stdout-contract";
import {
  shutdownPostHog,
  trackCliStarted,
} from "./services/telemetry/posthog-usage-tracking";

assertSupportedNodeVersion();
const processArgs = process.argv?.slice(2) || [];
const stdoutKeywordsRun = isStdoutKeywordsRun(processArgs);
const commandName =
  typeof processArgs[0] === "string" && processArgs[0].trim()
    ? processArgs[0].trim()
    : "dashboard";

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
  trackCliStarted({ command: commandName });
  checkVersionUpdateSync({ allowStdoutMessage: !stdoutKeywordsRun });

  const parser = yargs(hideBin(process.argv))
    .command(asoCmd)
    .strict()
    .fail((msg, err) => {
      const failureMessage =
        (typeof msg === "string" && msg.trim()) ||
        toMachineReadableErrorMessage(err);
      if (err) {
        throw err;
      }
      throw new CliValidationError(failureMessage);
    })
    .help();

  await parser.parseAsync();
  await shutdownPostHog();
}

main().catch(async (err) => {
  let command = "unknown";

  try {
    command = processArgs[0] || "unknown";
  } catch {
    command = "unknown";
  }

  const processedError = processNestedErrors(err, false);

  if (stdoutKeywordsRun) {
    if (isCliValidationError(err)) {
      emitStdoutValidationFailure(err.message);
    } else {
      emitStdoutRuntimeFailure(toMachineReadableErrorMessage(processedError));
    }
  } else if (isCliValidationError(err)) {
    logger.error(err.message, err.help);
  } else {
    logger.error(`Command '${command}' failed`, processedError);
  }
  reportBugsnagError(err, {
    surface: "aso-cli",
    source: "cli.main.catch",
    operation: `command:${command}`,
    command,
    context: processedError,
  });
  await shutdownPostHog();
  process.exitCode = 1;
});
