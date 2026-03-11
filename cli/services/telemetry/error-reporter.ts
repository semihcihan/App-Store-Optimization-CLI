import "./instrument";
import { notifyBugsnagError } from "./bugsnag-shared";
import { getErrorBugsnagMetadata } from "./bugsnag-metadata";

export function reportBugsnagError(
  error: unknown,
  metadata: Record<string, unknown> = {}
): void {
  const errorMetadata = getErrorBugsnagMetadata(error) || {};
  notifyBugsnagError(error, { ...metadata, ...errorMetadata });
}
