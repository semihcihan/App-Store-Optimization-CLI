import { z } from "zod";
import {
  ContextualError,
  extractClientErrorToSend,
  extractCorrectedDateFromAppleDetail,
  extractIncludedIndexFromApplePointer,
  extractTerritoryCodeFromAppleDetail,
  handleSubscriptionPricesBulkErrors,
  isInAppPurchaseLocalizationNotUpdatableError,
  isNotAuthorizedError,
  isNotFoundError,
  isRateLimitError,
  isSubscriptionGroupLocalizationNotUpdatableError,
  isSubscriptionLocalizationNotUpdatableError,
  isVersionNotUpdatableError,
} from "./error-handling-helpers";

describe("error-handling-helpers", () => {
  it("builds ContextualError with context and proper prototype", () => {
    const error = new ContextualError("outer", { nested: true });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ContextualError);
    expect(error.context).toEqual({ nested: true });
  });

  it("detects not-found errors from nested Apple payloads and fallbacks", () => {
    expect(
      isNotFoundError({
        some: {
          errors: [{ status: "404" }],
        },
      })
    ).toBe(true);
    expect(isNotFoundError({ response: { status: 404 } })).toBe(true);
    expect(isNotFoundError({ status: 500 })).toBe(false);
  });

  it("detects rate-limit and authorization errors", () => {
    expect(isRateLimitError({ status: 429 })).toBe(true);
    expect(
      isRateLimitError({
        errors: [{ status: "429" }],
      })
    ).toBe(true);
    expect(isRateLimitError({ status: 500 })).toBe(false);

    expect(
      isNotAuthorizedError({
        errors: [{ status: "401" }],
      })
    ).toBe(true);
    expect(
      isNotAuthorizedError({
        errors: [{ code: "NOT_AUTHORIZED" }],
      })
    ).toBe(true);
    expect(isNotAuthorizedError({ status: 500 })).toBe(false);
  });

  it("detects version-not-updatable and localization-not-updatable errors", () => {
    expect(isVersionNotUpdatableError({ status: 409 })).toBe(true);
    expect(
      isVersionNotUpdatableError({
        errors: [{ code: "ENTITY_ERROR.ATTRIBUTE.INVALID.INVALID_STATE" }],
      })
    ).toBe(true);
    expect(isVersionNotUpdatableError({ status: 400 })).toBe(false);

    const payload = {
      errors: [
        {
          code: "ENTITY_ERROR.ATTRIBUTE.INVALID.UNMODIFIABLE",
          detail: "Cannot edit InAppPurchaseLocalization",
        },
      ],
    };
    expect(isInAppPurchaseLocalizationNotUpdatableError(payload)).toBe(true);
    expect(isSubscriptionGroupLocalizationNotUpdatableError(payload)).toBe(false);
    expect(isSubscriptionLocalizationNotUpdatableError(payload)).toBe(false);
  });

  it("extracts pointer indexes, territory codes, and corrected dates", () => {
    expect(extractIncludedIndexFromApplePointer("/included/12/attributes")).toBe(12);
    expect(extractIncludedIndexFromApplePointer("/data/0")).toBeNull();
    expect(extractIncludedIndexFromApplePointer(null)).toBeNull();

    expect(
      extractTerritoryCodeFromAppleDetail("Invalid future prices territory=USA")
    ).toBe("USA");
    expect(extractTerritoryCodeFromAppleDetail("no territory")).toBeNull();

    expect(
      extractCorrectedDateFromAppleDetail(
        "startDate must be on or after 2026-02-15"
      )
    ).toBe("2026-02-15");
    expect(extractCorrectedDateFromAppleDetail("no date here")).toBeNull();
  });

  it("handles subscription bulk errors and derives retry corrections", () => {
    const error = new ContextualError("bulk failed", {
      errors: [
        {
          detail:
            "startDate must be on or after 2026-04-01 for included row",
          source: { pointer: "/included/2" },
        },
        {
          detail: "future prices conflict for territory=USA",
          source: { pointer: "/included/0" },
        },
        {
          detail: "future prices conflict without territory",
          source: { pointer: "/included/1" },
        },
      ],
    });

    const result = handleSubscriptionPricesBulkErrors({
      error,
      includedTerritories: ["CAN", "GBR", "FRA"],
    });

    expect(result.shouldRetry).toBe(true);
    expect(result.invalidIncludedCorrections).toEqual([
      { includedIndex: 2, correctedDate: "2026-04-01" },
    ]);
    expect(result.territoriesToFix).toEqual(expect.arrayContaining(["USA", "GBR"]));
  });

  it("extracts client-safe payloads from zod, contextual, and generic errors", () => {
    let zodError: unknown;
    try {
      z.object({ id: z.string() }).parse({ id: 123 });
    } catch (error) {
      zodError = error;
    }

    const zodResult = extractClientErrorToSend(zodError);
    expect(zodResult.status).toBe(400);
    expect(zodResult.message.toLowerCase()).toContain("validation");

    const contextual = new ContextualError("outer", {
      errors: [{ title: "Invalid", detail: "Bad input" }],
    });
    expect(extractClientErrorToSend(contextual)).toEqual({
      message: "outer",
      status: 400,
      details: [{ title: "Invalid", detail: "Bad input" }],
    });

    const contextualWithInner = new ContextualError(
      "outer",
      new ContextualError("inner", {
        errors: [{ title: "Nested", detail: "Inner detail" }],
      })
    );
    const nestedResult = extractClientErrorToSend(contextualWithInner);
    expect(nestedResult.status).toBe(400);
    expect(nestedResult.message).toContain("outer");
    expect(nestedResult.message).toContain("inner");
    expect(nestedResult.details).toEqual(
      expect.arrayContaining([{ title: "Nested", detail: "Inner detail" }])
    );

    expect(extractClientErrorToSend("simple")).toEqual({
      message: "simple",
      status: 400,
    });
    expect(extractClientErrorToSend(new Error("boom"))).toEqual({
      message: "boom",
      status: 400,
    });
    expect(extractClientErrorToSend({ unknown: true })).toEqual({
      message: "Internal server error",
      status: 500,
    });
  });
});
