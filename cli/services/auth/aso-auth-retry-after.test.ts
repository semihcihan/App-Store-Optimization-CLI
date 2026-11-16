import type { AxiosRequestConfig } from "axios";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbForTests } from "../../db/store";
import { getAppleRetryCooldown } from "../runtime/apple-retry-cooldown";
import { asoCookieStoreService } from "./aso-cookie-store-service";
import { AsoAuthService } from "./aso-auth-service";

jest.mock("axios", () => {
  const actual = jest.requireActual<typeof import("axios")>("axios");
  const request = jest.fn();
  return {
    __esModule: true,
    default: {
      ...actual.default,
      create: () => Object.assign(actual.default.create(), { request }),
    },
    request,
  };
});

const request = jest.requireMock("axios").request as jest.Mock<
  Promise<unknown>,
  [AxiosRequestConfig]
>;

describe("Apple auth Retry-After", () => {
  let dbDir: string;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), "aso-auth-retry-test-"));
    jest.replaceProperty(process, "env", {
      ...process.env,
      ASO_AUTH_MODE: "auto",
      ASO_APPLE_WIDGET_KEY: "",
      ASO_DB_PATH: join(dbDir, "test.sqlite"),
    });
    request.mockReset();
    jest.useFakeTimers({ now: Date.UTC(2026, 10, 16) });
  });

  afterEach(() => {
    closeDbForTests();
    rmSync(dbDir, { recursive: true, force: true });
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("surfaces a SIRP init deadline on the first sign-in attempt", async () => {
    jest.spyOn(asoCookieStoreService, "loadCookies").mockReturnValue([]);
    request
      .mockResolvedValueOnce({ status: 200, data: { authServiceKey: "key" }, headers: {} })
      .mockResolvedValueOnce({ status: 200, data: {}, headers: {} })
      .mockResolvedValueOnce({ status: 503, data: {}, headers: { "retry-after": "120" } });
    const service = new AsoAuthService();
    const retryAt = Date.now() + 120_000;

    await expect(service.reAuthenticate({
      forcePromptCredentials: true,
      promptHandler: {
        prompt: async (prompt) =>
          prompt.kind === "apple_credentials"
            ? { kind: "apple_credentials", appleId: "user@example.com", password: "pw" }
            : { kind: "remember_credentials", remember: false },
      },
    })).rejects.toMatchObject({
      statusCode: 503,
      retryAt,
      message: expect.stringContaining(new Date(retryAt).toISOString()),
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2][0].url).toContain("/signin/init");
    expect(getAppleRetryCooldown("auth:idmsa.apple.com")).toEqual({
      statusCode: 503,
      retryAt,
    });
  });

  it("records the redirect destination and blocks a later redirect before it is sent", async () => {
    jest.spyOn(asoCookieStoreService, "loadCookies").mockReturnValue([
      {
        name: "session",
        value: "1",
        domain: "app-ads.apple.com",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
      },
    ]);
    const destination = "https://app-ads.apple.com/cm/app";
    const reachedDestination = jest.fn();
    request.mockImplementation(async (config) => {
      try {
        config.beforeRedirect?.(
          { href: destination },
          { statusCode: 302, headers: {} },
          { url: config.url!, method: "GET", headers: {} }
        );
      } catch (cause) {
        throw Object.assign(new Error("Redirect failed"), { cause });
      }
      reachedDestination();
      return {
        status: 429,
        data: {},
        headers: { "retry-after": "120" },
        request: { res: { responseUrl: destination } },
      };
    });
    const service = new AsoAuthService();
    const retryAt = Date.now() + 120_000;

    await expect(service.reAuthenticate()).rejects.toMatchObject({ statusCode: 429, retryAt });
    const initiatingHost = new URL(request.mock.calls[0][0].url!).host;
    expect(getAppleRetryCooldown(`auth:${initiatingHost}`)).toBeNull();
    expect(getAppleRetryCooldown("auth:app-ads.apple.com")).toEqual({
      statusCode: 429,
      retryAt,
    });

    await expect(service.reAuthenticate()).rejects.toMatchObject({ statusCode: 429, retryAt });
    expect(request).toHaveBeenCalledTimes(2);
    expect(reachedDestination).toHaveBeenCalledTimes(1);
  });
});
