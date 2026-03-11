const BUGSNAG_METADATA_KEY = "__asoBugsnagMetadata";

type BugsnagMetadataRecord = Record<string, unknown>;

function toMetadataRecord(
  metadata: unknown
): BugsnagMetadataRecord | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  return metadata as BugsnagMetadataRecord;
}

export function getErrorBugsnagMetadata(
  error: unknown
): BugsnagMetadataRecord | undefined {
  if (!(error instanceof Error)) return undefined;
  return toMetadataRecord((error as any)[BUGSNAG_METADATA_KEY]);
}

export function withBugsnagMetadata(
  error: unknown,
  metadata: BugsnagMetadataRecord
): Error {
  const target =
    error instanceof Error ? error : new Error(typeof error === "string" ? error : String(error));
  const existing = getErrorBugsnagMetadata(target) || {};

  Object.defineProperty(target, BUGSNAG_METADATA_KEY, {
    value: { ...existing, ...metadata },
    enumerable: false,
    configurable: true,
    writable: true,
  });

  return target;
}
