import { ContextualError } from "../../utils/error-handling-helpers";
import { logger } from "../../utils/logger";
import { asoAuthService } from "../auth/aso-auth-service";
import { getSavedAsoAdamId } from "./aso-adam-id-service";
import {
  requestPopularitiesWithKwsRetry,
  type PopularityResponse,
} from "./aso-apple-popularity-client";
import { withAppleHttpTraceContext } from "./apple-http-trace";
import {
  normalizeAppleUpstreamError,
  type NormalizedAppleUpstreamError,
} from "./apple-upstream-error";
import { getAsoResilienceConfig } from "./aso-resilience";
import type { FailedKeyword } from "./aso-types";

const AUTH_REAUTH_REQUIRED_ERROR_CODE = "ASO_AUTH_REAUTH_REQUIRED";
const NO_USER_OWNED_APPS_FOUND_CODE = "NO_USER_OWNED_APPS_FOUND_CODE";
const KWS_NO_ORG_CONTENT_PROVIDERS = "KWS_NO_ORG_CONTENT_PROVIDERS";
const APPLE_POPULARITY_URL =
  "https://app-ads.apple.com/cm/api/v2/keywords/popularities";

type FetchKeywordPopularitiesOptions = {
  allowInteractiveAuthRecovery?: boolean;
};

type KeywordPopularityResult = {
  popularities: Record<string, number>;
  failedKeywords: FailedKeyword[];
};

export class AsoAuthReauthRequiredError extends ContextualError {
  readonly code = AUTH_REAUTH_REQUIRED_ERROR_CODE;

  constructor(message: string) {
    super(message);
    this.name = "AsoAuthReauthRequiredError";
  }
}

export function isAsoAuthReauthRequiredError(error: unknown): boolean {
  return (
    error instanceof AsoAuthReauthRequiredError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === AUTH_REAUTH_REQUIRED_ERROR_CODE)
  );
}

function sanitizeKeyword(keyword: string): string {
  return keyword.trim().toLowerCase();
}

function requireAdamId(): string {
  const adamId = getSavedAsoAdamId();
  if (!adamId) {
    throw new ContextualError(
      "Primary App ID is missing. Run 'aso --primary-app-id <id>' or run 'aso' to set it."
    );
  }
  return adamId;
}

function isRefreshError(statusCode: number, data: PopularityResponse): boolean {
  return statusCode === 403 && data.internalErrorCode === "REFRESH";
}

function firstMessageCode(data: PopularityResponse): string | undefined {
  return data.error?.errors?.[0]?.messageCode;
}

function firstMessage(data: PopularityResponse): string | undefined {
  return data.error?.errors?.[0]?.message;
}

function isPrimaryAppIdAccessMessageCode(messageCode: string): boolean {
  return messageCode === NO_USER_OWNED_APPS_FOUND_CODE;
}

function isPrimaryAppIdAccessError(
  statusCode: number,
  data: PopularityResponse
): boolean {
  if (statusCode !== 403) return false;
  const messageCode = firstMessageCode(data) || "";
  if (isPrimaryAppIdAccessMessageCode(messageCode)) {
    return true;
  }
  const message = (firstMessage(data) || "").toLowerCase();
  return message.includes("no user owned apps found");
}

function isKnownBusiness403(data: PopularityResponse): boolean {
  const messageCode = firstMessageCode(data) || "";
  if (
    messageCode.startsWith("KWS_") ||
    isPrimaryAppIdAccessMessageCode(messageCode)
  ) {
    return true;
  }
  const message = (firstMessage(data) || "").toLowerCase();
  return message.includes("no user owned apps found");
}

function isAuthFailure(statusCode: number, data: PopularityResponse): boolean {
  if (statusCode === 401) return true;
  if (isRefreshError(statusCode, data)) return true;
  if (statusCode !== 403) return false;
  return !isKnownBusiness403(data);
}

function logPopularityResponse(
  stage: string,
  statusCode: number,
  data: PopularityResponse
): void {
  logger.debug(
    `[aso-popularity] ${stage} response status=${statusCode} apiStatus=${
      data.status || "unknown"
    } requestID=${data.requestID || "none"} internalErrorCode=${
      data.internalErrorCode || "none"
    } messageCode=${firstMessageCode(data) || "none"} message=${
      firstMessage(data) || "none"
    } items=${data.data?.length || 0}`
  );
}

