import {
  AsoAuthEngine,
  AsoAuthService,
  AppleAuthResponseError,
  getTwoFactorVerificationErrorMessage,
  isInvalidAppleCredentialsError,
  isRetryableTwoFactorCodeError,
} from "./aso-auth-service";
import fs from "fs";
import inquirer from "inquirer";
import path from "path";
import { asoCookieStoreService } from "./aso-cookie-store-service";
import { asoKeychainService } from "./aso-keychain-service";
import * as appleHttpTrace from "../keywords/apple-http-trace";

function loadFixture(name: string): unknown {
  return JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "__fixtures__", "apple-auth", name),
      "utf8"
    )
  );
}

describe("aso-auth-service 2FA error classification", () => {
  it("treats verification-code messages as retryable for service_errors", () => {
    expect(
      isRetryableTwoFactorCodeError({
        service_errors: [
          {
            code: "-21669",
            title: "Incorrect Verification Code",
            message: "Incorrect verification code.",
          },
        ],
        hasError: true,
      })
    ).toBe(true);
  });

  it("does not rely on numeric code alone for retries", () => {
    expect(
      isRetryableTwoFactorCodeError({
        service_errors: [
          {
            code: "-21669",
            title: "Auth failure",
            message: "Something went wrong.",
          },
        ],
      })
    ).toBe(false);
  });

  it("treats validationErrors verification-code messages as retryable", () => {
    expect(
      isRetryableTwoFactorCodeError({
        validationErrors: [
          {
            title: "Incorrect Verification Code",
            message: "Incorrect verification code.",
          },
        ],
      })
    ).toBe(true);
  });

  it("does not retry when payload indicates lockout", () => {
    expect(
      isRetryableTwoFactorCodeError({
        service_errors: [
          {
            code: "-12345",
            title: "Too many verification codes",
            message: "Too many verification codes sent. Try again later.",
          },
        ],
      })
    ).toBe(false);
  });

  it("returns first message for user-facing verification errors", () => {
    expect(
      getTwoFactorVerificationErrorMessage({
        serviceErrors: [
          {
            code: "-21669",
            title: "Incorrect Verification Code",
            message: "Incorrect verification code.",
          },
        ],
      })
    ).toBe("Incorrect verification code.");
  });

  it("falls back to generic message when no errors are present", () => {
    expect(getTwoFactorVerificationErrorMessage({ hasError: true })).toBe(
      "Verification failed. Please try again."
    );
  });

  it("detects invalid Apple ID credentials errors", () => {
    expect(
      isInvalidAppleCredentialsError(new Error("Invalid Apple ID credentials"))
    ).toBe(true);
    expect(
      isInvalidAppleCredentialsError(new Error("invalid credentials provided"))
    ).toBe(true);
    expect(
      isInvalidAppleCredentialsError(new Error("network timeout"))
    ).toBe(false);
    expect(
      isInvalidAppleCredentialsError(
        new AppleAuthResponseError({
          message: "Forbidden",
          status: 403,
          payload: {},
          reason: "invalid_credentials",
        })
      )
    ).toBe(true);
    expect(
      isInvalidAppleCredentialsError(
        new AppleAuthResponseError({
          message: "2FA required",
          status: 409,
          payload: {},
          reason: "two_factor_required",
        })
      )
    ).toBe(false);
  });
});

describe("aso-auth-service fixture-backed verification payload handling", () => {
  const fixtureCases = [
    {
      file: "verify_incorrect_code.service_errors.json",
      retryable: true,
      message: "Incorrect verification code.",
    },
    {
      file: "verify_locked.validation_errors.json",
      retryable: false,
      message: "Your account is locked. Try again later.",
    },
    {
      file: "verify_rate_limited.service_errors.json",
      retryable: false,
      message: "Rate limit exceeded for verification attempts.",
    },
    {
      file: "verify_expired_code.service_errors.json",
      retryable: false,
      message: "This verification code has expired.",
    },
  ];

  it.each(fixtureCases)(
    "classifies $file correctly",
    ({ file, retryable, message }) => {
      const payload = loadFixture(file);
      expect(isRetryableTwoFactorCodeError(payload)).toBe(retryable);
      expect(getTwoFactorVerificationErrorMessage(payload)).toBe(message);
    }
  );
});

