import { jest } from "@jest/globals";

const mockPost = jest.fn();

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
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.spyOn(Math, "random").mockReturnValue(0);
    process.env.ASO_RETRY_MAX_ATTEMPTS = "4";
    process.env.ASO_RETRY_BASE_DELAY_MS = "1000";
    process.env.ASO_RETRY_MAX_DELAY_MS = "30000";
    process.env.ASO_RETRY_JITTER_FACTOR = "0.1";
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete process.env.ASO_RETRY_MAX_ATTEMPTS;
    delete process.env.ASO_RETRY_BASE_DELAY_MS;
    delete process.env.ASO_RETRY_MAX_DELAY_MS;
    delete process.env.ASO_RETRY_JITTER_FACTOR;
  });

  it("retries KWS_NO_ORG_CONTENT_PROVIDERS up to 3 times and succeeds", async () => {
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
        status: 403,
        data: {
          status: "error",
          requestID: "req2",
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
    await jest.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(mockPost).toHaveBeenCalledTimes(3);
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
    await jest.advanceTimersByTimeAsync(2000);
    await jest.advanceTimersByTimeAsync(4000);
    const result = await promise;

    expect(mockPost).toHaveBeenCalledTimes(4);
    expect(result.statusCode).toBe(403);
    expect(result.data.error?.errors?.[0]?.messageCode).toBe(
      "KWS_NO_ORG_CONTENT_PROVIDERS"
    );
  });

  it("retries 429 using retry-after header", async () => {
    (mockPost as any)
      .mockResolvedValueOnce({
        status: 429,
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
    await jest.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(result.statusCode).toBe(200);
  });

  it("retries transient network errors up to max attempts", async () => {
    const networkError = Object.assign(new Error("network down"), {
      isAxiosError: true,
      code: "ECONNRESET",
    });
    (mockPost as any)
      .mockRejectedValueOnce(networkError)
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce({
        status: 200,
        data: { status: "success", data: [{ name: "z", popularity: 5 }] },
      });

    const promise = requestPopularitiesWithKwsRetry(["z"], "cookie=value", "adam");
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(mockPost).toHaveBeenCalledTimes(3);
    expect(result.statusCode).toBe(200);
  });
});
