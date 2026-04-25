import axios, { type AxiosInstance, type AxiosRequestConfig } from "axios";
import { withBugsnagMetadata } from "../telemetry/bugsnag-metadata";
import { reportBugsnagError } from "../telemetry/error-reporter";
import {
  buildSensitiveKeyMatcher,
  pushBoundedEntry,
  sanitizeTelemetryUrl,
  sanitizeTelemetryValue,
} from "../../shared/telemetry/trace-utils";

export type AppleTraceProvider =
  | "apple-auth"
  | "apple-search-ads"
  | "apple-appstore";

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

type AppleHttpTraceStoreEntry = AppleHttpTrace & {
  traceId: number;
  nonSuccess: boolean;
};

const RECENT_TRACE_LIMIT = 3;
const RECENT_FAILED_TRACE_LIMIT = 3;
const APPLE_CONTRACT_CHANGE_DEDUPE_WINDOW_MS = 15 * 60 * 1000;
const TRACE_STRING_MAX_LENGTH = 2000;
const TRACE_ARRAY_MAX_ITEMS = 20;
const TRACE_OBJECT_MAX_KEYS = 40;
const TRACE_MAX_DEPTH = 6;
const recentTraceStore: AppleHttpTraceStoreEntry[] = [];
const recentFailedTraceStore: AppleHttpTraceStoreEntry[] = [];
const appleContractChangeLastSeenAt = new Map<string, number>();
let nextTraceId = 1;
let tracedClients = new WeakSet<AxiosInstance>();

const SENSITIVE_KEY_INCLUDES = [
  "cookie",
  "authorization",
  "password",
  "passcode",
  "passwd",
  "securitycode",
  "accountname",
  "token",
  "secret",
  "apikey",
  "api-key",
  "session",
  "x-apple-id-session-id",
  "x-apple-session-token",
];

const SENSITIVE_KEY_EXACT = new Set(["scnt", "m1", "m2", "c", "a"]);
const isSensitiveKey = buildSensitiveKeyMatcher({
  includes: SENSITIVE_KEY_INCLUDES,
  exact: Array.from(SENSITIVE_KEY_EXACT),
});

function toRequestSnapshot(config?: AxiosRequestConfig): AppleHttpTrace["request"] {
  return {
    method: String(config?.method || "get").toUpperCase(),
    url: sanitizeTelemetryUrl(String(config?.url || ""), {
      isSensitiveKey,
      baseUrl: "https://apple.local",
    }),
    params: truncateTraceValue(
      sanitizeTelemetryValue(config?.params, {
        isSensitiveKey,
        parseJsonStrings: true,
      })
    ),
    headers: truncateTraceValue(
      sanitizeTelemetryValue(config?.headers, {
        isSensitiveKey,
        parseJsonStrings: true,
      })
    ),
    body: truncateTraceValue(
      sanitizeTelemetryValue(config?.data, {
        isSensitiveKey,
        parseJsonStrings: true,
      })
    ),
  };
}

function truncateTraceValue(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (depth >= TRACE_MAX_DEPTH) return "[TRUNCATED:DEPTH]";

  if (typeof value === "string") {
    if (value.length <= TRACE_STRING_MAX_LENGTH) return value;
    const truncatedChars = value.length - TRACE_STRING_MAX_LENGTH;
    return `${value.slice(0, TRACE_STRING_MAX_LENGTH)}...[TRUNCATED:${truncatedChars} chars]`;
  }

  if (Array.isArray(value)) {
    const limited = value
      .slice(0, TRACE_ARRAY_MAX_ITEMS)
      .map((entry) => truncateTraceValue(entry, depth + 1));
    if (value.length > TRACE_ARRAY_MAX_ITEMS) {
      limited.push(`[TRUNCATED:${value.length - TRACE_ARRAY_MAX_ITEMS} items]`);
    }
    return limited;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const limitedEntries = entries
      .slice(0, TRACE_OBJECT_MAX_KEYS)
      .map(([key, entry]) => [key, truncateTraceValue(entry, depth + 1)]);
    const output = Object.fromEntries(limitedEntries) as Record<string, unknown>;
    if (entries.length > TRACE_OBJECT_MAX_KEYS) {
      output._truncatedKeys = entries.length - TRACE_OBJECT_MAX_KEYS;
    }
    return output;
  }

  return value;
}