describe("aso-auth-service legacy parity edge handling", () => {
  function createEngine(): AsoAuthEngine {
    return new AsoAuthEngine({ request: jest.fn() } as any, "legacy");
  }

  it("treats invalid=true payloads as invalid credentials", async () => {
    const engine = createEngine();

    await expect(
      (engine as any).handlePostLoginResponse({
        status: 500,
        data: '<html><body invalid="true">invalid</body></html>',
        headers: {},
      })
    ).rejects.toMatchObject({
      name: "AppleAuthResponseError",
      reason: "invalid_credentials",
    });
  });

  it("treats JSON-string invalid=true payloads as invalid credentials", async () => {
    const engine = createEngine();

    await expect(
      (engine as any).handlePostLoginResponse({
        status: 500,
        data: '{"invalid":"true"}',
        headers: {},
      })
    ).rejects.toMatchObject({
      name: "AppleAuthResponseError",
      reason: "invalid_credentials",
    });
  });

  it("treats 412 authType responses as upgrade required", async () => {
    const engine = createEngine();

    await expect(
      (engine as any).handlePostLoginResponse({
        status: 412,
        data: { authType: "hsa2" },
        headers: {},
      })
    ).rejects.toMatchObject({
      name: "AppleAuthResponseError",
      reason: "upgrade_required",
    });
  });

  it("maps 401 -20101 responses to invalid credentials without contract drift", async () => {
    const engine = createEngine();
    const reportContractSpy = jest
      .spyOn(appleHttpTrace, "reportAppleContractChange")
      .mockImplementation(() => {});

    await expect(
      (engine as any).handlePostLoginResponse({
        status: 401,
        data: {
          serviceErrors: [
            {
              code: "-20101",
              message: "Check the account information you entered and try again.",
            },
          ],
        },
        headers: {},
      })
    ).rejects.toMatchObject({
      name: "AppleAuthResponseError",
      reason: "invalid_credentials",
    });
    expect(reportContractSpy).not.toHaveBeenCalled();
  });

  it("maps itctx cookie responses to explicit account-access error", async () => {
    const engine = createEngine();

    await expect(
      (engine as any).handlePostLoginResponse({
        status: 500,
        data: {},
        headers: { "set-cookie": ["itctx=some-value; Path=/"] },
      })
    ).rejects.toMatchObject({
      name: "AppleAuthResponseError",
    });
    await expect(
      (engine as any).handlePostLoginResponse({
        status: 500,
        data: {},
        headers: { "set-cookie": ["itctx=some-value; Path=/"] },
      })
    ).rejects.toThrow("not enabled for App Store Connect");
  });

  it("does not retry legacy login for deterministic invalid=true failures", async () => {
    const request = jest.fn().mockResolvedValue({
      status: 500,
      data: '<html><body invalid="true">invalid</body></html>',
      headers: {},
    });
    const engine = new AsoAuthEngine({ request } as any, "legacy") as any;
    engine.fetchHashcash = jest.fn().mockResolvedValue(undefined);

    await expect(
      engine.requestLegacyWithRetry(
        { appleId: "user@example.com", password: "pw" },
        3
      )
    ).resolves.toMatchObject({ status: 500 });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("aso-auth-service sirp fallback policy", () => {
  const credentials = { appleId: "user@example.com", password: "pw" };

  function createAutoEngine(): any {
    const engine = new AsoAuthEngine({ request: jest.fn() } as any, "auto") as any;
    engine.resolveWidgetKey = jest.fn().mockResolvedValue("widget-key");
    engine.bootstrapAuthRequestContext = jest.fn().mockResolvedValue({
      frameId: "frame-id",
      state: "state-id",
    });
    return engine;
  }

  it("does not fallback to legacy for invalid credentials", async () => {
    const engine = createAutoEngine();
    engine.loginWithSirp = jest.fn().mockRejectedValue(
      new AppleAuthResponseError({
        message: "Invalid Apple ID credentials",
        status: 403,
        payload: {},
        reason: "invalid_credentials",
      })
    );
    engine.loginWithLegacy = jest.fn().mockResolvedValue(undefined);

    await expect(engine.ensureAuthenticated(credentials)).rejects.toMatchObject({
      reason: "invalid_credentials",
    });
    expect(engine.loginWithLegacy).not.toHaveBeenCalled();
  });

  it("falls back once to legacy for unknown SIRP failures", async () => {
    const engine = createAutoEngine();
    engine.loginWithSirp = jest
      .fn()
      .mockRejectedValue(new Error("SIRP transport error"));
    engine.loginWithLegacy = jest.fn().mockResolvedValue(undefined);

    await expect(engine.ensureAuthenticated(credentials)).resolves.toBeUndefined();
    expect(engine.loginWithLegacy).toHaveBeenCalledTimes(1);
    expect(engine.loginWithLegacy).toHaveBeenCalledWith(credentials, {
      maxAttempts: 1,
    });
  });
});

describe("aso-auth-service session reuse and keychain flow", () => {
  const originalStdinTTY = process.stdin.isTTY;
  const originalStdoutTTY = process.stdout.isTTY;

  beforeEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: originalStdinTTY,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: originalStdoutTTY,
    });
    jest.restoreAllMocks();
  });

  it("reuses an existing valid session before keychain/prompt auth", async () => {
    const service = new AsoAuthService();
    const establishSpy = jest
      .spyOn(AsoAuthEngine.prototype, "establishAppAdsSession")
      .mockResolvedValue(undefined);
    const ensureSpy = jest
      .spyOn(AsoAuthEngine.prototype, "ensureAuthenticated")
      .mockResolvedValue(undefined);
    const loadKeychainSpy = jest
      .spyOn(asoKeychainService, "loadCredentials")
      .mockReturnValue({
        appleId: "user@example.com",
        password: "pw",
      });
    jest.spyOn(asoCookieStoreService, "loadCookies").mockReturnValue([
      {
        name: "appads",
        value: "1",
        domain: "app.searchads.apple.com",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
      },
    ]);
    jest.spyOn(asoCookieStoreService, "saveCookies").mockImplementation(() => {});

    const cookieHeader = await service.reAuthenticate();
    expect(cookieHeader).toContain("appads=1");
    expect(establishSpy).toHaveBeenCalledTimes(1);
    expect(ensureSpy).not.toHaveBeenCalled();
    expect(loadKeychainSpy).not.toHaveBeenCalled();
  });

  it("clears invalid keychain credentials and retries with prompted credentials", async () => {
    const service = new AsoAuthService();
    const ensureSpy = jest
      .spyOn(AsoAuthEngine.prototype, "ensureAuthenticated")
      .mockRejectedValueOnce(
        new AppleAuthResponseError({
          message: "Invalid Apple ID credentials",
          status: 403,
          payload: {},
          reason: "invalid_credentials",
        })
      )
      .mockResolvedValueOnce(undefined);

    jest.spyOn(asoCookieStoreService, "loadCookies").mockReturnValue([]);
    jest.spyOn(asoCookieStoreService, "saveCookies").mockImplementation(() => {});
    jest
      .spyOn(asoKeychainService, "loadCredentials")
      .mockReturnValueOnce({
        appleId: "old@example.com",
        password: "old-pw",
      })
      .mockReturnValueOnce(null);

    const clearSpy = jest
      .spyOn(asoKeychainService, "clearCredentials")
      .mockImplementation(() => {});
    const saveSpy = jest
      .spyOn(asoKeychainService, "saveCredentials")
      .mockImplementation(() => {});
    const promptSpy = jest
      .spyOn(inquirer, "prompt")
      .mockResolvedValueOnce({
        appleId: "new@example.com",
        password: "new-pw",
      } as any)
      .mockResolvedValueOnce({ remember: true } as any);

    await service.reAuthenticate();

    expect(ensureSpy).toHaveBeenCalledTimes(2);
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(promptSpy).toHaveBeenCalledTimes(2);
    expect(saveSpy).toHaveBeenCalledWith({
      appleId: "new@example.com",
      password: "new-pw",
    });
  });

  it("fails with actionable message when prompt auth is required without TTY", async () => {
    const service = new AsoAuthService();
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });

    jest.spyOn(asoCookieStoreService, "loadCookies").mockReturnValue([]);
    jest.spyOn(asoKeychainService, "loadCredentials").mockReturnValue(null);

    await expect(service.reAuthenticate()).rejects.toThrow(
      "Interactive terminal is required to enter Apple credentials"
    );
  });
});

