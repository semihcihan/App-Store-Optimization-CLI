import { jest } from "@jest/globals";
import { asoAppleGet } from "./aso-apple-client";

jest.mock("axios", () => {
  const get = jest.fn();
  return {
    __esModule: true,
    default: {
      create: jest.fn(() => ({
        get,
        interceptors: {
          request: { use: jest.fn() },
          response: { use: jest.fn() },
        },
      })),
    },
    __mockGet: get,
  };
});

const mockGet = (jest.requireMock("axios") as { __mockGet: jest.Mock }).__mockGet;

describe("aso-apple-client", () => {
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

  it("uses shared retry defaults and retries 500 responses up to attempt 4", async () => {
    const transientError = {
      response: { status: 500, statusText: "Server Error", headers: {} },
      message: "Internal error",
    };

    (mockGet as any)
      .mockRejectedValueOnce(transientError)
      .mockRejectedValueOnce(transientError)
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce({
        status: 200,
        statusText: "OK",
        headers: {},
        data: { ok: true },
      } as any);

    const promise = asoAppleGet("https://example.com", {
      operation: "test-op",
      headers: {},
    });

    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(2000);
    await jest.advanceTimersByTimeAsync(4000);
    const response = await promise;

    expect(response.status).toBe(200);
    expect(mockGet).toHaveBeenCalledTimes(4);
  });
});
