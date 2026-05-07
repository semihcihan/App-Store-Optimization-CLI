import { jest } from "@jest/globals";
import {
  getHeaderValue,
  parseRetryAfterMs,
  calculateJitteredDelay,
  getRetryDelayMs,
} from "./aso-retry-delay";

describe("aso-retry-delay", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(Math, "random").mockReturnValue(0);
    process.env.ASO_RETRY_MAX_DELAY_MS = "30000";
    process.env.ASO_RETRY_JITTER_FACTOR = "0.1";
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.ASO_RETRY_MAX_DELAY_MS;
    delete process.env.ASO_RETRY_JITTER_FACTOR;
  });

  it("reads header values case-insensitively", () => {
    expect(getHeaderValue({ "Retry-After": "2" }, "retry-after")).toBe("2");
  });

  it("parses retry-after seconds", () => {
    expect(parseRetryAfterMs({ "retry-after": "2" })).toBe(2000);
  });

  it("parses retry-after dates", () => {
    jest.spyOn(Date, "now").mockReturnValue(1_000);
    expect(parseRetryAfterMs({ "retry-after": "Thu, 01 Jan 1970 00:00:03 GMT" })).toBe(
      2000
    );
  });

  it("computes jittered delay with max cap", () => {
    expect(calculateJitteredDelay(5000)).toBe(5000);
    expect(calculateJitteredDelay(40000)).toBe(30000);
  });

  it("prefers retry-after for 429", () => {
    const delay = getRetryDelayMs({
      statusCode: 429,
      headers: { "retry-after": "2" },
      attempt: 1,
      defaultBaseDelayMs: 1000,
      rateLimitBaseDelayMs: 3000,
    });
    expect(delay).toBe(2000);
  });

  it("uses exponential fallback for non-429", () => {
    const delay = getRetryDelayMs({
      statusCode: 503,
      attempt: 2,
      defaultBaseDelayMs: 1000,
      rateLimitBaseDelayMs: 3000,
    });
    expect(delay).toBe(2000);
  });
});
