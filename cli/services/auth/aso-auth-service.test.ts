import {
  AsoAuthEngine,
  AppleAuthResponseError,
  getTwoFactorVerificationErrorMessage,
  isInvalidAppleCredentialsError,
  isRetryableTwoFactorCodeError,
} from "./aso-auth-service";

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