describe("aso-auth-service cookie header scoping", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("filters cookies by target URL domain/path/secure rules", () => {
    const service = new AsoAuthService();
    jest.spyOn(asoCookieStoreService, "loadCookies").mockReturnValue([
      {
        name: "searchads-path-match",
        value: "1",
        domain: "app.searchads.apple.com",
        path: "/cm",
        expires: -1,
        httpOnly: true,
        secure: true,
      },
      {
        name: "searchads-path-miss",
        value: "2",
        domain: "app.searchads.apple.com",
        path: "/foo",
        expires: -1,
        httpOnly: true,
        secure: true,
      },
      {
        name: "app-ads-domain",
        value: "3",
        domain: "app-ads.apple.com",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
      },
    ]);

    const httpsHeader = service.getCookieHeader(
      "https://app.searchads.apple.com/cm/api/v4"
    );
    expect(httpsHeader).toContain("searchads-path-match=1");
    expect(httpsHeader).not.toContain("searchads-path-miss=2");
    expect(httpsHeader).not.toContain("app-ads-domain=3");

    const httpHeader = service.getCookieHeader(
      "http://app.searchads.apple.com/cm/api/v4"
    );
    expect(httpHeader).toBe("");
  });
});

describe("aso-auth-service 2FA method handling", () => {
  const originalStdinTTY = process.stdin.isTTY;
  const originalStdoutTTY = process.stdout.isTTY;

  beforeEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: originalStdinTTY,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: originalStdoutTTY,
    });
    jest.restoreAllMocks();
  });

  it("uses single-phone noTrustedDevices flow without requesting SMS send", async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        data: {
          noTrustedDevices: true,
          trustedPhoneNumbers: [{ id: 7, numberWithDialCode: "+1 ••• ••11" }],
          securityCode: { length: 6 },
        },
        headers: {},
      })
      .mockResolvedValueOnce({
        status: 204,
        data: {},
        headers: {},
      })
      .mockResolvedValueOnce({
        status: 204,
        data: {},
        headers: {},
      });
    const engine = new AsoAuthEngine({ request } as any, "auto") as any;
    jest.spyOn(inquirer, "prompt").mockResolvedValue({ code: "123456" } as any);

    await expect(
      engine.handleTwoFactor({
        scnt: "scnt",
        xAppleIdSessionId: "session-id",
      })
    ).resolves.toEqual({
      scnt: "scnt",
      xAppleIdSessionId: "session-id",
    });

    const calledUrls = request.mock.calls.map(
      (call) => (call[0] as { url?: string }).url || ""
    );
    expect(
      calledUrls.some((url) => url.endsWith("/verify/phone"))
    ).toBe(false);
    expect(
      calledUrls.some((url) => url.endsWith("/verify/phone/securitycode"))
    ).toBe(true);
  });

  it("retries once for retryable verification error and then succeeds", async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        data: {
          noTrustedDevices: true,
          trustedPhoneNumbers: [{ id: 7, numberWithDialCode: "+1 ••• ••11" }],
          securityCode: { length: 6 },
        },
        headers: {},
      })
      .mockResolvedValueOnce({
        status: 409,
        data: loadFixture("verify_incorrect_code.service_errors.json"),
        headers: {},
      })
      .mockResolvedValueOnce({
        status: 204,
        data: {},
        headers: {},
      })
      .mockResolvedValueOnce({
        status: 204,
        data: {},
        headers: {},
      });
    const engine = new AsoAuthEngine({ request } as any, "auto") as any;
    jest
      .spyOn(inquirer, "prompt")
      .mockResolvedValueOnce({ code: "111111" } as any)
      .mockResolvedValueOnce({ code: "222222" } as any);

    await expect(
      engine.handleTwoFactor({
        scnt: "scnt",
        xAppleIdSessionId: "session-id",
      })
    ).resolves.toEqual({
      scnt: "scnt",
      xAppleIdSessionId: "session-id",
    });

    const verifyCodeCalls = request.mock.calls.filter((call) =>
      String((call[0] as { url?: string }).url || "").endsWith(
        "/verify/phone/securitycode"
      )
    );
    expect(verifyCodeCalls).toHaveLength(2);
  });

  it("throws on non-retryable lockout verification error", async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        data: {
          noTrustedDevices: true,
          trustedPhoneNumbers: [{ id: 7, numberWithDialCode: "+1 ••• ••11" }],
          securityCode: { length: 6 },
        },
        headers: {},
      })
      .mockResolvedValueOnce({
        status: 409,
        data: loadFixture("verify_locked.validation_errors.json"),
        headers: {},
      });
    const engine = new AsoAuthEngine({ request } as any, "auto") as any;
    jest.spyOn(inquirer, "prompt").mockResolvedValue({ code: "111111" } as any);

    await expect(
      engine.handleTwoFactor({
        scnt: "scnt",
        xAppleIdSessionId: "session-id",
      })
    ).rejects.toThrow("Try again later.");
  });

  it("prompts for phone selection when noTrustedDevices has multiple phones", async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        data: {
          noTrustedDevices: true,
          trustedPhoneNumbers: [
            { id: 7, numberWithDialCode: "+1 ••• ••11" },
            { id: 8, numberWithDialCode: "+1 ••• ••22" },
          ],
          securityCode: { length: 8 },
        },
        headers: {},
      })
      .mockResolvedValueOnce({
        status: 204,
        data: {},
        headers: {},
      })
      .mockResolvedValueOnce({
        status: 204,
        data: {},
        headers: {},
      })
      .mockResolvedValueOnce({
        status: 204,
        data: {},
        headers: {},
      });
    const engine = new AsoAuthEngine({ request } as any, "auto") as any;
    const promptSpy = jest
      .spyOn(inquirer, "prompt")
      .mockResolvedValueOnce({
        value: "8",
      } as any)
      .mockResolvedValueOnce({ code: "12345678" } as any);

    await engine.handleTwoFactor({
      scnt: "scnt",
      xAppleIdSessionId: "session-id",
    });

    const sendCodeCall = request.mock.calls.find((call) =>
      String((call[0] as { url?: string }).url || "").endsWith("/verify/phone")
    );
    expect(sendCodeCall).toBeDefined();
    expect((sendCodeCall?.[0] as { data?: { phoneNumber?: { id: number } } }).data)
      .toMatchObject({ phoneNumber: { id: 8 } });

    const verifyCall = request.mock.calls.find((call) =>
      String((call[0] as { url?: string }).url || "").endsWith(
        "/verify/phone/securitycode"
      )
    );
    expect(verifyCall).toBeDefined();
    expect((verifyCall?.[0] as { data?: { securityCode?: { code: string } } }).data)
      .toMatchObject({ securityCode: { code: "12345678" } });
    expect(promptSpy).toHaveBeenCalledTimes(2);
  });

  it("uses trusted-device path with dynamic code length when selected", async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        data: {
          noTrustedDevices: false,
          trustedPhoneNumbers: [{ id: 7, numberWithDialCode: "+1 ••• ••11" }],
          trustedDevices: [{ id: "trusted-device" }],
          securityCode: { length: 8 },
        },
        headers: {},
      })
      .mockResolvedValueOnce({
        status: 204,
        data: {},
        headers: {},
      })
      .mockResolvedValueOnce({
        status: 204,
        data: {},
        headers: {},
      });
    const engine = new AsoAuthEngine({ request } as any, "auto") as any;
    const promptSpy = jest
      .spyOn(inquirer, "prompt")
      .mockResolvedValueOnce({ method: "trusteddevice" } as any)
      .mockResolvedValueOnce({ code: "12345678" } as any);

    await engine.handleTwoFactor({
      scnt: "scnt",
      xAppleIdSessionId: "session-id",
    });

    const calledUrls = request.mock.calls.map(
      (call) => (call[0] as { url?: string }).url || ""
    );
    expect(
      calledUrls.some((url) => url.endsWith("/verify/trusteddevice/securitycode"))
    ).toBe(true);
    expect(calledUrls.some((url) => url.endsWith("/verify/phone"))).toBe(false);
    const secondPromptQuestions = promptSpy.mock.calls[1][0] as Array<{
      message?: string;
    }>;
    expect(secondPromptQuestions[0]?.message).toContain("8-digit");
  });

  it("fails when no supported 2FA verification methods are returned", async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        data: {
          noTrustedDevices: true,
          trustedPhoneNumbers: [],
          trustedDevices: [],
        },
        headers: {},
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          noTrustedDevices: true,
          trustedPhoneNumbers: [],
          trustedDevices: [],
        },
        headers: {},
      });
    const engine = new AsoAuthEngine({ request } as any, "auto") as any;

    await expect(
      engine.handleTwoFactor({
        scnt: "scnt",
        xAppleIdSessionId: "session-id",
      })
    ).rejects.toThrow("No supported 2FA verification methods were returned.");
  });

  it("treats Apple -28248 as verification delivery failure instead of contract drift", async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        status: 500,
        data: {
          noTrustedDevices: true,
          trustedPhoneNumbers: [],
          trustedDevices: [],
          serviceErrors: [
            {
              code: "-28248",
              title: "Verification Failed",
              message:
                "Verification codes cannot be sent to this phone number at this time. Please try again later.",
            },
          ],
        },
        headers: {},
      })
      .mockResolvedValueOnce({
        status: 500,
        data: {
          noTrustedDevices: true,
          trustedPhoneNumbers: [],
          trustedDevices: [],
          serviceErrors: [
            {
              code: "-28248",
              title: "Verification Failed",
              message:
                "Verification codes cannot be sent to this phone number at this time. Please try again later.",
            },
          ],
        },
        headers: {},
      });
    const reportContractSpy = jest
      .spyOn(appleHttpTrace, "reportAppleContractChange")
      .mockImplementation(() => {});
    const engine = new AsoAuthEngine({ request } as any, "auto") as any;

    await expect(
      engine.handleTwoFactor({
        scnt: "scnt",
        xAppleIdSessionId: "session-id",
      })
    ).rejects.toMatchObject({
      name: "AppleAuthResponseError",
      reason: "verification_delivery_failed",
    });
    expect(reportContractSpy).not.toHaveBeenCalled();
  });

  it("fails fast when 2FA is attempted without interactive TTY", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
    const request = jest.fn();
    const engine = new AsoAuthEngine({ request } as any, "auto") as any;

    await expect(
      engine.handleTwoFactor({
        scnt: "scnt",
        xAppleIdSessionId: "session-id",
      })
    ).rejects.toThrow(
      "Interactive terminal is required to complete Apple two-factor authentication"
    );
    expect(request).not.toHaveBeenCalled();
  });
});

