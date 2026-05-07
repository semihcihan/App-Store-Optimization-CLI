export type DashboardErrorCode =
  | "INVALID_REQUEST"
  | "PAYLOAD_TOO_LARGE"
  | "MISSING_APPLE_CREDENTIALS"
  | "AUTH_REQUIRED"
  | "AUTH_IN_PROGRESS"
  | "TTY_REQUIRED"
  | "PRIMARY_APP_ID_RECONFIGURE_REQUIRED"
  | "AUTHORIZATION_FAILED"
  | "RATE_LIMITED"
  | "REQUEST_TIMEOUT"
  | "NETWORK_ERROR"
  | "NOT_FOUND"
  | "INTERNAL_ERROR";

export type DashboardUserSafeError = {
  errorCode: DashboardErrorCode;
  message: string;
};

type MapErrorOptions = {
  fallback: string;
  isAuthReauthRequiredError?: (error: unknown) => boolean;
};

export function mapToDashboardUserSafeError(
  error: unknown,
  options: MapErrorOptions
): DashboardUserSafeError {
  const rawMessage = error instanceof Error ? error.message : String(error ?? "");
  const lower = rawMessage.toLowerCase();

  if (lower.includes("apple credentials")) {
    return {
      errorCode: "MISSING_APPLE_CREDENTIALS",
      message: "Apple credentials are missing. Run 'aso auth' in a terminal and retry.",
    };
  }

  if (options.isAuthReauthRequiredError?.(error) === true) {
    return {
      errorCode: "AUTH_REQUIRED",
      message:
        "Apple Search Ads session expired. Reauthenticate from the dashboard and retry.",
    };
  }

  if (
    lower.includes("primary app id") ||
    lower.includes("no_user_owned_apps_found_code") ||
    lower.includes("no user owned apps found")
  ) {
    return {
      errorCode: "PRIMARY_APP_ID_RECONFIGURE_REQUIRED",
      message:
        "Current Primary App ID is not accessible for this Apple Ads account. Choose a different Primary App ID and retry.",
    };
  }

  if (lower.includes("unauthorized") || lower.includes("forbidden")) {
    return {
      errorCode: "AUTHORIZATION_FAILED",
      message: "Authorization failed. Verify your account access and retry.",
    };
  }

  if (lower.includes("too many requests") || lower.includes("rate limit")) {
    return {
      errorCode: "RATE_LIMITED",
      message: "Rate limited by upstream API. Wait a bit and retry.",
    };
  }

  if (
    lower.includes("request timed out") ||
    lower.includes("timed out") ||
    lower.includes("timeout")
  ) {
    return {
      errorCode: "REQUEST_TIMEOUT",
      message: "Request timed out. Retry in a moment.",
    };
  }

  if (
    lower.includes("failed to fetch") ||
    lower.includes("networkerror") ||
    lower.includes("network")
  ) {
    return {
      errorCode: "NETWORK_ERROR",
      message: "Network issue while reaching the backend. Check your connection and retry.",
    };
  }

  return {
    errorCode: "INTERNAL_ERROR",
    message: options.fallback,
  };
}

export function statusForDashboardErrorCode(errorCode: DashboardErrorCode): number {
  if (errorCode === "INVALID_REQUEST") return 400;
  if (errorCode === "PAYLOAD_TOO_LARGE") return 413;
  if (errorCode === "AUTH_REQUIRED") return 401;
  if (errorCode === "PRIMARY_APP_ID_RECONFIGURE_REQUIRED") return 403;
  if (errorCode === "AUTHORIZATION_FAILED") return 403;
  if (errorCode === "NOT_FOUND") return 404;
  if (errorCode === "AUTH_IN_PROGRESS") return 409;
  if (errorCode === "RATE_LIMITED") return 429;
  return 500;
}

export function isAuthFlowErrorCode(code: string | null): boolean {
  return (
    code === "AUTH_REQUIRED" ||
    code === "AUTH_IN_PROGRESS" ||
    code === "TTY_REQUIRED"
  );
}

export function isPrimaryAppIdReconfigureErrorCode(code: string | null): boolean {
  return code === "PRIMARY_APP_ID_RECONFIGURE_REQUIRED";
}

export function authFlowErrorMessage(code: string | null): string {
  if (code === "AUTH_IN_PROGRESS") {
    return "Reauthentication is already in progress. If prompted, complete it in terminal.";
  }
  if (code === "TTY_REQUIRED") {
    return "Reauthentication requires an interactive terminal. Start dashboard from a terminal and retry.";
  }
  return "Apple Search Ads session expired. Reauthenticate to continue.";
}

export function toDashboardActionableErrorMessage(
  error: unknown,
  fallbackMessage: string
): string {
  const rawMessage = error instanceof Error ? error.message : String(error ?? "");
  const message = rawMessage.trim();
  const lower = message.toLowerCase();
  const status =
    typeof (error as { status?: unknown })?.status === "number"
      ? ((error as { status: number }).status ?? null)
      : null;
  const errorCode =
    typeof (error as { errorCode?: unknown })?.errorCode === "string"
      ? ((error as { errorCode: string }).errorCode ?? null)
      : null;
  const isPrimaryAppIdAccessError =
    lower.includes("primary app id") ||
    lower.includes("no_user_owned_apps_found_code") ||
    lower.includes("no user owned apps found");

  if (errorCode === "MISSING_APPLE_CREDENTIALS") {
    return "Apple Search Ads authentication is missing or expired. Run 'aso auth' in a terminal, then retry.";
  }
  if (errorCode === "AUTH_REQUIRED") {
    return "Apple Search Ads session expired. Use Reauthenticate and retry.";
  }
  if (errorCode === "AUTH_IN_PROGRESS") {
    return "Reauthentication is in progress. If prompted, complete it in terminal, then retry.";
  }
  if (errorCode === "TTY_REQUIRED") {
    return "Reauthentication requires an interactive terminal. Start dashboard from terminal and retry.";
  }
  if (errorCode === "PRIMARY_APP_ID_RECONFIGURE_REQUIRED") {
    return (
      message ||
      "Current Primary App ID is not accessible for this Apple Ads account. Choose a different Primary App ID and retry."
    );
  }
  if (isPrimaryAppIdAccessError) {
    return message || "Primary App ID is not accessible for this Apple Ads account.";
  }
  if (errorCode === "AUTHORIZATION_FAILED") {
    return "Authorization failed. Verify your Apple account access and retry.";
  }
  if (errorCode === "RATE_LIMITED") {
    return "Rate limited by upstream API. Wait a bit and retry.";
  }
  if (errorCode === "REQUEST_TIMEOUT") {
    return "Request timed out. Retry in a moment.";
  }
  if (errorCode === "NETWORK_ERROR") {
    return "Network issue while reaching the backend. Check your connection and retry.";
  }
  if (
    status === 401 ||
    status === 403 ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden")
  ) {
    return "Authorization failed. Verify your Apple account access and retry.";
  }
  if (
    status === 429 ||
    lower.includes("too many requests") ||
    lower.includes("rate limit")
  ) {
    return "Rate limited by upstream API. Wait a bit and retry.";
  }
  if (
    lower.includes("request timed out") ||
    lower.includes("timed out") ||
    lower.includes("timeout")
  ) {
    return "Request timed out. Retry in a moment.";
  }
  if (lower.includes("failed to fetch") || lower.includes("networkerror")) {
    return "Network issue while reaching the backend. Check your connection and retry.";
  }

  return fallbackMessage;
}
