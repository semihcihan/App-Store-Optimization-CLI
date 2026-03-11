import { fromError, isZodErrorLike } from "zod-validation-error";

export type ErrorResponse = {
  errors?: Array<{
    status?: string | number;
    code?: string;
    title?: string;
    detail?: string;
    source?: { pointer?: string };
  }>;
};

// Custom error class that preserves original error data and adds context
export class ContextualError extends Error {
  public readonly context?: any;

  constructor(message: string, context?: any) {
    super(message);
    this.stack = new Error(message).stack;

    // Add context
    this.context = context;

    // Ensure proper prototype chain
    Object.setPrototypeOf(this, ContextualError.prototype);
  }
}

// Recursively find ErrorResponse objects within any input
function findErrorResponse(error: any): ErrorResponse[] {
  const errorResponses: ErrorResponse[] = [];

  if (!error || typeof error !== "object") {
    return errorResponses;
  }

  // Check if current object is an ErrorResponse
  if (error.errors && Array.isArray(error.errors)) {
    errorResponses.push(error);
  }

  // Recursively search in all object properties
  for (const key in error) {
    if (error.hasOwnProperty(key)) {
      const value = error[key];

      if (Array.isArray(value)) {
        // Search in array elements
        value.forEach((item) => {
          errorResponses.push(...findErrorResponse(item));
        });
      } else if (value && typeof value === "object") {
        // Recursively search in nested objects
        errorResponses.push(...findErrorResponse(value));
      }
    }
  }

  return errorResponses;
}

// Helper function to check if an error is a 404 from the Apple API
export function isNotFoundError(error: any): boolean {
  const errorResponses = findErrorResponse(error);

  // Check for 404 status in found ErrorResponse objects
  for (const errorResponse of errorResponses) {
    if (errorResponse.errors && Array.isArray(errorResponse.errors)) {
      if (
        errorResponse.errors.some(
          (err: any) => err.status === "404" || err.status === 404
        )
      ) {
        return true;
      }
    }
  }

  // Fallback to other common error formats
  return (
    error?.status === 404 ||
    error?.status === "404" ||
    error?.response?.status === 404
  );
}

// Helper function to check if an error is a rate limit error
export function isRateLimitError(error: any): boolean {
  // Check for direct 429 status (both number and string)
  if (error?.status === 429 || error?.status === "429") {
    return true;
  }

  const errorResponses = findErrorResponse(error);

  // Check for 429 status in found ErrorResponse objects
  for (const errorResponse of errorResponses) {
    if (errorResponse.errors && Array.isArray(errorResponse.errors)) {
      if (
        errorResponse.errors.some(
          (err: any) => err.status === 429 || err.status === "429"
        )
      ) {
        return true;
      }
    }
  }

  return false;
}

// Helper function to check if an error is a 401 NOT_AUTHORIZED error
export function isNotAuthorizedError(error: any): boolean {
  // Check for direct 401 status (both number and string)
  if (error?.status === 401 || error?.status === "401") {
    return true;
  }

  const errorResponses = findErrorResponse(error);

  // Check for 401 status and NOT_AUTHORIZED code in found ErrorResponse objects
  for (const errorResponse of errorResponses) {
    if (errorResponse.errors && Array.isArray(errorResponse.errors)) {
      if (
        errorResponse.errors.some(
          (err: any) =>
            err.status === 401 ||
            err.status === "401" ||
            err.code === "NOT_AUTHORIZED"
        )
      ) {
        return true;
      }
    }
  }

  return false;
}

// Helper function to check if an error indicates that a version cannot be updated
export function isVersionNotUpdatableError(error: any): boolean {
  // Check for 409 status (Conflict) which often indicates invalid state
  if (error?.status === 409 || error?.status === "409") {
    return true;
  }

  const errorResponses = findErrorResponse(error);

  // Check for specific Apple API error codes that indicate version cannot be updated
  for (const errorResponse of errorResponses) {
    if (errorResponse.errors && Array.isArray(errorResponse.errors)) {
      if (
        errorResponse.errors.some((err: any) => {
          // Check for status 409
          if (err.status === 409 || err.status === "409") {
            return true;
          }

          // Check for specific error codes that indicate version cannot be updated
          if (err.code === "ENTITY_ERROR.ATTRIBUTE.INVALID.INVALID_STATE") {
            return true;
          }

          return false;
        })
      ) {
        return true;
      }
    }
  }

  return false;
}

const LOCALIZATION_UNMODIFIABLE_ERROR_CODE =
  "ENTITY_ERROR.ATTRIBUTE.INVALID.UNMODIFIABLE";

function isLocalizationEntityNotUpdatableError(
  error: any,
  entityName: string
): boolean {
  const serializedError = JSON.stringify(error);
  return (
    serializedError.includes(LOCALIZATION_UNMODIFIABLE_ERROR_CODE) &&
    serializedError.includes(`Cannot edit ${entityName}`)
  );
}

