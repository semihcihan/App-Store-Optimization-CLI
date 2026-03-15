type SensitiveKeyMatcher = (key: string) => boolean;

type SensitiveKeyMatcherConfig = {
  includes?: string[];
  exact?: string[];
};

type SanitizeTelemetryOptions = {
  isSensitiveKey: SensitiveKeyMatcher;
  parseJsonStrings?: boolean;
};

type SanitizeTelemetryUrlOptions = {
  isSensitiveKey: SensitiveKeyMatcher;
  baseUrl: string;
};

const JSON_LIKE_PATTERN = /^(\{[\s\S]*\}|\[[\s\S]*\])$/;

export function redactTelemetryString(value: string): string {
  if (value.length <= 8) return "[REDACTED]";
  return `[REDACTED:${value.length}]`;
}

export function buildSensitiveKeyMatcher(
  config: SensitiveKeyMatcherConfig
): SensitiveKeyMatcher {
  const exact = new Set((config.exact || []).map((key) => key.toLowerCase()));
  const includes = (config.includes || []).map((key) => key.toLowerCase());

  return (key: string): boolean => {
    const lowered = key.toLowerCase();
    if (exact.has(lowered)) return true;
    return includes.some((needle) => lowered.includes(needle));
  };
}

export function sanitizeTelemetryValue(
  value: unknown,
  options: SanitizeTelemetryOptions,
  parentKey = ""
): unknown {
  if (value == null) return value;

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeTelemetryValue(entry, options, parentKey));
  }

  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (options.isSensitiveKey(key)) {
        output[key] =
          typeof entry === "string" ? redactTelemetryString(entry) : "[REDACTED]";
        continue;
      }
      output[key] = sanitizeTelemetryValue(entry, options, key);
    }
    return output;
  }

  if (typeof value === "string" && options.isSensitiveKey(parentKey)) {
    return redactTelemetryString(value);
  }

  if (
    options.parseJsonStrings &&
    typeof value === "string" &&
    JSON_LIKE_PATTERN.test(value.trim())
  ) {
    try {
      return sanitizeTelemetryValue(JSON.parse(value), options, parentKey);
    } catch {
      return value;
    }
  }

  return value;
}

export function sanitizeTelemetryUrl(
  rawUrl: string,
  options: SanitizeTelemetryUrlOptions
): string {
  if (!rawUrl) return rawUrl;
  const isAbsolute = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(rawUrl);

  try {
    const parsed = new URL(rawUrl, options.baseUrl);
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (!options.isSensitiveKey(key)) continue;
      const values = parsed.searchParams.getAll(key);
      parsed.searchParams.delete(key);
      for (const value of values) {
        parsed.searchParams.append(key, redactTelemetryString(value));
      }
    }

    if (isAbsolute) return parsed.toString();
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return rawUrl;
  }
}

export function pushBoundedEntry<T>(target: T[], entry: T, limit: number): void {
  target.push(entry);
  if (target.length > limit) {
    target.splice(0, target.length - limit);
  }
}
