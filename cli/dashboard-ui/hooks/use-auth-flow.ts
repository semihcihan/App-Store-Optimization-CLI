import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AsoInteractivePrompt,
  AsoInteractivePromptResponse,
} from "../../shared/aso-interactive-prompts";
import {
  apiGet,
  apiWrite,
  authFlowErrorMessage,
  getDashboardApiErrorCode,
  isAuthFlowErrorCode,
  toActionableErrorMessage,
} from "../app-helpers";

export type DashboardAuthStatus = "idle" | "in_progress" | "failed" | "succeeded";

type DashboardAuthStatusPayload = {
  status: DashboardAuthStatus;
  updatedAt: string | null;
  lastError: string | null;
  requiresTerminalAction: boolean;
  canPrompt: boolean;
  pendingPrompt: AsoInteractivePrompt | null;
};

export type PendingAddContext = {
  keywords: string[];
};

export type PendingRetryFailedContext = {
  failedCount: number;
};

export type PendingForceRefreshContext = {
  keywordCount: number;
};

type AuthFlowContext =
  | { kind: "add-keywords" }
  | { kind: "retry-failed" }
  | { kind: "force-refresh" }
  | { kind: "startup-refresh" }
  | null;

type UseAuthFlowParams = {
  isAddingKeywords: boolean;
  isRetryingFailedKeywords: boolean;
  isForceRefreshingKeywords: boolean;
};

function promptIdentity(prompt: AsoInteractivePrompt | null): string {
  if (!prompt) return "none";
  switch (prompt.kind) {
    case "primary_app_id":
      return `${prompt.kind}:${prompt.defaultValue ?? ""}:${prompt.placeholder ?? ""}:${
        prompt.errorMessage ?? ""
      }`;
    case "apple_credentials":
      return `${prompt.kind}:${prompt.defaultAppleId ?? ""}:${prompt.errorMessage ?? ""}`;
    case "remember_credentials":
      return `${prompt.kind}:${prompt.defaultValue ? "1" : "0"}`;
    case "two_factor_method":
    case "trusted_phone":
      return `${prompt.kind}:${prompt.choices
        .map((choice) => `${choice.value}:${choice.label}`)
        .join("|")}`;
    case "verification_code":
      return `${prompt.kind}:${prompt.digits}:${prompt.message}:${prompt.errorMessage ?? ""}`;
  }
}