export function isInAppPurchaseLocalizationNotUpdatableError(error: any): boolean {
  return isLocalizationEntityNotUpdatableError(
    error,
    "InAppPurchaseLocalization"
  );
}

export function isSubscriptionGroupLocalizationNotUpdatableError(
  error: any
): boolean {
  return isLocalizationEntityNotUpdatableError(
    error,
    "SubscriptionGroupLocalization"
  );
}

export function isSubscriptionLocalizationNotUpdatableError(error: any): boolean {
  return isLocalizationEntityNotUpdatableError(error, "SubscriptionLocalization");
}

export function extractIncludedIndexFromApplePointer(
  pointer: unknown
): number | null {
  if (typeof pointer !== "string") return null;
  const match = pointer.match(/^\/included\/(\d+)\b/);
  if (!match) return null;
  return Number(match[1]);
}

export function extractTerritoryCodeFromAppleDetail(
  detail: unknown
): string | null {
  if (typeof detail !== "string") return null;
  const match = detail.match(/territory\s*=\s*([A-Z0-9]{3})\b/);
  return match?.[1] ?? null;
}

export type SubscriptionPricesBulkInvalidIncludedCorrection = {
  includedIndex: number;
  correctedDate: string;
};

export type SubscriptionPricesBulkErrorHandlingResult = {
  shouldRetry: boolean;
  invalidIncludedCorrections: SubscriptionPricesBulkInvalidIncludedCorrection[];
  territoriesToFix: string[];
};

export function extractCorrectedDateFromAppleDetail(detail: unknown): string | null {
  if (typeof detail !== "string") return null;
  const dateMatch = detail.match(/must be on or after (\d{4}-\d{2}-\d{2})/);
  return dateMatch?.[1] ?? null;
}

export function handleSubscriptionPricesBulkErrors(params: {
  error: ContextualError;
  includedTerritories?: string[];
}): SubscriptionPricesBulkErrorHandlingResult {
  const { error, includedTerritories } = params;

  const appleErrors = findErrorResponse(error.context).flatMap((resp) =>
    Array.isArray(resp.errors) ? resp.errors : []
  );
  const invalidIncludedCorrections = appleErrors
    .map((e) => {
      const correctedDate = extractCorrectedDateFromAppleDetail(e?.detail);
      if (!correctedDate) return null;
      const idx = extractIncludedIndexFromApplePointer(
        (e as any)?.source?.pointer
      );
      if (idx === null) return null;
      return { includedIndex: idx, correctedDate };
    })
    .filter(
      (v): v is SubscriptionPricesBulkInvalidIncludedCorrection => v !== null
    );

  const territoriesToFixSet = new Set<string>();

  for (const e of appleErrors) {
    if (typeof e?.detail !== "string") continue;
    if (!e.detail.includes("future prices")) continue;

    const territoryFromDetail = extractTerritoryCodeFromAppleDetail(e.detail);
    if (territoryFromDetail) {
      territoriesToFixSet.add(territoryFromDetail);
      continue;
    }

    const idx = extractIncludedIndexFromApplePointer(
      (e as any)?.source?.pointer
    );
    if (idx !== null && includedTerritories?.[idx]) {
      territoriesToFixSet.add(includedTerritories[idx]);
    }
  }

  const territoriesToFix = Array.from(territoriesToFixSet);

  return {
    shouldRetry:
      invalidIncludedCorrections.length > 0 || territoriesToFix.length > 0,
    invalidIncludedCorrections,
    territoriesToFix,
  };
}

export function extractClientErrorToSend(error: any): {
  message: string;
  status: number;
  details?: any;
} {
  // Zod validation errors → user-friendly message, treat as Bad Request
  try {
    if (isZodErrorLike && isZodErrorLike(error)) {
      const validationError = fromError(error);
      return {
        message: validationError.message,
        status: 400,
      };
    }
  } catch (_) {
    // noop: if zod utils throw for any reason, continue with other handlers
  }

  // ContextualError → include minimal Apple error info (title, detail)
  if (error instanceof ContextualError) {
    const errorResponses = findErrorResponse(error.context);
    let appleErrors = errorResponses.flatMap((resp) =>
      Array.isArray(resp.errors)
        ? resp.errors.map((e: any) => ({ title: e?.title, detail: e?.detail }))
        : []
    );
    let message = error.message;
    if (error.context instanceof Error) {
      let innerMessage = extractClientErrorToSend(error.context);
      message = message + `\n${innerMessage.message}`;
      appleErrors = appleErrors.concat(innerMessage.details || []);
    }

    let result = {
      message: message,
      status: 400,
    };
    if (appleErrors.length > 0) {
      return {
        ...result,
        details: appleErrors,
      };
    }
    return result;
  }

  // Primitive string errors
  if (typeof error === "string") {
    return { message: error, status: 400 };
  }

  // Generic Error
  if (error instanceof Error) {
    return { message: error.message, status: 400 };
  }

  // Fallback
  return { message: "Internal server error", status: 500 };
}
