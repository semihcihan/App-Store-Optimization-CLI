import {
  buildSensitiveKeyMatcher,
  pushBoundedEntry,
  redactTelemetryString,
  sanitizeTelemetryUrl,
  sanitizeTelemetryValue,
} from "../../shared/telemetry/trace-utils";

describe("trace-utils", () => {
  it("redacts strings with stable formatting", () => {
    expect(redactTelemetryString("short")).toBe("[REDACTED]");
    expect(redactTelemetryString("123456789")).toBe("[REDACTED:9]");
  });

  it("matches sensitive keys by exact and includes rules", () => {
    const isSensitive = buildSensitiveKeyMatcher({
      includes: ["token", "cookie"],
      exact: ["scnt"],
    });

    expect(isSensitive("authToken")).toBe(true);
    expect(isSensitive("set-cookie")).toBe(true);
    expect(isSensitive("scnt")).toBe(true);
    expect(isSensitive("SCNT")).toBe(true);
    expect(isSensitive("displayName")).toBe(false);
  });

  it("sanitizes nested object values and optional JSON strings", () => {
    const isSensitive = buildSensitiveKeyMatcher({
      includes: ["password", "token"],
    });

    const sanitized = sanitizeTelemetryValue(
      {
        password: "super-secret",
        nested: { accessToken: "abcdefghi" },
        jsonPayload: '{"token":"top-secret","safe":"ok"}',
      },
      { isSensitiveKey: isSensitive, parseJsonStrings: true }
    );

    expect(sanitized).toEqual({
      password: "[REDACTED:12]",
      nested: { accessToken: "[REDACTED:9]" },
      jsonPayload: { token: "[REDACTED:10]", safe: "ok" },
    });
  });

  it("sanitizes URL query params while preserving relative URL format", () => {
    const isSensitive = buildSensitiveKeyMatcher({
      includes: ["token", "session"],
    });

    const sanitizedRelative = sanitizeTelemetryUrl(
      "/api/test?token=abc123456&ok=1",
      { isSensitiveKey: isSensitive, baseUrl: "http://dashboard.local" }
    );
    expect(sanitizedRelative.startsWith("/api/test?")).toBe(true);
    const relativeQuery = sanitizedRelative.split("?")[1] || "";
    const relativeParams = new URLSearchParams(relativeQuery);
    expect(relativeParams.get("token")).toBe("[REDACTED:9]");
    expect(relativeParams.get("ok")).toBe("1");

    const sanitizedAbsolute = sanitizeTelemetryUrl(
      "https://example.com/path?session=abcdefghi",
      { isSensitiveKey: isSensitive, baseUrl: "http://dashboard.local" }
    );
    expect(sanitizedAbsolute).toContain("session=%5BREDACTED%3A9%5D");
  });

  it("keeps only the latest bounded entries", () => {
    const values: number[] = [];
    pushBoundedEntry(values, 1, 3);
    pushBoundedEntry(values, 2, 3);
    pushBoundedEntry(values, 3, 3);
    pushBoundedEntry(values, 4, 3);

    expect(values).toEqual([2, 3, 4]);
  });
});