function toMetadataTrace(
  entry: AppleHttpTraceStoreEntry
): AppleHttpTrace {
  const { traceId: _traceId, nonSuccess: _nonSuccess, ...trace } = entry;
  return truncateTraceValue(trace) as AppleHttpTrace;
}

function isNonSuccessTrace(trace: AppleHttpTrace): boolean {
  if (trace.error) return true;
  const status = trace.response?.status;
  return typeof status === "number" && (status < 200 || status >= 300);
}

function pushTrace(trace: AppleHttpTrace): void {
  const entry: AppleHttpTraceStoreEntry = {
    ...trace,
    traceId: nextTraceId,
    nonSuccess: isNonSuccessTrace(trace),
  };
  nextTraceId += 1;
  pushBoundedEntry(recentTraceStore, entry, RECENT_TRACE_LIMIT);
  if (entry.nonSuccess) {
    pushBoundedEntry(recentFailedTraceStore, entry, RECENT_FAILED_TRACE_LIMIT);
  }
}

function normalizeContractSignaturePart(value: unknown, maxLength = 120): string {
  if (value == null) return "";
  const normalized = String(value).trim().toLowerCase().replace(/\s+/g, " ");
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, maxLength);
}

function statusBucket(statusCode?: number): string {
  if (typeof statusCode !== "number" || !Number.isFinite(statusCode)) {
    return "none";
  }
  if (statusCode < 100) return "non_http";
  const family = Math.floor(statusCode / 100);
  return `${family}xx`;
}

function buildContractChangeSignature(params: {
  provider: AppleTraceProvider;
  operation: string;
  endpoint?: string;
  expectedContract: string;
  actualSignal: string;
  statusCode?: number;
  dedupeKey?: string;
}): string {
  if (params.dedupeKey) {
    return [
      params.provider,
      params.operation,
      normalizeContractSignaturePart(params.dedupeKey, 200),
    ].join("|");
  }
  return [
    params.provider,
    params.operation,
    normalizeContractSignaturePart(params.endpoint),
    normalizeContractSignaturePart(params.expectedContract),
    normalizeContractSignaturePart(params.actualSignal),
    statusBucket(params.statusCode),
  ].join("|");
}

