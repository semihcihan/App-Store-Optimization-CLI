import { jest } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbForTests } from "../../db/store";

const mockPost = jest.fn<() => Promise<unknown>>();

jest.mock("axios", () => ({
  __esModule: true,
  default: {
    create: jest.fn(() => ({
      post: mockPost,
    })),
    isAxiosError: (error: any) => error?.isAxiosError === true,
  },
}));

import { requestPopularitiesWithKwsRetry } from "./aso-apple-popularity-client";

describe("aso-apple-popularity-client", () => {
  const originalDbPath = process.env.ASO_DB_PATH;
  let dbDir: string;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), "aso-popularity-retry-test-"));
    process.env.ASO_DB_PATH = join(dbDir, "test.sqlite");
    mockPost.mockReset();
    jest.useFakeTimers();
    jest.spyOn(Math, "random").mockReturnValue(0);
    process.env.ASO_RETRY_MAX_ATTEMPTS = "2";
    process.env.ASO_RETRY_BASE_DELAY_MS = "1000";
    process.env.ASO_RETRY_MAX_DELAY_MS = "30000";
    process.env.ASO_RETRY_JITTER_FACTOR = "0.1";
  });

  afterEach(() => {
    closeDbForTests();
    rmSync(dbDir, { recursive: true, force: true });
    if (originalDbPath == null) delete process.env.ASO_DB_PATH;
    else process.env.ASO_DB_PATH = originalDbPath;
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete process.env.ASO_RETRY_MAX_ATTEMPTS;
    delete process.env.ASO_RETRY_BASE_DELAY_MS;
    delete process.env.ASO_RETRY_MAX_DELAY_MS;
    delete process.env.ASO_RETRY_JITTER_FACTOR;
  });

  it("retries KWS_NO_ORG_CONTENT_PROVIDERS once and succeeds", async () => {
    (mockPost as any)
      .mockResolvedValueOnce({
        status: 403,
        data: {
          status: "error",
          requestID: "req1",
          error: {
            errors: [
              {
                messageCode: "KWS_NO_ORG_CONTENT_PROVIDERS",
                message: "No org content providers",
              },
            ],
          },
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { status: "success", data: [{ name: "z", popularity: 9 }] },
      });

    const promise = requestPopularitiesWithKwsRetry(["z"], "cookie=value", "adam");
    await jest.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(result.statusCode).toBe(200);
    expect(result.data.status).toBe("success");
  });

  it("returns the final KWS response after retries are exhausted", async () => {
    (mockPost as any).mockResolvedValue({
      status: 403,
      data: {
        status: "error",
        requestID: "req-kws",
        error: {
          errors: [
            {
              messageCode: "KWS_NO_ORG_CONTENT_PROVIDERS",
              message: "No org content providers",
            },
          ],
        },
      },
    });

    const promise = requestPopularitiesWithKwsRetry(
      ["z"],
      "cookie=value",
      "adam"
    );
    await jest.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(result.statusCode).toBe(403);
    expect(result.data.error?.errors?.[0]?.messageCode).toBe(
      "KWS_NO_ORG_CONTENT_PROVIDERS"
    );
  });

  it.each([429, 503])("retries %i using Retry-After", async (status) => {
    (mockPost as any)
      .mockResolvedValueOnce({
        status,
        headers: {
          "retry-after": "2",
        },
        data: {
          status: "error",
          requestID: "req-rate",
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { status: "success", data: [{ name: "z", popularity: 7 }] },
      });

    const promise = requestPopularitiesWithKwsRetry(["z"], "cookie=value", "adam");
    await jest.advanceTimersByTimeAsync(1999);
    expect(mockPost).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    const result = await promise;

    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(result.statusCode).toBe(200);
  });

  it("defers a long 503 and blocks later popularity calls until the stored deadline", async () => {
    const retryAt = Date.now() + 120_000;
    mockPost
      .mockResolvedValueOnce({
        status: 503,
        headers: { "retry-after": "120" },
        data: {},
      })
      .mockResolvedValueOnce({ status: 200, data: { status: "success" } });

    await expect(
      requestPopularitiesWithKwsRetry(["a"], "cookie=value", "adam")
    ).resolves.toMatchObject({ statusCode: 503, attempts: 1, retryAt });
    closeDbForTests();
    await jest.advanceTimersByTimeAsync(119_999);
    await expect(
      requestPopularitiesWithKwsRetry(["b"], "cookie=value", "adam")
    ).resolves.toMatchObject({ statusCode: 503, attempts: 0, retryAt });
    expect(mockPost).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await expect(
      requestPopularitiesWithKwsRetry(["b"], "cookie=value", "adam")
    ).resolves.toMatchObject({ statusCode: 200, attempts: 1 });
    expect(mockPost).toHaveBeenCalledTimes(2);
  });

  it("retains the Retry-After deadline from the final 429", async () => {
    const retryAt = Math.ceil(Date.now() / 1000) * 1000 + 120_000;
    mockPost
      .mockResolvedValueOnce({
        status: 429,
        headers: { "retry-after": "1" },
        data: {},
      })
      .mockResolvedValueOnce({
        status: 429,
        headers: { "retry-after": new Date(retryAt).toUTCString() },
        data: { requestID: "final-request" },
      });

    const pending = requestPopularitiesWithKwsRetry(["a"], "cookie=value", "adam");
    await jest.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toMatchObject({
      statusCode: 429,
      attempts: 2,
      retryAt,
      data: { requestID: "final-request" },
    });
    await expect(
      requestPopularitiesWithKwsRetry(["b"], "cookie=value", "adam")
    ).resolves.toMatchObject({ statusCode: 429, attempts: 0, retryAt });
    expect(mockPost).toHaveBeenCalledTimes(2);
  });

  it("keeps the longer deadline when overlapping requests are throttled", async () => {
    const retryAt = Date.now() + 120_000;
    mockPost
      .mockResolvedValueOnce({ status: 503, headers: { "retry-after": "120" } })
      .mockResolvedValueOnce({ status: 429, headers: { "retry-after": "2" } });
    const options = { maxAttempts: 1 };
    const results = await Promise.all([
      requestPopularitiesWithKwsRetry(["a"], "cookie=value", "adam", options),
      requestPopularitiesWithKwsRetry(["b"], "cookie=value", "adam", options),
    ]);

    expect(results.map((result) => result.retryAt)).toEqual([retryAt, retryAt]);
    await expect(
      requestPopularitiesWithKwsRetry(["c"], "cookie=value", "adam")
    ).resolves.toMatchObject({ attempts: 0, retryAt });
    expect(mockPost).toHaveBeenCalledTimes(2);
  });

  it("retries transient network errors up to max attempts", async () => {
    const networkError = Object.assign(new Error("network down"), {
      isAxiosError: true,
      code: "ECONNRESET",
    });
    (mockPost as any)
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce({
        status: 200,
        data: { status: "success", data: [{ name: "z", popularity: 5 }] },
      });

    const promise = requestPopularitiesWithKwsRetry(["z"], "cookie=value", "adam");
    await jest.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(result.statusCode).toBe(200);
  });

  it("does not retry when maxAttempts override is 1", async () => {
    (mockPost as any).mockResolvedValue({
      status: 503,
      data: { status: "error", requestID: "req-no-retry" },
    });

    const result = await requestPopularitiesWithKwsRetry(
      ["z"],
      "cookie=value",
      "adam",
      { maxAttempts: 1 }
    );

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(result.statusCode).toBe(503);
  });
});