export function useAuthFlow(params: UseAuthFlowParams) {
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authStatus, setAuthStatus] = useState<DashboardAuthStatus>("idle");
  const [authCanPrompt, setAuthCanPrompt] = useState(true);
  const [authStatusError, setAuthStatusError] = useState("");
  const [isStartingAuth, setIsStartingAuth] = useState(false);
  const [isSubmittingAuthPromptRequest, setIsSubmittingAuthPromptRequest] = useState(false);
  const [isAwaitingAuthPromptAdvance, setIsAwaitingAuthPromptAdvance] = useState(false);
  const [submittedAuthPromptIdentity, setSubmittedAuthPromptIdentity] =
    useState<string | null>(null);
  const [authFlowContext, setAuthFlowContext] = useState<AuthFlowContext>(null);
  const [pendingAddContext, setPendingAddContextState] =
    useState<PendingAddContext | null>(null);
  const [pendingRetryFailedContext, setPendingRetryFailedContext] =
    useState<PendingRetryFailedContext | null>(null);
  const [pendingForceRefreshContext, setPendingForceRefreshContext] =
    useState<PendingForceRefreshContext | null>(null);
  const [authPendingPrompt, setAuthPendingPrompt] =
    useState<AsoInteractivePrompt | null>(null);
  const isSubmittingAuthPrompt =
    isSubmittingAuthPromptRequest || isAwaitingAuthPromptAdvance;

  const applyAuthState = useCallback((data: DashboardAuthStatusPayload) => {
    setAuthStatus(data.status);
    setAuthCanPrompt(data.canPrompt);
    setAuthPendingPrompt((current) =>
      data.pendingPrompt ?? (data.status === "in_progress" ? current : null)
    );
    if (data.status !== "in_progress") {
      setIsAwaitingAuthPromptAdvance(false);
      setSubmittedAuthPromptIdentity(null);
    } else if (data.pendingPrompt) {
      setIsAwaitingAuthPromptAdvance(false);
      setSubmittedAuthPromptIdentity(null);
    }
    if (data.status === "failed") {
      setAuthStatusError(data.lastError?.trim() || "Reauthentication failed.");
      return;
    }
    setAuthStatusError("");
  }, []);

  const startReauthentication = useCallback(async () => {
    try {
      setIsStartingAuth(true);
      setAuthStatus("in_progress");
      setAuthStatusError("");
      const data = await apiWrite<DashboardAuthStatusPayload>(
        "POST",
        "/api/aso/auth/start",
        {}
      );
      applyAuthState(data);
    } catch (error) {
      const errorCode = getDashboardApiErrorCode(error);
      if (isAuthFlowErrorCode(errorCode)) {
        setAuthStatusError(authFlowErrorMessage(errorCode));
        if (errorCode === "AUTH_IN_PROGRESS") {
          setAuthStatus("in_progress");
          return;
        }
        return;
      }
      setAuthStatus("failed");
      setAuthStatusError(
        toActionableErrorMessage(error, "Failed to start reauthentication.")
      );
    } finally {
      setIsStartingAuth(false);
    }
  }, [applyAuthState]);

  const submitAuthPromptResponse = useCallback(
    async (response: AsoInteractivePromptResponse) => {
      const currentPromptIdentity = promptIdentity(authPendingPrompt);
      try {
        setIsSubmittingAuthPromptRequest(true);
        setIsAwaitingAuthPromptAdvance(false);
        setSubmittedAuthPromptIdentity(currentPromptIdentity);
        setAuthStatusError("");
        const data = await apiWrite<DashboardAuthStatusPayload>(
          "POST",
          "/api/aso/auth/respond",
          response
        );
        applyAuthState(data);
        if (data.status === "in_progress" && data.pendingPrompt == null) {
          setIsAwaitingAuthPromptAdvance(true);
        } else {
          setIsAwaitingAuthPromptAdvance(false);
          setSubmittedAuthPromptIdentity(null);
        }
      } catch (error) {
        setIsAwaitingAuthPromptAdvance(false);
        setSubmittedAuthPromptIdentity(null);
        setAuthStatusError(
          toActionableErrorMessage(error, "Failed to submit authentication step.")
        );
      } finally {
        setIsSubmittingAuthPromptRequest(false);
      }
    },
    [applyAuthState, authPendingPrompt]
  );

  useEffect(() => {
    if (!isAwaitingAuthPromptAdvance) return;
    const currentPromptIdentity = promptIdentity(authPendingPrompt);
    if (currentPromptIdentity === submittedAuthPromptIdentity) return;
    setIsAwaitingAuthPromptAdvance(false);
    setSubmittedAuthPromptIdentity(null);
  }, [
    authPendingPrompt,
    isAwaitingAuthPromptAdvance,
    submittedAuthPromptIdentity,
  ]);

  const setPendingAddContext = useCallback((next: PendingAddContext | null) => {
    setPendingAddContextState(next);
  }, []);

  const openAuthModalForPendingAdd = useCallback(
    (error: unknown, keywords: string[]): boolean => {
      const errorCode = getDashboardApiErrorCode(error);
      if (!isAuthFlowErrorCode(errorCode)) return false;
      setAuthFlowContext({ kind: "add-keywords" });
      setPendingRetryFailedContext(null);
      setPendingForceRefreshContext(null);
      setPendingAddContextState({ keywords });
      if (errorCode === "AUTH_IN_PROGRESS") {
        setAuthStatus("in_progress");
        setAuthStatusError("");
      } else {
        setAuthStatus("idle");
        setAuthStatusError("");
      }
      return true;
    },
    []
  );

  const openAuthModalForRetryFailed = useCallback(
    (error: unknown, failedCount: number): boolean => {
      const errorCode = getDashboardApiErrorCode(error);
      if (!isAuthFlowErrorCode(errorCode)) return false;
      const normalizedFailedCount = Math.max(0, Math.floor(failedCount));
      setAuthFlowContext({ kind: "retry-failed" });
      setPendingAddContextState(null);
      setPendingForceRefreshContext(null);
      setPendingRetryFailedContext({ failedCount: normalizedFailedCount });
      if (errorCode === "AUTH_IN_PROGRESS") {
        setAuthStatus("in_progress");
        setAuthStatusError("");
      } else {
        setAuthStatus("idle");
        setAuthStatusError("");
      }
      return true;
    },
    []
  );

  const openAuthModalForForceRefresh = useCallback(
    (error: unknown, keywordCount: number): boolean => {
      const errorCode = getDashboardApiErrorCode(error);
      if (!isAuthFlowErrorCode(errorCode)) return false;
      setAuthFlowContext({ kind: "force-refresh" });
      setPendingAddContextState(null);
      setPendingRetryFailedContext(null);
      setPendingForceRefreshContext({
        keywordCount: Math.max(0, Math.floor(keywordCount)),
      });
      if (errorCode === "AUTH_IN_PROGRESS") {
        setAuthStatus("in_progress");
        setAuthStatusError("");
      } else {
        setAuthStatus("idle");
        setAuthStatusError("");
      }
      return true;
    },
    []
  );

  const requestStartupRefreshReauthentication = useCallback(() => {
    setAuthFlowContext((current) => current ?? { kind: "startup-refresh" });
    if (!authCanPrompt || isStartingAuth || isSubmittingAuthPrompt) return;
    if (authStatus === "in_progress") return;
    void startReauthentication();
  }, [
    authCanPrompt,
    authStatus,
    isStartingAuth,
    isSubmittingAuthPrompt,
    startReauthentication,
  ]);

  useEffect(() => {
    if (!isStartingAuth && authStatus !== "in_progress") return;
    let isActive = true;
    const pollStatus = async () => {
      try {
        const data = await apiGet<DashboardAuthStatusPayload>(
          "/api/aso/auth/status"
        );
        if (!isActive) return;
        applyAuthState(data);
      } catch {
        if (!isActive) return;
      }
    };

    void pollStatus();
    const timerId = window.setInterval(() => {
      void pollStatus();
    }, 500);

    return () => {
      isActive = false;
      window.clearInterval(timerId);
    };
  }, [applyAuthState, authStatus, isStartingAuth]);

  useEffect(() => {
    if (
      !pendingAddContext &&
      !pendingRetryFailedContext &&
      !pendingForceRefreshContext
    ) {
      return;
    }
    if (authStatus !== "idle") return;
    if (!authCanPrompt) return;
    if (isStartingAuth || isSubmittingAuthPrompt) return;
    void startReauthentication();
  }, [
    authFlowContext,
    pendingAddContext,
    pendingRetryFailedContext,
    pendingForceRefreshContext,
    authStatus,
    authCanPrompt,
    isStartingAuth,
    isSubmittingAuthPrompt,
    startReauthentication,
  ]);

  useEffect(() => {
    if (!authFlowContext) {
      setAuthModalOpen(false);
      return;
    }
    setAuthModalOpen(Boolean(authPendingPrompt) || authStatus === "failed");
  }, [authFlowContext, authPendingPrompt, authStatus]);

  useEffect(() => {
    if (authStatus !== "succeeded") return;
    setPendingAddContextState(null);
    setPendingRetryFailedContext(null);
    setPendingForceRefreshContext(null);
    setAuthFlowContext(null);
  }, [authStatus]);

  const pendingAddKeywordCount = pendingAddContext?.keywords.length ?? 0;
  const pendingRetryFailedCount = pendingRetryFailedContext?.failedCount ?? 0;
  const pendingForceRefreshCount = pendingForceRefreshContext?.keywordCount ?? 0;
  const isAuthHandoffLoading =
    isStartingAuth ||
    isSubmittingAuthPrompt ||
    authStatus === "idle" ||
    authStatus === "in_progress" ||
    authStatus === "succeeded";
  const isAddKeywordsAuthBusy = Boolean(
    pendingAddContext && !authModalOpen && isAuthHandoffLoading
  );
  const isRetryFailedAuthBusy = Boolean(
    pendingRetryFailedContext && !authModalOpen && isAuthHandoffLoading
  );
  const isForceRefreshAuthBusy = Boolean(
    pendingForceRefreshContext && !authModalOpen && isAuthHandoffLoading
  );
  const showAddAuthLoadingText =
    isAddKeywordsAuthBusy && !params.isAddingKeywords;
  const showRetryFailedAuthLoadingText =
    isRetryFailedAuthBusy && !params.isRetryingFailedKeywords;
  const showForceRefreshAuthLoadingText =
    isForceRefreshAuthBusy && !params.isForceRefreshingKeywords;
  const authCheckLoadingText =
    showAddAuthLoadingText
      ? `Checking Apple session for ${pendingAddKeywordCount} keyword${pendingAddKeywordCount === 1 ? "" : "s"}...`
      : showRetryFailedAuthLoadingText
        ? `Checking Apple session for ${pendingRetryFailedCount} failed keyword${pendingRetryFailedCount === 1 ? "" : "s"}...`
        : showForceRefreshAuthLoadingText
          ? `Checking Apple session for ${pendingForceRefreshCount} keyword${pendingForceRefreshCount === 1 ? "" : "s"}...`
          : "";

  const authStatusLabel = useMemo(() => {
    if (authStatus === "failed") {
      return "Reauthentication failed. Try again.";
    }
    return "";
  }, [authStatus]);

  return {
    authModalOpen,
    authStatus,
    authCanPrompt,
    authStatusError,
    isStartingAuth,
    isSubmittingAuthPrompt,
    authPendingPrompt,
    pendingAddContext,
    setPendingAddContext,
    openAuthModalForPendingAdd,
    openAuthModalForRetryFailed,
    openAuthModalForForceRefresh,
    requestStartupRefreshReauthentication,
    startReauthentication,
    submitAuthPromptResponse,
    authCheckLoadingText,
    isAddKeywordsAuthBusy,
    isRetryFailedAuthBusy,
    isForceRefreshAuthBusy,
    authStatusLabel,
    activeAuthContext: authFlowContext?.kind ?? null,
    canStartReauth:
      authCanPrompt &&
      !isStartingAuth &&
      !isSubmittingAuthPrompt &&
      authStatus !== "in_progress",
    showReauthButton: authStatus === "failed" && authCanPrompt,
  };
}