function shouldReportContractChange(signature: string, now: number): boolean {
  for (const [key, lastSeenAt] of appleContractChangeLastSeenAt.entries()) {
    if (now - lastSeenAt >= APPLE_CONTRACT_CHANGE_DEDUPE_WINDOW_MS) {
      appleContractChangeLastSeenAt.delete(key);
    }
  }

  const lastSeenAt = appleContractChangeLastSeenAt.get(signature);
  if (
    typeof lastSeenAt === "number" &&
    now - lastSeenAt < APPLE_CONTRACT_CHANGE_DEDUPE_WINDOW_MS
  ) {
    return false;
  }

  appleContractChangeLastSeenAt.set(signature, now);
  return true;
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
      pushTrace({
        timestamp: new Date().toISOString(),
        provider,
        request: toRequestSnapshot(response.config),
        response: {
          status: response.status,
          headers: truncateTraceValue(
            sanitizeTelemetryValue(response.headers, {
              isSensitiveKey,
              parseJsonStrings: true,
            })
          ),
          body: truncateTraceValue(
            sanitizeTelemetryValue(response.data, {
              isSensitiveKey,
              parseJsonStrings: true,
            })
          ),
          durationMs: startedAt > 0 ? Date.now() - startedAt : undefined,
        },
      });
      return response;
    },
    (error) => {
      if (axios.isAxiosError(error)) {
        const startedAt = Number((error.config as any)?.__appleTraceStartedAt || 0);
        pushTrace({
          timestamp: new Date().toISOString(),
          provider,
          request: toRequestSnapshot(error.config),
          response: {
            status: error.response?.status,
            headers: truncateTraceValue(
              sanitizeTelemetryValue(error.response?.headers, {
                isSensitiveKey,
                parseJsonStrings: true,
              })
            ),
            body: truncateTraceValue(
              sanitizeTelemetryValue(error.response?.data, {
                isSensitiveKey,
                parseJsonStrings: true,
              })
            ),
            durationMs: startedAt > 0 ? Date.now() - startedAt : undefined,
          },
          error: {
            code: error.code,
            message: error.message,
          },
        });
      } else {
        pushTrace({
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
    isTerminal?: boolean;
  }
): Error {
  const statusCode =
    typeof params.context?.statusCode === "number"
      ? params.context.statusCode
      : typeof (params.context as any)?.status === "number"
        ? (params.context as any).status
        : undefined;
  const recentHttpTraces = recentTraceStore.map(toMetadataTrace);
  const recentTraceIds = new Set(recentTraceStore.map((entry) => entry.traceId));
  const recentFailedHttpTraces = recentFailedTraceStore.map(toMetadataTrace);
  const extraRecentFailedHttpTraces = recentFailedTraceStore
    .filter((entry) => !recentTraceIds.has(entry.traceId))
    .map(toMetadataTrace);

  return withBugsnagMetadata(error, {
    appleApi: {
      provider: params.provider,
      operation: params.operation,
      context: truncateTraceValue(
        sanitizeTelemetryValue(params.context || {}, {
          isSensitiveKey,
          parseJsonStrings: true,
        })
      ),
      recentHttpTraces: [...recentHttpTraces, ...extraRecentFailedHttpTraces],
      recentFailedHttpTraces,
    },
    telemetryHint: {
      upstreamProvider: params.provider,
      operation: params.operation,
      statusCode,
      isTerminal: params.isTerminal,
      source: `apple.${params.provider}.${params.operation}`,
    },
  });
}

export function reportAppleContractChange(params: {
  provider: AppleTraceProvider;
  operation: string;
  endpoint: string;
  expectedContract: string;
  actualSignal: string;
  statusCode?: number;
  requestId?: string;
  context?: Record<string, unknown>;
  error?: unknown;
  isTerminal?: boolean;
  dedupeKey?: string;
  surface?: string;
}): void {
  const now = Date.now();
  const signature = buildContractChangeSignature({
    provider: params.provider,
    operation: params.operation,
    endpoint: params.endpoint,
    expectedContract: params.expectedContract,
    actualSignal: params.actualSignal,
    statusCode: params.statusCode,
    dedupeKey: params.dedupeKey,
  });
  if (!shouldReportContractChange(signature, now)) {
    return;
  }

  const source = `apple.contract.${params.provider}.${params.operation}`;
  const surface = params.surface ?? "aso-apple-api";
  const wrapped = withAppleHttpTraceContext(
    params.error ?? new Error(`Apple contract drift detected: ${params.operation}`),
    {
      provider: params.provider,
      operation: params.operation,
      context: {
        endpoint: params.endpoint,
        expectedContract: params.expectedContract,
        actualSignal: params.actualSignal,
        statusCode: params.statusCode,
        requestId: params.requestId,
        ...(params.context || {}),
      },
      isTerminal: params.isTerminal,
    }
  );

  reportBugsnagError(wrapped, {
    surface,
    source,
    operation: params.operation,
    endpoint: params.endpoint,
    statusCode: params.statusCode,
    isTerminal: params.isTerminal ?? false,
    appleContractChange: {
      provider: params.provider,
      operation: params.operation,
      endpoint: params.endpoint,
      expectedContract: params.expectedContract,
      actualSignal: params.actualSignal,
      statusCode: params.statusCode,
      requestId: params.requestId,
      signature,
      dedupeWindowMs: APPLE_CONTRACT_CHANGE_DEDUPE_WINDOW_MS,
    },
    telemetryHint: {
      classification: "apple_contract_change",
      upstreamProvider: params.provider,
      source,
      operation: params.operation,
      surface,
      statusCode: params.statusCode,
      isTerminal: params.isTerminal ?? false,
      stage: "contract-change",
    },
  });
}

export function resetAppleHttpTracingForTests(): void {
  recentTraceStore.length = 0;
  recentFailedTraceStore.length = 0;
  appleContractChangeLastSeenAt.clear();
  nextTraceId = 1;
  tracedClients = new WeakSet<AxiosInstance>();
}
