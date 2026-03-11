import axios, { type AxiosInstance, type AxiosRequestConfig } from "axios";
import { withBugsnagMetadata } from "../telemetry/bugsnag-metadata";

export type AppleTraceProvider = "apple-auth" | "apple-search-ads";

type AppleHttpTrace = {
  timestamp: string;
  provider: AppleTraceProvider;
  request: {
    method: string;
    url: string;
    params?: unknown;
    headers?: unknown;
    body?: unknown;
  };
  response?: {
    status?: number;
    headers?: unknown;
    body?: unknown;
    durationMs?: number;
  };
  error?: {
    code?: string;
    message: string;
  };
};

const TRACE_LIMIT = 3;
const traceByProvider = new Map<AppleTraceProvider, AppleHttpTrace[]>();
const tracedClients = new WeakSet<AxiosInstance>();

const SENSITIVE_KEY_INCLUDES = [
  "cookie",
  "authorization",
  "password",
  "securitycode",
  "accountname",
  "x-apple-id-session-id",
];

const SENSITIVE_KEY_EXACT = new Set(["scnt", "m1", "m2", "c", "a"]);

function redactString(value: string): string {
  if (value.length <= 8) return "[REDACTED]";
  return `[REDACTED:${value.length}]`;
}

function isSensitiveKey(key: string): boolean {
  const lowered = key.toLowerCase();
  if (SENSITIVE_KEY_EXACT.has(lowered)) return true;
  return SENSITIVE_KEY_INCLUDES.some((needle) => lowered.includes(needle));
}

function sanitize(value: unknown, parentKey = ""): unknown {
  if (value == null) return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, parentKey));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        out[key] = typeof entry === "string" ? redactString(entry) : "[REDACTED]";
        continue;
      }
      out[key] = sanitize(entry, key);
    }
    return out;
  }
  if (typeof value === "string" && isSensitiveKey(parentKey)) {
    return redactString(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        return sanitize(JSON.parse(trimmed), parentKey);
      } catch {
        return value;
      }
    }
  }
  return value;
}

function toRequestSnapshot(config?: AxiosRequestConfig): AppleHttpTrace["request"] {
  return {
    method: String(config?.method || "get").toUpperCase(),
    url: String(config?.url || ""),
    params: sanitize(config?.params),
    headers: sanitize(config?.headers),
    body: sanitize(config?.data),
  };
}

function pushTrace(provider: AppleTraceProvider, trace: AppleHttpTrace): void {
  const existing = traceByProvider.get(provider) || [];
  existing.push(trace);
  if (existing.length > TRACE_LIMIT) {
    existing.splice(0, existing.length - TRACE_LIMIT);
  }
  traceByProvider.set(provider, existing);
}

export function attachAppleHttpTracing(
  client: AxiosInstance,
  provider: AppleTraceProvider
): void {
  const hasInterceptors =
    (client as any)?.interceptors?.request?.use &&
    (client as any)?.interceptors?.response?.use;
  if (!hasInterceptors) return;
  if (tracedClients.has(client)) return;
  tracedClients.add(client);

  client.interceptors.request.use((config) => {
    (config as any).__appleTraceStartedAt = Date.now();
    return config;
  });

  client.interceptors.response.use(
    (response) => {
      const startedAt = Number((response.config as any).__appleTraceStartedAt || 0);
      pushTrace(provider, {
        timestamp: new Date().toISOString(),
        provider,
        request: toRequestSnapshot(response.config),
        response: {
          status: response.status,
          headers: sanitize(response.headers),
          body: sanitize(response.data),
          durationMs: startedAt > 0 ? Date.now() - startedAt : undefined,
        },
      });
      return response;
    },
    (error) => {
      if (axios.isAxiosError(error)) {
        const startedAt = Number((error.config as any)?.__appleTraceStartedAt || 0);
        pushTrace(provider, {
          timestamp: new Date().toISOString(),
          provider,
          request: toRequestSnapshot(error.config),
          response: {
            status: error.response?.status,
            headers: sanitize(error.response?.headers),
            body: sanitize(error.response?.data),
            durationMs: startedAt > 0 ? Date.now() - startedAt : undefined,
          },
          error: {
            code: error.code,
            message: error.message,
          },
        });
      } else {
        pushTrace(provider, {
          timestamp: new Date().toISOString(),
          provider,
          request: {
            method: "UNKNOWN",
            url: "",
          },
          error: {
            message: String(error),
          },
        });
      }
      return Promise.reject(error);
    }
  );
}

export function withAppleHttpTraceContext(
  error: unknown,
  params: {
    provider: AppleTraceProvider;
    operation: string;
    context?: Record<string, unknown>;
  }
): Error {
  const recentHttpTraces = (traceByProvider.get(params.provider) || []).map(
    (entry) => ({
      ...entry,
    })
  );

  return withBugsnagMetadata(error, {
    appleApi: {
      provider: params.provider,
      operation: params.operation,
      context: sanitize(params.context || {}),
      recentHttpTraces,
    },
  });
}
