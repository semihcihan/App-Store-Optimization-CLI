import * as http from "http";

const DEFAULT_MAX_REQUEST_BODY_BYTES = 1024 * 1024;

class RequestBodyTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestBodyTooLargeError";
  }
}

function getRequestBody(
  req: http.IncomingMessage,
  maxRequestBodyBytes: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      const chunkBuffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(String(chunk));
      totalBytes += chunkBuffer.length;
      if (totalBytes > maxRequestBodyBytes) {
        settled = true;
        reject(
          new RequestBodyTooLargeError(
            `Request payload exceeds ${maxRequestBodyBytes} bytes`
          )
        );
        req.destroy();
        return;
      }
      chunks.push(chunkBuffer);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function sendJson(
  res: http.ServerResponse,
  status: number,
  data: unknown
): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store, max-age=0",
  });
  res.end(JSON.stringify(data));
}

export function sendApiError(
  res: http.ServerResponse,
  status: number,
  errorCode: string,
  message: string
): void {
  sendJson(res, status, {
    success: false,
    errorCode,
    error: message,
  });
}

export async function parseJsonBody<T>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options?: { maxRequestBodyBytes?: number }
): Promise<T | null> {
  const maxRequestBodyBytes =
    options?.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;

  try {
    const raw = await getRequestBody(req, maxRequestBodyBytes);
    return JSON.parse(raw) as T;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      sendApiError(
        res,
        413,
        "PAYLOAD_TOO_LARGE",
        "Request payload is too large."
      );
      return null;
    }
    sendApiError(res, 400, "INVALID_REQUEST", "Invalid request payload.");
    return null;
  }
}