export class AsoPopularityService {
  async fetchKeywordPopularitiesWithFailures(
    keywords: string[],
    options?: FetchKeywordPopularitiesOptions
  ): Promise<KeywordPopularityResult> {
    if (keywords.length > 100) {
      throw new ContextualError(
        "A maximum of 100 keywords is supported per call"
      );
    }

    const sanitizedToOriginal = new Map<string, string>();
    for (const keyword of keywords) {
      const sanitized = sanitizeKeyword(keyword);
      if (sanitized) {
        sanitizedToOriginal.set(sanitized, keyword);
      }
    }

    const sanitizedKeywords = Array.from(sanitizedToOriginal.keys());
    if (sanitizedKeywords.length === 0) {
      return {
        popularities: {},
        failedKeywords: [],
      };
    }
    const adamId = requireAdamId();
    logger.debug(
      `[aso-popularity] requesting popularities terms=${sanitizedKeywords.length} adamId=${adamId}`
    );

    const allowInteractiveAuthRecovery =
      options?.allowInteractiveAuthRecovery !== false;
    let cookieHeader = asoAuthService.getCookieHeader(APPLE_POPULARITY_URL);
    if (!cookieHeader.trim()) {
      if (!allowInteractiveAuthRecovery) {
        throw new AsoAuthReauthRequiredError(
          "Apple Search Ads session expired. Reauthentication is required."
        );
      }
      logger.debug(
        "[aso-popularity] no cached cookie header, reauthenticating"
      );
      cookieHeader = await asoAuthService.reAuthenticate();
    }
    const requestWithAuthRecovery = async (
      terms: string[],
      stageLabel: string
    ): Promise<{ statusCode: number; data: PopularityResponse; attempts: number }> => {
      logger.debug(
        `[aso-popularity] sending ${stageLabel} request cookieHeaderLength=${cookieHeader.length} terms=${terms.length}`
      );
      let response = await requestPopularitiesWithKwsRetry(
        terms,
        cookieHeader,
        adamId
      );
      logPopularityResponse(stageLabel, response.statusCode, response.data);

      if (isAuthFailure(response.statusCode, response.data)) {
        if (!allowInteractiveAuthRecovery) {
          throw new AsoAuthReauthRequiredError(
            "Apple Search Ads session expired. Reauthentication is required."
          );
        }
        logger.debug(
          `[aso-popularity] ${stageLabel} auth failure detected, reauthenticating before retry`
        );
        cookieHeader = await asoAuthService.reAuthenticate();
        response = await requestPopularitiesWithKwsRetry(
          terms,
          cookieHeader,
          adamId
        );
        logPopularityResponse(
          `${stageLabel}-post-reauth`,
          response.statusCode,
          response.data
        );
      }

      return response;
    };

    const toFailedKeyword = (
      keyword: string,
      normalized: NormalizedAppleUpstreamError
    ): FailedKeyword => ({
      keyword,
      stage: "popularity",
      reasonCode: normalized.reasonCode,
      message: normalized.message,
      statusCode: normalized.statusCode,
      retryable: normalized.retryable,
      attempts: normalized.attempts,
      requestId: normalized.requestId,
    });

    const parseSuccessPopularities = (
      response: { statusCode: number; data: PopularityResponse }
    ): Record<string, number> => {
      const result: Record<string, number> = {};
      for (const item of response.data.data || []) {
        if (item.popularity === null) continue;
        const originalKeyword = sanitizedToOriginal.get(item.name);
        if (originalKeyword) {
          result[originalKeyword] = item.popularity;
        }
      }
      return result;
    };

    const toFailureFromResponse = (
      keyword: string,
      response: { statusCode: number; data: PopularityResponse; attempts: number }
    ): FailedKeyword => {
      const messageCode = firstMessageCode(response.data);
      const message = firstMessage(response.data);
      logger.debug(
        `[aso-popularity] final failure status=${response.statusCode} requestID=${
          response.data.requestID || "none"
        } messageCode=${messageCode || "none"}`
      );
      const normalized = normalizeAppleUpstreamError({
        error: Object.assign(
          new Error(
            message ||
              `Popularity API request failed with status ${response.statusCode}`
          ),
          {
            statusCode: response.statusCode,
            code: messageCode || response.data.internalErrorCode,
          }
        ),
        operation: "keywords-popularities-response",
        attempts: response.attempts,
        requestId: response.data.requestID,
      });
      return toFailedKeyword(keyword, normalized);
    };

    const toFailureFromError = (keyword: string, error: unknown): FailedKeyword => {
      const normalized = normalizeAppleUpstreamError({
        error,
        operation: "keywords-popularities-request",
        attempts: getAsoResilienceConfig().maxAttempts,
      });
      return toFailedKeyword(keyword, normalized);
    };

    let response = await requestWithAuthRecovery(sanitizedKeywords, "initial");

    if (response.statusCode !== 200 || response.data.status !== "success") {
      const messageCode = firstMessageCode(response.data);
      const message = firstMessage(response.data);
      if (isPrimaryAppIdAccessError(response.statusCode, response.data)) {
        throw withAppleHttpTraceContext(
          new ContextualError(
            `Primary App ID ${adamId} is not accessible for this Apple Ads account. Set a Primary App ID you can access with 'aso --primary-app-id <id>' and retry.${
              messageCode ? ` (messageCode=${messageCode})` : ""
            }`
          ),
          {
            provider: "apple-search-ads",
            operation: "keywords-popularities-response",
            context: {
              adamId,
              termsCount: sanitizedKeywords.length,
              statusCode: response.statusCode,
              requestID: response.data.requestID || null,
              messageCode: messageCode || null,
            },
          }
        );
      }
      if (response.statusCode === 403 && messageCode === KWS_NO_ORG_CONTENT_PROVIDERS) {
        logger.warn(
          `[aso-popularity] KWS_NO_ORG_CONTENT_PROVIDERS requestID=${
            response.data.requestID || "none"
          }; attempting keyword-level isolation`
        );
      }
      if (sanitizedKeywords.length === 1) {
        const keyword = sanitizedToOriginal.get(sanitizedKeywords[0]) ?? sanitizedKeywords[0];
        return {
          popularities: {},
          failedKeywords: [toFailureFromResponse(keyword, response)],
        };
      }

      const popularities: Record<string, number> = {};
      const failedKeywords: FailedKeyword[] = [];
      for (const term of sanitizedKeywords) {
        const keyword = sanitizedToOriginal.get(term) ?? term;
        try {
          const singleResponse = await requestWithAuthRecovery(
            [term],
            `isolation:${term}`
          );
          if (
            singleResponse.statusCode === 200 &&
            singleResponse.data.status === "success"
          ) {
            popularities[keyword] = parseSuccessPopularities(singleResponse)[keyword] ?? 1;
          } else {
            failedKeywords.push(toFailureFromResponse(keyword, singleResponse));
          }
        } catch (error) {
          failedKeywords.push(toFailureFromError(keyword, error));
        }
      }
      return {
        popularities,
        failedKeywords,
      };
    }

    return {
      popularities: parseSuccessPopularities(response),
      failedKeywords: [],
    };
  }

  async fetchKeywordPopularities(
    keywords: string[],
    options?: FetchKeywordPopularitiesOptions
  ): Promise<Record<string, number>> {
    const result = await this.fetchKeywordPopularitiesWithFailures(
      keywords,
      options
    );
    if (result.failedKeywords.length > 0) {
      const first = result.failedKeywords[0];
      throw new ContextualError(first.message);
    }
    return result.popularities;
  }
}

export function summarizeFailedPopularityKeywords(
  failures: FailedKeyword[]
): string | null {
  if (failures.length === 0) return null;
  const preview = failures
    .slice(0, 5)
    .map(
      (failure) =>
        `${failure.keyword}:${failure.reasonCode}${
          failure.statusCode != null ? `(${failure.statusCode})` : ""
        }`
    )
    .join(", ");
  const suffix = failures.length > 5 ? ` (+${failures.length - 5} more)` : "";
  return `${preview}${suffix}`;
}

export const asoPopularityService = new AsoPopularityService();
