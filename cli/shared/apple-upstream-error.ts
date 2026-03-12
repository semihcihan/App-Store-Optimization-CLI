import axios from "axios";
import { getErrorBugsnagMetadata } from "../services/telemetry/bugsnag-metadata";

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_MESSAGE_SNIPPETS = [
  "network",
  "timeout",
  "timed out",
  "fetch failed",
  "socket",
  "connect",
  "rate limit",
  "too many requests",
];

export type NormalizedAppleUpstreamError = {
  reasonCode: string;
  message: string;
  statusCode?: number;
  retryable: boolean;
  attempts: number;
  operation: string;
  requestId?: string;
};

type NormalizeParams = {
  error: unknown;
  operation: string;
  attempts?: number;
  defaultReasonCode?: string;
  requestId?: string;
};

function sanitizeText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const noTags = trimmed.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return noTags || trimmed.slice(0, 200);
}

function firstErrorFromBody(body: unknown): {
  code?: string;
  message?: string;
  requestId?: string;
} {
  if (!body || typeof body !== "object") {
    return {};
  }
  const parsed = body as {
    requestID?: string;
    requestId?: string;
    internalErrorCode?: string;
    message?: string;
    error?: {
      errors?: Array<{
        messageCode?: string;
        message?: string;
        code?: string;
        detail?: string;
        title?: string;
      }>;
    };
    errors?: Array<{
      code?: string;
      message?: string;
      detail?: string;
      title?: string;
    }>;
  };
  const nested = parsed.error?.errors?.[0];
  const flat = parsed.errors?.[0];
  const code =
    nested?.messageCode ??
    nested?.code ??
    flat?.code ??
    parsed.internalErrorCode;
  const message =
    nested?.message ??
    nested?.detail ??
    nested?.title ??
    flat?.message ??
    flat?.detail ??
    flat?.title ??
    parsed.message;
  const requestId = parsed.requestID ?? parsed.requestId;
  return {
    code: typeof code === "string" ? code : undefined,
    message: typeof message === "string" ? message : undefined,
    requestId: typeof requestId === "string" ? requestId : undefined,
  };
}

function normalizeReasonCode(rawCode: string | undefined, fallback: string): string {
  if (!rawCode) return fallback;
  const normalized = rawCode
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return normalized || fallback;
}

function inferRetryable(statusCode: number | undefined, message: string): boolean {
  if (statusCode != null && RETRYABLE_STATUS_CODES.has(statusCode)) return true;
  const lower = message.toLowerCase();
  return RETRYABLE_MESSAGE_SNIPPETS.some((snippet) => lower.includes(snippet));
}

function metadataRequestId(error: unknown): string | undefined {
  const metadata = getErrorBugsnagMetadata(error);
  const appleApi = metadata?.appleApi as
    | { context?: { requestID?: string; requestId?: string } }
    | undefined;
  const requestId = appleApi?.context?.requestID ?? appleApi?.context?.requestId;
  return typeof requestId === "string" ? requestId : undefined;
}

export function normalizeAppleUpstreamError(
  params: NormalizeParams
): NormalizedAppleUpstreamError {
  const defaultReasonCode = params.defaultReasonCode ?? "UPSTREAM_ERROR";
  const attempts = params.attempts ?? 1;
  let statusCode: number | undefined;
  let reasonCode: string | undefined;
  let message = "";
  let requestId = params.requestId;

  if (axios.isAxiosError(params.error)) {
    statusCode =
      typeof params.error.response?.status === "number"
        ? params.error.response.status
        : undefined;
    const details = firstErrorFromBody(params.error.response?.data);
    reasonCode = details.code;
    message =
      sanitizeText(details.message ?? params.error.message ?? String(params.error)) ||
      "Request failed";
    requestId = requestId ?? details.requestId;
  } else if (params.error instanceof Error) {
    message = sanitizeText(params.error.message) || "Request failed";
  } else {
    const rawMessage =
      typeof (params.error as any)?.message === "string"
        ? (params.error as any).message
        : String(params.error ?? "");
    message = sanitizeText(rawMessage) || "Request failed";
  }

  if (statusCode == null && typeof (params.error as any)?.statusCode === "number") {
    statusCode = (params.error as any).statusCode;
  }

  if (requestId == null) {
    requestId = metadataRequestId(params.error);
  }

  if (!reasonCode && typeof (params.error as any)?.code === "string") {
    reasonCode = (params.error as any).code;
  }

  const normalizedReasonCode = normalizeReasonCode(reasonCode, defaultReasonCode);
  const retryable = inferRetryable(statusCode, message);

  return {
    reasonCode: normalizedReasonCode,
    message,
    statusCode,
    retryable,
    attempts,
    operation: params.operation,
    requestId,
  };
}
