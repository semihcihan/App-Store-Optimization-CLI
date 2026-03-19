export type AnyRecord = Record<string, unknown>;

export function toRecord(value: unknown): AnyRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as AnyRecord;
}

export function toStringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function toStatusCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function toBooleanOrNull(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  return null;
}

export function normalizeForKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function slugToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function normalizeOperationPath(path: string): string {
  return path.split("?")[0]?.trim() || path.trim();
}

export function getRequestPath(metadata: AnyRecord): string | undefined {
  return toStringValue(metadata.endpoint) ?? toStringValue(metadata.path);
}

export function getErrorRecord(error: unknown): AnyRecord | undefined {
  return toRecord(error);
}

export function getErrorName(error: unknown): string | undefined {
  return toStringValue((getErrorRecord(error) || {}).name);
}

export function getErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return toStringValue(error.message);
  return toStringValue((getErrorRecord(error) || {}).message);
}
