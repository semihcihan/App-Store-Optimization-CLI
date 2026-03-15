import Bugsnag from "@bugsnag/js";

const BUGSNAG_API_KEY = "ed1a4165d4f8fd836bf16f3ca1915a67";
let started = false;
let isDevelopmentMode = false;
type StartOptions = NonNullable<Parameters<typeof Bugsnag.start>[0]>;
type BugsnagConfigOptions = Exclude<StartOptions, string>;
const DEFAULT_BREADCRUMB_TYPES: NonNullable<
  BugsnagConfigOptions["enabledBreadcrumbTypes"]
> = ["error", "manual"];
const REDACTED_VALUE = "[REDACTED]";
const DEFAULT_REDACTED_KEYS: NonNullable<BugsnagConfigOptions["redactedKeys"]> =
  [
    /password/i,
    /passphrase/i,
    /passwd/i,
    /pwd/i,
    /token/i,
    /secret/i,
    /authorization/i,
    /cookie/i,
    /api[_-]?key/i,
    /apple[_-]?id/i,
    /username/i,
    /account[_-]?name/i,
    /email/i,
    /security[_-]?code/i,
    /spawnargs/i,
  ];
const JSON_LIKE_PATTERN = /^[\[{].*[\]}]$/s;
const SENSITIVE_ARRAY_VALUE_FLAGS = new Set([
  "-w",
  "--password",
  "--passphrase",
  "--token",
  "--authorization",
]);
const INLINE_SECRET_PATTERNS: RegExp[] = [
  /("appleid"\s*:\s*")[^"]*(")/gi,
  /("username"\s*:\s*")[^"]*(")/gi,
  /("accountname"\s*:\s*")[^"]*(")/gi,
  /("email"\s*:\s*")[^"]*(")/gi,
  /("password"\s*:\s*")[^"]*(")/gi,
  /("passphrase"\s*:\s*")[^"]*(")/gi,
  /("passwd"\s*:\s*")[^"]*(")/gi,
  /("pwd"\s*:\s*")[^"]*(")/gi,
  /("token"\s*:\s*")[^"]*(")/gi,
  /("authorization"\s*:\s*")[^"]*(")/gi,
  /("cookie"\s*:\s*")[^"]*(")/gi,
  /("secret"\s*:\s*")[^"]*(")/gi,
];
const SENSITIVE_KEY_EXACT = new Set([
  "password",
  "passphrase",
  "passwd",
  "pwd",
  "token",
  "authorization",
  "cookie",
  "setcookie",
  "apikey",
  "appleid",
  "username",
  "accountname",
  "email",
  "secret",
  "securitycode",
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (!normalized) return false;
  if (SENSITIVE_KEY_EXACT.has(normalized)) return true;
  return (
    normalized.includes("password") ||
    normalized.includes("passphrase") ||
    normalized.includes("passwd") ||
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("authorization") ||
    normalized.includes("cookie")
  );
}

function redactInlineSecrets(value: string): string {
  let output = value;
  for (const pattern of INLINE_SECRET_PATTERNS) {
    output = output.replace(pattern, `$1${REDACTED_VALUE}$2`);
  }
  return output;
}

function sanitizeString(value: string): string {
  const trimmed = value.trim();
  if (trimmed && JSON_LIKE_PATTERN.test(trimmed)) {
    try {
      return JSON.stringify(sanitizeMetadataValue(JSON.parse(trimmed)));
    } catch {
      return redactInlineSecrets(value);
    }
  }
  return redactInlineSecrets(value);
}

function sanitizeArray(values: unknown[]): unknown[] {
  const sanitized = values.map((entry) => sanitizeMetadataValue(entry));
  for (let i = 0; i < sanitized.length; i += 1) {
    const entry = sanitized[i];
    if (typeof entry !== "string") continue;
    const normalized = entry.trim().toLowerCase();
    if (SENSITIVE_ARRAY_VALUE_FLAGS.has(normalized) && i + 1 < sanitized.length) {
      sanitized[i + 1] = REDACTED_VALUE;
      continue;
    }
    if (normalized.startsWith("-w") && normalized.length > 2) {
      sanitized[i] = "-w[REDACTED]";
    }
  }
  return sanitized;
}

function sanitizeMetadataValue(value: unknown, key = ""): unknown {
  if (value == null) return value;

  if (Array.isArray(value)) {
    return sanitizeArray(value);
  }

  if (typeof value === "string") {
    if (key && isSensitiveKey(key)) {
      return REDACTED_VALUE;
    }
    return sanitizeString(value);
  }

  if (typeof value !== "object") {
    if (key && isSensitiveKey(key)) {
      return REDACTED_VALUE;
    }
    return value;
  }

  const record = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(record)) {
    if (isSensitiveKey(entryKey)) {
      sanitized[entryKey] = REDACTED_VALUE;
      continue;
    }
    sanitized[entryKey] = sanitizeMetadataValue(entryValue, entryKey);
  }
  return sanitized;
}

function sanitizeEventErrors(event: any): void {
  if (!Array.isArray(event?.errors)) return;
  for (const entry of event.errors) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.errorMessage === "string") {
      entry.errorMessage = sanitizeString(entry.errorMessage);
    }
  }
}

function sanitizeEventMetadata(event: any): void {
  if (!event || typeof event.getMetadata !== "function") return;
  const metadata = event.getMetadata();
  if (!metadata || typeof metadata !== "object") return;

  for (const [section, sectionValue] of Object.entries(
    metadata as Record<string, unknown>
  )) {
    if (typeof event.clearMetadata === "function") {
      event.clearMetadata(section);
    }

    const sanitizedSection = sanitizeMetadataValue(sectionValue, section);
    if (
      sanitizedSection &&
      typeof sanitizedSection === "object" &&
      !Array.isArray(sanitizedSection)
    ) {
      event.addMetadata(section, sanitizedSection);
      continue;
    }

    event.addMetadata(section, { value: sanitizedSection });
  }
}

function sanitizeBugsnagEvent(event: any): void {
  sanitizeEventMetadata(event);
  sanitizeEventErrors(event);
}

export function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}

export function initializeBugsnag(options: {
  isDevelopment: boolean;
  appVersion?: string;
  enabledBreadcrumbTypes?: BugsnagConfigOptions["enabledBreadcrumbTypes"];
}): void {
  if (started) return;

  isDevelopmentMode = options.isDevelopment;
  if (isDevelopmentMode) {
    return;
  }

  Bugsnag.start({
    apiKey: BUGSNAG_API_KEY,
    autoTrackSessions: false,
    appVersion: options.appVersion,
    logger: null,
    redactedKeys: DEFAULT_REDACTED_KEYS,
    enabledBreadcrumbTypes:
      options.enabledBreadcrumbTypes ?? DEFAULT_BREADCRUMB_TYPES,
    onError: (event) => {
      sanitizeBugsnagEvent(event);
    },
  });
  started = true;
}

export function notifyBugsnagError(
  error: unknown,
  metadata: Record<string, unknown> = {},
  mutateEvent?: (event: any) => void
): void {
  if (!started || isDevelopmentMode) return;

  Bugsnag.notify(toError(error), (event) => {
    event.addMetadata("metadata", metadata);
    if (mutateEvent) {
      mutateEvent(event);
    }
  });
}
