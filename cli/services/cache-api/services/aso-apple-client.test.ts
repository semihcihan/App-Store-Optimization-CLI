import { jest } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbForTests } from "../../../db/store";
import { asoAppleGet } from "./aso-apple-client";

jest.mock("axios", () => {
  const get = jest.fn<() => Promise<unknown>>();
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

const mockGet = (
  jest.requireMock("axios") as { __mockGet: jest.Mock<() => Promise<unknown>> }
).__mockGet;

describe("aso-apple-client", () => {
  const originalDbPath = process.env.ASO_DB_PATH;
  let dbDir: string;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), "aso-app-store-retry-test-"));
    process.env.ASO_DB_PATH = join(dbDir, "test.sqlite");
    mockGet.mockReset();
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

  it("uses shared retry defaults and retries 500 responses up to attempt 2", async () => {
    const transientError = {
      response: { status: 500, statusText: "Server Error", headers: {} },
      message: "Internal error",
    };

    (mockGet as any)
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
    const response = await promise;

    expect(response.status).toBe(200);
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it.each([429, 503])("defers a long HTTP %i across requests to the same host", async (status) => {
    const retryAt = Date.now() + 120_000;
    const config = { operation: "test-op" };
    mockGet
      .mockRejectedValueOnce({
        response: { status, headers: { "retry-after": "120" } },
      })
      .mockResolvedValue({ status: 200, headers: {}, data: {} });

    await expect(asoAppleGet("https://apps.apple.com/search", config)).rejects.toMatchObject({
      statusCode: status,
      retryAt,
    });
    await expect(asoAppleGet("https://apps.apple.com/app", config)).rejects.toMatchObject({
      statusCode: status,
      retryAt,
    });
    expect(mockGet).toHaveBeenCalledTimes(1);
    await expect(asoAppleGet("https://itunes.apple.com/lookup", config)).resolves.toMatchObject({
      status: 200,
    });
    await jest.advanceTimersByTimeAsync(120_000);
    await expect(asoAppleGet("https://apps.apple.com/app", config)).resolves.toMatchObject({
      status: 200,
    });
    expect(mockGet).toHaveBeenCalledTimes(3);
  });
});
