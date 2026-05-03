import { processNestedErrors } from "../../utils/logger";

export const CLI_VALIDATION_ERROR_CODE = "CLI_VALIDATION_ERROR";
export const CLI_RUNTIME_ERROR_CODE = "CLI_RUNTIME_ERROR";

export class CliValidationError extends Error {
  readonly code = CLI_VALIDATION_ERROR_CODE;
  readonly help = "Use `aso --help` to see available commands and options.";

  constructor(message: string) {
    super(message);
    this.name = "CliValidationError";
    Object.setPrototypeOf(this, CliValidationError.prototype);
  }
}

type StdoutErrorPayload = {
  error: {
    code: string;
    message: string;
    help?: string;
  };
};

export function isStdoutKeywordsRun(args: string[]): boolean {
  return (
    args.includes("keywords") &&
    args.some((arg) => arg === "--stdout" || arg.startsWith("--stdout="))
  );
}

export function toMachineReadableErrorMessage(error: unknown): string {
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return ((error as { message: string }).message || "").trim();
  }
  if (error == null) {
    return "Unknown error.";
  }
  const rendered = processNestedErrors(error, false);
  if (typeof rendered === "string" && rendered.trim()) {
    return rendered.trim();
  }
  if (
    typeof rendered === "object" &&
    rendered !== null &&
    "message" in rendered &&
    typeof (rendered as { message?: unknown }).message === "string"
  ) {
    return ((rendered as { message: string }).message || "").trim();
  }
  return "Unknown error.";
}

function writeStdoutFailure(payload: StdoutErrorPayload): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

export function emitStdoutValidationFailure(message: string): void {
  writeStdoutFailure({
    error: {
      code: CLI_VALIDATION_ERROR_CODE,
      message,
      help: "Use `aso --help` to see available commands and options.",
    },
  });
}

export function emitStdoutRuntimeFailure(message: string): void {
  writeStdoutFailure({
    error: {
      code: CLI_RUNTIME_ERROR_CODE,
      message,
    },
  });
}

export function isCliValidationError(
  error: unknown
): error is CliValidationError {
  return error instanceof CliValidationError;
}
