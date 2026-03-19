import {
  getErrorMessage,
  getErrorName,
  normalizeForKey,
  toStringValue,
} from "./telemetry-helpers";

function getErrorClass(error: unknown): string {
  if (error instanceof Error && error.name.trim()) return error.name.trim();
  return getErrorName(error) ?? "Error";
}

function getTopStackFrame(error: unknown): string {
  if (!(error instanceof Error) || typeof error.stack !== "string") {
    return "no-stack";
  }
  const [, ...lines] = error.stack
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return normalizeForKey(lines[0] || "no-stack");
}

function getErrorCode(metadata: Record<string, unknown>): string {
  const errorCode =
    toStringValue(metadata.errorCode) ??
    toStringValue(metadata.code) ??
    toStringValue(metadata.noise_class);
  return normalizeForKey(errorCode || "none");
}

export function buildNoiseSignature(
  error: unknown,
  metadata: Record<string, unknown>
): string {
  return [
    normalizeForKey(getErrorClass(error)),
    normalizeForKey(getErrorMessage(error) ?? ""),
    normalizeForKey(String(metadata.source ?? "unknown")),
    normalizeForKey(String(metadata.operation ?? "unknown")),
    getErrorCode(metadata),
    getTopStackFrame(error),
  ].join("|");
}
