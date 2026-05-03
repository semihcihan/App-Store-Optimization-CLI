import { jest } from "@jest/globals";
import {
  asoPopularityService,
} from "./aso-popularity-service";
import { asoAuthService } from "../auth/aso-auth-service";
import { requestPopularitiesWithKwsRetry } from "./aso-apple-popularity-client";
import { getConfiguredAsoAdamId } from "./aso-adam-id-service";

jest.mock("../auth/aso-auth-service", () => ({
  asoAuthService: {
    getCookieHeader: jest.fn(),
    reAuthenticate: jest.fn(),
  },
}));

jest.mock("./aso-apple-popularity-client", () => ({
  requestPopularitiesWithKwsRetry: jest.fn(),
}));

jest.mock("./aso-adam-id-service", () => ({
  getConfiguredAsoAdamId: jest.fn(),
}));

const mockRequestPopularitiesWithKwsRetry = jest.mocked(
  requestPopularitiesWithKwsRetry
);

describe("AsoPopularityService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(asoAuthService.getCookieHeader).mockReturnValue("cookie=value");
    jest.mocked(getConfiguredAsoAdamId).mockReturnValue("1234567890");
  });

  describe("fetchKeywordPopularities", () => {
    it("throws when more than 100 keywords", async () => {
      const many = Array.from({ length: 101 }, (_, i) => `kw${i}`);
      await expect(
        asoPopularityService.fetchKeywordPopularities(many)
      ).rejects.toThrow("A maximum of 100 keywords is supported per call");
      expect(mockRequestPopularitiesWithKwsRetry).not.toHaveBeenCalled();
    });

    it("returns empty object for empty keywords", async () => {
      const result = await asoPopularityService.fetchKeywordPopularities([]);
      expect(result).toEqual({});
      expect(mockRequestPopularitiesWithKwsRetry).not.toHaveBeenCalled();
    });

    it("returns empty object when all keywords are whitespace", async () => {
      const result = await asoPopularityService.fetchKeywordPopularities([
        "  ",
        " ",
        "",
      ]);
      expect(result).toEqual({});
      expect(mockRequestPopularitiesWithKwsRetry).not.toHaveBeenCalled();
    });

    it("sanitizes keywords and maps response back to original casing", async () => {
      mockRequestPopularitiesWithKwsRetry.mockResolvedValue({
        statusCode: 200,
        attempts: 1,
        data: {
          status: "success",
          data: [
            { name: "keyword", popularity: 42 },
            { name: "another", popularity: 10 },
          ],
        },
      });

      const result = await asoPopularityService.fetchKeywordPopularities([
        "Keyword",
        "ANOTHER",
      ]);

      expect(result).toEqual({ Keyword: 42, ANOTHER: 10 });
      expect(mockRequestPopularitiesWithKwsRetry).toHaveBeenCalledWith(
        ["keyword", "another"],
        "cookie=value",
        expect.any(String)
      );
      expect(asoAuthService.getCookieHeader).toHaveBeenCalledWith(
        "https://app-ads.apple.com/cm/api/v2/keywords/popularities"
      );
    });

    it("skips items with null popularity", async () => {
      mockRequestPopularitiesWithKwsRetry.mockResolvedValue({
        statusCode: 200,
        attempts: 1,
        data: {
          status: "success",
          data: [
            { name: "a", popularity: 1 },
            { name: "b", popularity: null },
            { name: "c", popularity: 3 },
          ],
        },
      });

      const result = await asoPopularityService.fetchKeywordPopularities([
        "a",
        "b",
        "c",
      ]);

      expect(result).toEqual({ a: 1, c: 3 });
    });

    it("throws ContextualError on non-200 response", async () => {
      mockRequestPopularitiesWithKwsRetry.mockResolvedValue({
        statusCode: 500,
        attempts: 1,
        data: { status: "error" },
      });

      await expect(
        asoPopularityService.fetchKeywordPopularities(["test"])
      ).rejects.toThrow("Popularity API request failed with status 500");
    });

    it("throws when adam id is missing", async () => {
      jest.mocked(getConfiguredAsoAdamId).mockReturnValue(null);

      await expect(
        asoPopularityService.fetchKeywordPopularities(["test"])
      ).rejects.toThrow("Primary App ID is missing.");
      expect(mockRequestPopularitiesWithKwsRetry).not.toHaveBeenCalled();
    });

    it("throws ContextualError when status is not success", async () => {
      mockRequestPopularitiesWithKwsRetry.mockResolvedValue({
        statusCode: 200,
        attempts: 1,
        data: { status: "error", error: { errors: [{ messageCode: "ERR" }] } },
      });

      await expect(
        asoPopularityService.fetchKeywordPopularities(["test"])
      ).rejects.toThrow("Popularity API request failed with status 200");
    });

    it("reauthenticates when getCookieHeader returns empty and retries", async () => {
      jest.mocked(asoAuthService.getCookieHeader).mockReturnValue("");
      jest.mocked(asoAuthService.reAuthenticate).mockResolvedValue("new-cookie");
      mockRequestPopularitiesWithKwsRetry.mockResolvedValue({
        statusCode: 200,
        attempts: 1,
        data: { status: "success", data: [{ name: "x", popularity: 1 }] },
      });

      const result = await asoPopularityService.fetchKeywordPopularities(["x"]);

      expect(asoAuthService.reAuthenticate).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ x: 1 });
      expect(mockRequestPopularitiesWithKwsRetry).toHaveBeenCalledWith(
        ["x"],
        "new-cookie",
        expect.any(String)
      );
    });

    it("throws auth-required error without interactive recovery when cookie is missing", async () => {
      jest.mocked(asoAuthService.getCookieHeader).mockReturnValue("");

      await expect(
        asoPopularityService.fetchKeywordPopularities(["x"], {
          allowInteractiveAuthRecovery: false,
        })
      ).rejects.toMatchObject({ code: "ASO_AUTH_REAUTH_REQUIRED" });
      expect(asoAuthService.reAuthenticate).not.toHaveBeenCalled();
      expect(mockRequestPopularitiesWithKwsRetry).not.toHaveBeenCalled();
    });

    it("retries once after auth failure (401)", async () => {
      mockRequestPopularitiesWithKwsRetry
        .mockResolvedValueOnce({
          statusCode: 401,
          attempts: 1,
          data: {},
        })
        .mockResolvedValueOnce({
          statusCode: 200,
          attempts: 1,
          data: { status: "success", data: [{ name: "y", popularity: 2 }] },
        });
      jest.mocked(asoAuthService.reAuthenticate).mockResolvedValue(
        "refreshed-cookie"
      );

      const result = await asoPopularityService.fetchKeywordPopularities(["y"]);

      expect(asoAuthService.reAuthenticate).toHaveBeenCalledTimes(1);
      expect(mockRequestPopularitiesWithKwsRetry).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ y: 2 });
    });

    it("does not loop reauthentication when post-reauth response is still auth failure", async () => {
      mockRequestPopularitiesWithKwsRetry
        .mockResolvedValueOnce({
          statusCode: 401,
          attempts: 1,
          data: {},
        })
        .mockResolvedValueOnce({
          statusCode: 401,
          attempts: 1,
          data: {},
        });
      jest.mocked(asoAuthService.reAuthenticate).mockResolvedValue(
        "refreshed-cookie"
      );

      await expect(
        asoPopularityService.fetchKeywordPopularities(["y"])
      ).rejects.toThrow("Popularity API request failed with status 401");

      expect(asoAuthService.reAuthenticate).toHaveBeenCalledTimes(1);
      expect(mockRequestPopularitiesWithKwsRetry).toHaveBeenCalledTimes(2);
    });

    it("throws auth-required error without interactive recovery on auth failure response", async () => {
      mockRequestPopularitiesWithKwsRetry.mockResolvedValue({
        statusCode: 401,
        attempts: 1,
        data: {},
      });

      await expect(
        asoPopularityService.fetchKeywordPopularities(["y"], {
          allowInteractiveAuthRecovery: false,
        })
      ).rejects.toMatchObject({ code: "ASO_AUTH_REAUTH_REQUIRED" });
      expect(asoAuthService.reAuthenticate).not.toHaveBeenCalled();
      expect(mockRequestPopularitiesWithKwsRetry).toHaveBeenCalledTimes(1);
    });

    it("throws contextual KWS error for no-org code after retries are exhausted", async () => {
      mockRequestPopularitiesWithKwsRetry.mockResolvedValue({
        statusCode: 403,
        attempts: 1,
        data: {
          status: "error",
          error: {
            errors: [
              {
                messageCode: "KWS_NO_ORG_CONTENT_PROVIDERS",
                message: "No org content providers",
              },
            ],
          },
        },
      });

      await expect(
        asoPopularityService.fetchKeywordPopularities(["z"])
      ).rejects.toThrow("No org content providers");
      expect(asoAuthService.reAuthenticate).not.toHaveBeenCalled();
    });

    it("throws primary app id access error for no-user-owned-apps code without reauth", async () => {
      mockRequestPopularitiesWithKwsRetry.mockResolvedValue({
        statusCode: 403,
        attempts: 1,
        data: {
          status: "error",
          error: {
            errors: [
              {
                messageCode: "NO_USER_OWNED_APPS_FOUND_CODE",
                message: "No user owned apps found",
              },
            ],
          },
        },
      });

      await expect(
        asoPopularityService.fetchKeywordPopularities(["z"])
      ).rejects.toThrow(
        "Primary App ID 1234567890 is not accessible for this Apple Ads account."
      );
      expect(asoAuthService.reAuthenticate).not.toHaveBeenCalled();
    });

    it("does not reauthenticate for text-only no-user-owned-apps 403", async () => {
      mockRequestPopularitiesWithKwsRetry.mockResolvedValue({
        statusCode: 403,
        attempts: 1,
        data: {
          status: "error",
          error: {
            errors: [
              {
                message: "No user owned apps found",
              },
            ],
          },
        },
      });

      await expect(
        asoPopularityService.fetchKeywordPopularities(["z"])
      ).rejects.toThrow(
        "Primary App ID 1234567890 is not accessible for this Apple Ads account."
      );
      expect(asoAuthService.reAuthenticate).not.toHaveBeenCalled();
      expect(mockRequestPopularitiesWithKwsRetry).toHaveBeenCalledTimes(1);
    });

    it("isolates failed keywords after terminal batch failure", async () => {
      mockRequestPopularitiesWithKwsRetry
        .mockResolvedValueOnce({
          statusCode: 500,
          attempts: 3,
          data: { status: "error" },
        })
        .mockResolvedValueOnce({
          statusCode: 200,
          attempts: 1,
          data: { status: "success", data: [{ name: "good", popularity: 25 }] },
        })
        .mockResolvedValueOnce({
          statusCode: 500,
          attempts: 3,
          data: { status: "error" },
        });

      const result = await asoPopularityService.fetchKeywordPopularitiesWithFailures([
        "good",
        "bad",
      ]);

      expect(result.popularities).toEqual({ good: 25 });
      expect(result.failedKeywords).toHaveLength(1);
      expect(result.failedKeywords[0]).toMatchObject({
        keyword: "bad",
        stage: "popularity",
      });
    });
  });
});
