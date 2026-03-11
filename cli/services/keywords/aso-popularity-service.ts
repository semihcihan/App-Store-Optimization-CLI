import { ContextualError } from "../../utils/error-handling-helpers";
import { logger } from "../../utils/logger";
import { asoAuthService } from "../auth/aso-auth-service";
import { getSavedAsoAdamId } from "./aso-adam-id-service";
import {
  requestPopularitiesWithKwsRetry,
  type PopularityResponse,
} from "./aso-apple-popularity-client";
import { withAppleHttpTraceContext } from "./apple-http-trace";

const AUTH_REAUTH_REQUIRED_ERROR_CODE = "ASO_AUTH_REAUTH_REQUIRED";
const NO_USER_OWNED_APPS_FOUND_CODE = "NO_USER_OWNED_APPS_FOUND_CODE";
const KWS_NO_ORG_CONTENT_PROVIDERS = "KWS_NO_ORG_CONTENT_PROVIDERS";

type FetchKeywordPopularitiesOptions = {
  allowInteractiveAuthRecovery?: boolean;
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
  async fetchKeywordPopularities(
    keywords: string[],
    options?: FetchKeywordPopularitiesOptions
  ): Promise<Record<string, number>> {
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
      return {};
    }
    const adamId = requireAdamId();
    logger.debug(
      `[aso-popularity] requesting popularities terms=${sanitizedKeywords.length} adamId=${adamId}`
    );

    const allowInteractiveAuthRecovery =
      options?.allowInteractiveAuthRecovery !== false;
    let cookieHeader = asoAuthService.getCookieHeader();
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
      stageLabel: string
    ): Promise<{ statusCode: number; data: PopularityResponse }> => {
      logger.debug(
        `[aso-popularity] sending ${stageLabel} request cookieHeaderLength=${cookieHeader.length}`
      );
      let response = await requestPopularitiesWithKwsRetry(
        sanitizedKeywords,
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
          sanitizedKeywords,
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

    let response = await requestWithAuthRecovery("initial");

    if (response.statusCode !== 200 || response.data.status !== "success") {
      const messageCode = firstMessageCode(response.data);
      const message = firstMessage(response.data);
      logger.debug(
        `[aso-popularity] final failure status=${response.statusCode} requestID=${
          response.data.requestID || "none"
        } messageCode=${messageCode || "none"}`
      );
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
      if (
        response.statusCode === 403 &&
        messageCode === KWS_NO_ORG_CONTENT_PROVIDERS
      ) {
        logger.warn(
          `[aso-popularity] KWS_NO_ORG_CONTENT_PROVIDERS requestID=${
            response.data.requestID || "none"
          }; this can be transient due to Apple org/session context`
        );
        throw withAppleHttpTraceContext(
          new ContextualError(
            `Popularity API forbidden: ${messageCode}${message ? ` (${message})` : ""}`
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
      throw withAppleHttpTraceContext(
        new ContextualError(
          `Popularity API request failed with status ${response.statusCode}${
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

    const result: Record<string, number> = {};
    for (const item of response.data.data || []) {
      if (item.popularity === null) continue;
      const originalKeyword = sanitizedToOriginal.get(item.name);
      if (originalKeyword) {
        result[originalKeyword] = item.popularity;
      }
    }

    return result;
  }
}

export const asoPopularityService = new AsoPopularityService();
