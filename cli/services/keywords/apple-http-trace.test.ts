import axios from "axios";
import AxiosMockAdapter from "axios-mock-adapter";
import {
  attachAppleHttpTracing,
  withAppleHttpTraceContext,
} from "./apple-http-trace";
import { getErrorBugsnagMetadata } from "../telemetry/bugsnag-metadata";

describe("apple-http-trace", () => {
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
});
