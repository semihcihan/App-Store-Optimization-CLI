import { useCallback, useEffect, useMemo, useState } from "react";
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
};

export type PendingAddContext = {
  keywords: string[];
};

type UseAuthFlowParams = {
  isAddingKeywords: boolean;
};

export function useAuthFlow(params: UseAuthFlowParams) {
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authStatus, setAuthStatus] = useState<DashboardAuthStatus>("idle");
  const [authCanPrompt, setAuthCanPrompt] = useState(true);
  const [authNeedsTerminalAction, setAuthNeedsTerminalAction] = useState(false);
  const [authStatusError, setAuthStatusError] = useState("");
  const [isStartingAuth, setIsStartingAuth] = useState(false);
  const [pendingAddContext, setPendingAddContext] = useState<PendingAddContext | null>(null);

  const startReauthentication = useCallback(async () => {
    try {
      setIsStartingAuth(true);
      setAuthStatus("in_progress");
      setAuthNeedsTerminalAction(false);
      setAuthStatusError("");
      const data = await apiWrite<DashboardAuthStatusPayload>("POST", "/api/aso/auth/start", {});
      setAuthStatus(data.status);
      setAuthCanPrompt(data.canPrompt);
      setAuthNeedsTerminalAction(Boolean(data.requiresTerminalAction));
    } catch (error) {
      const errorCode = getDashboardApiErrorCode(error);
      if (isAuthFlowErrorCode(errorCode)) {
        setAuthStatusError(authFlowErrorMessage(errorCode));
        if (errorCode === "AUTH_IN_PROGRESS") {
          setAuthStatus("in_progress");
          setAuthCanPrompt(true);
          setAuthNeedsTerminalAction(false);
        } else if (errorCode === "TTY_REQUIRED") {
          setAuthStatus("failed");
          setAuthCanPrompt(false);
          setAuthNeedsTerminalAction(true);
        }
        return;
      }
      setAuthStatus("failed");
      setAuthNeedsTerminalAction(false);
      setAuthStatusError(toActionableErrorMessage(error, "Failed to start reauthentication."));
    } finally {
      setIsStartingAuth(false);
    }
  }, []);

  const openAuthModalForPendingAdd = useCallback(
    (error: unknown, keywords: string[]): boolean => {
      const errorCode = getDashboardApiErrorCode(error);
      if (!isAuthFlowErrorCode(errorCode)) return false;
      setPendingAddContext({ keywords });
      if (errorCode === "AUTH_IN_PROGRESS") {
        setAuthStatus("in_progress");
        setAuthCanPrompt(true);
        setAuthNeedsTerminalAction(false);
        setAuthStatusError("");
      } else if (errorCode === "TTY_REQUIRED") {
        setAuthStatus("failed");
        setAuthCanPrompt(false);
        setAuthNeedsTerminalAction(true);
        setAuthStatusError(authFlowErrorMessage(errorCode));
      } else {
        setAuthStatus("idle");
        setAuthCanPrompt(true);
        setAuthNeedsTerminalAction(false);
        setAuthStatusError("");
      }
      return true;
    },
    []
  );

  useEffect(() => {
    if (!isStartingAuth && authStatus !== "in_progress") return;
    let isActive = true;
    const pollStatus = async () => {
      try {
        const data = await apiGet<DashboardAuthStatusPayload>("/api/aso/auth/status");
        if (!isActive) return;
        setAuthStatus(data.status);
        setAuthCanPrompt(data.canPrompt);
        setAuthNeedsTerminalAction(Boolean(data.requiresTerminalAction));
        if (data.status === "failed") {
          setAuthStatusError(data.lastError?.trim() || "Reauthentication failed.");
          return;
        }
        if (data.status === "succeeded") {
          setAuthStatusError("");
          return;
        }
      } catch {
        if (!isActive) return;
      }
    };

    void pollStatus();
    const timerId = window.setInterval(() => {
      void pollStatus();
    }, 1500);

    return () => {
      isActive = false;
      window.clearInterval(timerId);
    };
  }, [authStatus, isStartingAuth]);

  useEffect(() => {
    if (!pendingAddContext) return;
    if (authStatus !== "idle") return;
    if (!authCanPrompt) return;
    if (isStartingAuth) return;
    void startReauthentication();
  }, [
    pendingAddContext,
    authStatus,
    authCanPrompt,
    isStartingAuth,
    startReauthentication,
  ]);

  useEffect(() => {
    if (!pendingAddContext) {
      setAuthModalOpen(false);
      return;
    }
    if (!authCanPrompt) {
      setAuthModalOpen(true);
      return;
    }
    if (authStatus === "failed") {
      setAuthModalOpen(true);
      return;
    }
    if (authNeedsTerminalAction) {
      setAuthModalOpen(true);
      return;
    }
    setAuthModalOpen(false);
  }, [pendingAddContext, authCanPrompt, authStatus, authNeedsTerminalAction]);

  const pendingAddKeywordCount = pendingAddContext?.keywords.length ?? 0;
  const authCheckLoadingText =
    pendingAddContext &&
    !authModalOpen &&
    !params.isAddingKeywords &&
    (isStartingAuth ||
      authStatus === "idle" ||
      authStatus === "in_progress" ||
      authStatus === "succeeded")
      ? `Checking Apple session for ${pendingAddKeywordCount} keyword${pendingAddKeywordCount === 1 ? "" : "s"}...`
      : "";

  const authStatusLabel = useMemo(() => {
    if (!authCanPrompt) {
      return "Open dashboard from terminal to authenticate.";
    }
    if (authNeedsTerminalAction) {
      return "Complete reauthentication in the terminal that launched the dashboard.";
    }
    if (authStatus === "failed") {
      return "Reauthentication failed. Try again.";
    }
    return "";
  }, [authCanPrompt, authNeedsTerminalAction, authStatus]);

  return {
    authModalOpen,
    authStatus,
    authCanPrompt,
    authNeedsTerminalAction,
    authStatusError,
    isStartingAuth,
    pendingAddContext,
    setPendingAddContext,
    openAuthModalForPendingAdd,
    startReauthentication,
    authCheckLoadingText,
    authStatusLabel,
    canStartReauth: authCanPrompt && !isStartingAuth,
    showReauthButton: authStatus === "failed" && authCanPrompt,
  };
}
