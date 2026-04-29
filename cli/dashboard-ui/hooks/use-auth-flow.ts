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

type AuthFlowContext =
  | { kind: "add-keywords"; keywords: string[] }
  | { kind: "startup-refresh" }
  | null;

type UseAuthFlowParams = {
  isAddingKeywords: boolean;
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

  const pendingAddContext = useMemo<PendingAddContext | null>(() => {
    if (authFlowContext?.kind !== "add-keywords") return null;
    return { keywords: authFlowContext.keywords };
  }, [authFlowContext]);

  const setPendingAddContext = useCallback((next: PendingAddContext | null) => {
    setAuthFlowContext((current) => {
      if (next) {
        return { kind: "add-keywords", keywords: next.keywords };
      }
      return current?.kind === "add-keywords" ? null : current;
    });
  }, []);

  const openAuthModalForPendingAdd = useCallback(
    (error: unknown, keywords: string[]): boolean => {
      const errorCode = getDashboardApiErrorCode(error);
      if (!isAuthFlowErrorCode(errorCode)) return false;
      setAuthFlowContext({ kind: "add-keywords", keywords });
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
    if (authStatus !== "idle" && authStatus !== "failed") return;
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
    if (!pendingAddContext) return;
    if (authStatus !== "idle") return;
    if (!authCanPrompt) return;
    if (isStartingAuth || isSubmittingAuthPrompt) return;
    void startReauthentication();
  }, [
    pendingAddContext,
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
    setAuthFlowContext((current) =>
      current?.kind === "startup-refresh" ? null : current
    );
  }, [authStatus]);

  const pendingAddKeywordCount = pendingAddContext?.keywords.length ?? 0;
  const authCheckLoadingText =
    pendingAddContext &&
    !authModalOpen &&
    !params.isAddingKeywords &&
    (isStartingAuth ||
      isSubmittingAuthPrompt ||
      authStatus === "idle" ||
      authStatus === "in_progress" ||
      authStatus === "succeeded")
      ? `Checking Apple session for ${pendingAddKeywordCount} keyword${pendingAddKeywordCount === 1 ? "" : "s"}...`
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
    requestStartupRefreshReauthentication,
    startReauthentication,
    submitAuthPromptResponse,
    authCheckLoadingText,
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
