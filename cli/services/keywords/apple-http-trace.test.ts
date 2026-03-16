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

  it("attaches last 10 calls plus recent failed calls that fell out of the window", async () => {
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
        new URL(trace.request.url || "", "https://apple.local").searchParams.get(
          "seq"
        )
      )
    );
    const failedSeq = failedTraces.map((trace: any) =>
      Number(
        new URL(trace.request.url || "", "https://apple.local").searchParams.get(
          "seq"
        )
      )
    );

    expect(traceSeq).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2]);
    expect(failedSeq).toEqual([1, 2, 5]);
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

  it("reports apple contract drifts with explicit contract classification", () => {
    reportAppleContractChange({
      provider: "apple-appstore",
      operation: "appstore.search-page",
      endpoint: "https://apps.apple.com/us/iphone/search",
      expectedContract: "serialized-server-data exists",
      actualSignal: "script_missing",
      statusCode: 200,
      isTerminal: false,
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

  it("dedupes repeated apple contract drifts for 15 minutes", () => {
    jest.useFakeTimers();
    const params = {
      provider: "apple-appstore" as const,
      operation: "appstore.search-page",
      endpoint: "https://apps.apple.com/us/iphone/search",
      expectedContract: "serialized-server-data exists",
      actualSignal: "script_missing",
      statusCode: 200,
      isTerminal: false,
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
});