describe("aso-auth-service app-ads handoff integration", () => {
  function createResponse(
    status: number,
    options?: {
      headers?: Record<string, string>;
      responseUrl?: string;
      data?: unknown;
    }
  ): Record<string, unknown> {
    return {
      status,
      data: options?.data ?? {},
      headers: options?.headers ?? {},
      request: {
        res: {
          responseUrl: options?.responseUrl,
        },
      },
    };
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("establishes app-ads session via webauth handoff redirects", async () => {
    const request = jest.fn(async (config: { method: string; url: string }) => {
      if (
        config.method === "get" &&
        config.url.includes("/IDMSWebAuth/signin")
      ) {
        return createResponse(200, { headers: { scnt: "scnt-updated" } });
      }
      if (
        config.method === "post" &&
        config.url.includes("/IDMSWebAuth/signin")
      ) {
        return createResponse(302, {
          headers: {
            location: "https://app.searchads.apple.com/cm/app?handoff=1",
          },
        });
      }
      if (config.url.includes("handoff=1")) {
        return createResponse(302, {
          headers: { location: "https://app-ads.apple.com/cm/app/final" },
        });
      }
      if (config.url.includes("app-ads.apple.com/cm/app/final")) {
        return createResponse(200, {
          responseUrl: "https://app-ads.apple.com/cm/app/final",
        });
      }
      throw new Error(`Unexpected request: ${config.method} ${config.url}`);
    });

    const engine = new AsoAuthEngine({ request } as any, "auto");
    await expect(
      engine.establishAppAdsSession({
        scnt: "scnt",
        xAppleIdSessionId: "session-id",
      })
    ).resolves.toBeUndefined();
  });

  it("rejects handoff when redirect location is not searchads", async () => {
    const request = jest.fn(async (config: { method: string; url: string }) => {
      if (
        config.method === "get" &&
        config.url.includes("/IDMSWebAuth/signin")
      ) {
        return createResponse(200, { headers: { scnt: "scnt-updated" } });
      }
      if (
        config.method === "post" &&
        config.url.includes("/IDMSWebAuth/signin")
      ) {
        return createResponse(302, {
          headers: {
            location: "https://example.com/unexpected",
          },
        });
      }
      throw new Error(`Unexpected request: ${config.method} ${config.url}`);
    });

    const engine = new AsoAuthEngine({ request } as any, "auto");
    await expect(
      engine.establishAppAdsSession({
        scnt: "scnt",
        xAppleIdSessionId: "session-id",
      })
    ).rejects.toThrow("WebAuth handoff redirected to unexpected location");
  });

  it("establishes app-ads session from app-ads start when no session headers are passed", async () => {
    const request = jest.fn(async (config: { method: string; url: string }) => {
      if (
        config.method === "get" &&
        config.url.includes("/IDMSWebAuth/signin")
      ) {
        return createResponse(200);
      }
      if (config.url === "https://app-ads.apple.com/cm/app") {
        return createResponse(200, {
          responseUrl: "https://app-ads.apple.com/cm/app",
        });
      }
      throw new Error(`Unexpected request: ${config.method} ${config.url}`);
    });

    const engine = new AsoAuthEngine({ request } as any, "auto");
    await expect(engine.establishAppAdsSession()).resolves.toBeUndefined();
  });
});
