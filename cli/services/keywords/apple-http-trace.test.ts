import axios from "axios";
import AxiosMockAdapter from "axios-mock-adapter";
import {
  attachAppleHttpTracing,
  reportAppleContractChange,
  resetAppleHttpTracingForTests,
  withAppleHttpTraceContext,
} from "./apple-http-trace";
import { getErrorBugsnagMetadata } from "../telemetry/bugsnag-metadata";
import { reportBugsnagError } from "../telemetry/error-reporter";

jest.mock("../telemetry/error-reporter", () => ({
  reportBugsnagError: jest.fn(),
}));

describe("apple-http-trace", () => {
  const mockReportBugsnagError = jest.mocked(reportBugsnagError);

  beforeEach(() => {
    resetAppleHttpTracingForTests();
    jest.clearAllMocks();
  });

  it("redacts SIRP proof fields in traced request and response payloads", async () => {
    const client = axios.create();
    attachAppleHttpTracing(client, "apple-auth");
    const mock = new AxiosMockAdapter(client);
    mock.onPost("/signin/complete").reply(500, {
      status: "error",
      m1: "server-proof",
      nested: {
        m2: "server-m2",
        a: "server-a",
      },
      plain: "ok",
    });

    await expect(
      client.post(
        "/signin/complete",
        {
          accountName: "user@example.com",
          password: "super-secret",
          m1: "client-m1",
          m2: "client-m2",
          c: "client-c",
          a: "client-a",
          nonSensitive: "still-visible",
        },
        {
          headers: {
            Authorization: "Bearer token",
            Cookie: "a=b",
            scnt: "scnt-value",
          },
        }
      )
    ).rejects.toThrow();

    const wrapped = withAppleHttpTraceContext(new Error("failed"), {
      provider: "apple-auth",
      operation: "test-op",
    });
    const metadata = getErrorBugsnagMetadata(wrapped);
    const traces = (metadata?.appleApi as any)?.recentHttpTraces || [];
    const trace = traces[traces.length - 1];
    expect(trace.request.body).toMatchObject({
      accountName: expect.stringContaining("[REDACTED"),
      password: expect.stringContaining("[REDACTED"),
      m1: expect.stringContaining("[REDACTED"),
      m2: expect.stringContaining("[REDACTED"),
      c: expect.stringContaining("[REDACTED"),
      a: expect.stringContaining("[REDACTED"),
      nonSensitive: "still-visible",
    });
    expect(trace.request.headers).toMatchObject({
      Authorization: expect.stringContaining("[REDACTED"),
      Cookie: "[REDACTED]",
      scnt: expect.stringContaining("[REDACTED"),
    });
    expect(trace.response.body).toMatchObject({
      m1: expect.stringContaining("[REDACTED"),
      nested: {
        m2: expect.stringContaining("[REDACTED"),
        a: expect.stringContaining("[REDACTED"),
      },
      plain: "ok",
    });
  });

  it("redacts sensitive query params in request urls", async () => {
    const client = axios.create();
    attachAppleHttpTracing(client, "apple-auth");
    const mock = new AxiosMockAdapter(client);
    mock.onGet(/\/secure/).reply(200, { ok: true });

    await client.get("/secure?token=abc123&password=hunter2&plain=ok");

    const wrapped = withAppleHttpTraceContext(new Error("boom"), {
      provider: "apple-auth",
      operation: "query-redaction",
    });
    const metadata = getErrorBugsnagMetadata(wrapped);
    const traces = (metadata?.appleApi as any)?.recentHttpTraces || [];
    const trace = traces[traces.length - 1];
    expect(trace.request.url).toContain("token=%5BREDACTED");
    expect(trace.request.url).toContain("password=%5BREDACTED");
    expect(trace.request.url).toContain("plain=ok");
  });

  it("attaches last 3 calls plus recent failed calls that fell out of the window", async () => {
    const client = axios.create();
    attachAppleHttpTracing(client, "apple-search-ads");
    const mock = new AxiosMockAdapter(client);
    const statusBySeq: Record<number, number> = {
      1: 500,
      2: 502,
      5: 503,
    };
    mock.onGet(/\/trace/).reply((config) => {
      const seq = Number(
        new URL(config.url || "", "https://apple.local").searchParams.get("seq")
      );
      return [statusBySeq[seq] || 200, { seq }];
    });

    for (let seq = 1; seq <= 12; seq += 1) {
      try {
        await client.get(`/trace?seq=${seq}`);
      } catch {
        // expected for non-success statuses
      }
    }

    const wrapped = withAppleHttpTraceContext(new Error("boom"), {
      provider: "apple-search-ads",
      operation: "window-check",
    });
    const metadata = getErrorBugsnagMetadata(wrapped);
    const appleApi = (metadata?.appleApi || {}) as any;
    const traces = appleApi.recentHttpTraces || [];
    const failedTraces = appleApi.recentFailedHttpTraces || [];
    const traceSeq = traces.map((trace: any) =>
      Number(
        new URL(
          trace.request.url || "",
          "https://apple.local"
        ).searchParams.get("seq")
      )
    );
    const failedSeq = failedTraces.map((trace: any) =>
      Number(
        new URL(
          trace.request.url || "",
          "https://apple.local"
        ).searchParams.get("seq")
      )
    );

    expect(traceSeq).toEqual([10, 11, 12, 1, 2, 5]);
    expect(failedSeq).toEqual([1, 2, 5]);
  });

  it("truncates oversized trace payloads to keep metadata bounded", async () => {
    const client = axios.create();
    attachAppleHttpTracing(client, "apple-appstore");
    const mock = new AxiosMockAdapter(client);
    mock.onGet("/huge").reply(500, {
      hugeText: "x".repeat(10000),
      list: Array.from({ length: 60 }, (_, index) => ({ index })),
      nested: {
        level1: {
          level2: {
            level3: {
              level4: {
                level5: {
                  level6: {
                    level7: "too-deep",
                  },
                },
              },
            },
          },
        },
      },
    });

    await expect(client.get("/huge")).rejects.toThrow();

    const wrapped = withAppleHttpTraceContext(new Error("bounded"), {
      provider: "apple-appstore",
      operation: "appstore.app-lookup",
    });
    const metadata = getErrorBugsnagMetadata(wrapped);
    const traces = (metadata?.appleApi as any)?.recentHttpTraces || [];
    const trace = traces[traces.length - 1];

    expect(String(trace.response.body.hugeText)).toContain("[TRUNCATED:");
    expect(trace.response.body.list).toHaveLength(21);
    expect(trace.response.body.list[20]).toContain("[TRUNCATED:");
    expect(JSON.stringify(trace.response.body.nested)).toContain(
      "[TRUNCATED:DEPTH]"
    );
  });

  it("does not redact unrelated keys that merely contain letter a or c", async () => {
    const client = axios.create();
    attachAppleHttpTracing(client, "apple-auth");
    const mock = new AxiosMockAdapter(client);
    mock.onPost("/ok").reply(200, { aValue: "alpha", cValue: "charlie" });

    await client.post("/ok", { aValue: "alpha", cValue: "charlie" });

    const wrapped = withAppleHttpTraceContext(new Error("ok"), {
      provider: "apple-auth",
      operation: "test-op-2",
    });
    const metadata = getErrorBugsnagMetadata(wrapped);
    const traces = (metadata?.appleApi as any)?.recentHttpTraces || [];
    const trace = traces[traces.length - 1];
    expect(trace.request.body).toMatchObject({
      aValue: "alpha",
      cValue: "charlie",
    });
    expect(trace.response.body).toMatchObject({
      aValue: "alpha",
      cValue: "charlie",
    });
  });

  it("includes optional terminality hint in telemetry metadata", () => {
    const wrapped = withAppleHttpTraceContext(new Error("terminal"), {
      provider: "apple-search-ads",
      operation: "keywords-popularities-request",
      context: { statusCode: 503 },
      isTerminal: true,
    });

    const metadata = getErrorBugsnagMetadata(wrapped) as
      | { telemetryHint?: { isTerminal?: boolean; upstreamProvider?: string } }
      | undefined;
    expect(metadata?.telemetryHint).toEqual(
      expect.objectContaining({
        isTerminal: true,
        upstreamProvider: "apple-search-ads",
      })
    );
  });

  it("reports recovered apple contract drift with sanitized metadata", () => {
    reportAppleContractChange({
      provider: "apple-appstore",
      operation: "appstore.search-page",
      endpoint:
        "https://apps.apple.com/us/iphone/search?token=secret-query-value",
      expectedContract: "serialized-server-data exists",
      actualSignal: '{"password":"secret-password","signal":"script_missing"}',
      statusCode: 200,
      context: {
        password: "context-password",
        parser: "serialized-server-data",
      },
      isTerminal: false,
      driftKind: "search_page_serialized_data_missing",
      recoveryOutcome: "recovered",
      fallbackSource: "mzsearch",
    });

    expect(mockReportBugsnagError).toHaveBeenCalledTimes(1);
    expect(mockReportBugsnagError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        operation: "appstore.search-page",
        endpoint: expect.stringContaining("token=%5BREDACTED"),
        isTerminal: false,
        recoveryOutcome: "recovered",
        fallbackSource: "mzsearch",
        appleContractChange: expect.objectContaining({
          actualSignal: {
            password: expect.stringContaining("[REDACTED"),
            signal: "script_missing",
          },
        }),
      })
    );
    const wrapped = mockReportBugsnagError.mock.calls[0][0];
    expect(getErrorBugsnagMetadata(wrapped)).toEqual(
      expect.objectContaining({
        appleApi: expect.objectContaining({
          context: expect.objectContaining({
            password: expect.stringContaining("[REDACTED"),
          }),
        }),
      })
    );
  });

  it("reports terminal apple contract drifts with explicit classification", () => {
    reportAppleContractChange({
      provider: "apple-appstore",
      operation: "appstore.search-page",
      endpoint: "https://apps.apple.com/us/iphone/search",
      expectedContract: "serialized-server-data exists",
      actualSignal: "script_missing",
      statusCode: 200,
      isTerminal: true,
    });

    expect(mockReportBugsnagError).toHaveBeenCalledTimes(1);
    expect(mockReportBugsnagError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        telemetryHint: expect.objectContaining({
          classification: "apple_contract_change",
          upstreamProvider: "apple-appstore",
        }),
        appleContractChange: expect.objectContaining({
          operation: "appstore.search-page",
          dedupeWindowMs: 15 * 60 * 1000,
        }),
      })
    );
  });

  it("redacts sensitive metadata in terminal contract drift events", () => {
    reportAppleContractChange({
      provider: "apple-auth",
      operation: "signin.complete",
      endpoint: "https://idmsa.apple.com/signin?token=terminal-secret",
      expectedContract: "signin response includes auth attributes",
      actualSignal: '{"password":"secret","shape":"missing_auth"}',
      context: { cookie: "private-cookie", responseShape: "missing_auth" },
      error: new Error("password=secret must not be reported"),
      isTerminal: true,
      driftKind: "signin_auth_attributes_missing",
      recoveryOutcome: "unresolved",
    });

    expect(mockReportBugsnagError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        endpoint: expect.stringContaining("token=%5BREDACTED"),
        appleContractChange: expect.objectContaining({
          actualSignal: expect.objectContaining({
            password: expect.stringContaining("[REDACTED"),
          }),
        }),
      })
    );
    const wrapped = mockReportBugsnagError.mock.calls[0][0];
    expect((wrapped as Error).message).toBe(
      "Apple contract drift detected: signin.complete"
    );
    expect(getErrorBugsnagMetadata(wrapped)).toEqual(
      expect.objectContaining({
        appleApi: expect.objectContaining({
          context: expect.objectContaining({
            cookie: expect.stringContaining("[REDACTED"),
          }),
        }),
      })
    );
  });

  it("dedupes repeated apple contract drifts for 15 minutes", () => {
    jest.useFakeTimers();
    const params = {
      provider: "apple-appstore" as const,
      operation: "appstore.search-page",
      endpoint: "https://apps.apple.com/us/iphone/search",
      expectedContract: "serialized-server-data exists",
      actualSignal: "script_missing",
      statusCode: 200,
      isTerminal: true,
      dedupeKey: "search-page-script-missing",
    };

    reportAppleContractChange(params);
    reportAppleContractChange(params);
    expect(mockReportBugsnagError).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(15 * 60 * 1000 + 1);
    reportAppleContractChange(params);
    expect(mockReportBugsnagError).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it("does not let a recovered drift suppress a later terminal occurrence", () => {
    const common = {
      provider: "apple-appstore" as const,
      operation: "appstore.search-page",
      endpoint: "https://apps.apple.com/us/iphone/search",
      expectedContract: "serialized-server-data exists",
      actualSignal: "script_missing",
      statusCode: 200,
      driftKind: "search_page_serialized_data_missing",
    };

    reportAppleContractChange({
      ...common,
      isTerminal: false,
      recoveryOutcome: "recovered",
    });
    reportAppleContractChange({
      ...common,
      isTerminal: true,
      recoveryOutcome: "unresolved",
    });

    expect(mockReportBugsnagError).toHaveBeenCalledTimes(2);
  });

  it("does not dedupe distinct drift kinds from the same endpoint", () => {
    const common = {
      provider: "apple-appstore" as const,
      operation: "appstore.search-page",
      endpoint: "https://apps.apple.com/us/iphone/search",
      expectedContract: "valid search response",
      actualSignal: "shape_changed",
      statusCode: 200,
      isTerminal: false,
      recoveryOutcome: "recovered",
    };

    reportAppleContractChange({ ...common, driftKind: "missing_shelves" });
    reportAppleContractChange({ ...common, driftKind: "malformed_lockup" });

    expect(mockReportBugsnagError).toHaveBeenCalledTimes(2);
  });
});
