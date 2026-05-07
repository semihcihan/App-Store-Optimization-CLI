const KNOWN_TRANSIENT_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

const TRANSIENT_NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_ABORTED",
  "UND_ERR_DESTROYED",
]);

const TRANSIENT_MESSAGE_SNIPPETS = [
  "network",
  "timeout",
  "timed out",
  "fetch failed",
  "socket",
  "connect",
];

export function isRetryableTransientStatusCode(
  statusCode: number | undefined
): boolean {
  return typeof statusCode === "number" && (statusCode === 429 || statusCode >= 500);
}

export function isKnownTransientStatusCode(
  statusCode: number | undefined
): boolean {
  return (
    typeof statusCode === "number" &&
    Number.isFinite(statusCode) &&
    KNOWN_TRANSIENT_STATUS_CODES.has(statusCode)
  );
}

export function isTransientNetworkErrorCode(code: string | undefined): boolean {
  if (!code) return false;
  return TRANSIENT_NETWORK_ERROR_CODES.has(code.trim().toUpperCase());
}

export function hasTransientMessageSignal(message: string | undefined): boolean {
  if (!message) return false;
  const normalized = message.toLowerCase();
  return TRANSIENT_MESSAGE_SNIPPETS.some((snippet) =>
    normalized.includes(snippet)
  );
}

export function isTransientTransportFailure(params: {
  code?: string;
  message?: string;
}): boolean {
  return (
    isTransientNetworkErrorCode(params.code) ||
    hasTransientMessageSignal(params.message)
  );
}
