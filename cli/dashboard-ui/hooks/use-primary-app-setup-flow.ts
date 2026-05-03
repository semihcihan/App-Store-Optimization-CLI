import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AsoInteractivePrompt,
  AsoInteractivePromptResponse,
} from "../../shared/aso-interactive-prompts";
import {
  apiGet,
  apiWrite,
  getDashboardApiErrorCode,
  isPrimaryAppIdReconfigureErrorCode,
  toActionableErrorMessage,
} from "../app-helpers";

type DashboardSetupStatus = "idle" | "in_progress" | "failed" | "succeeded";

type DashboardSetupStatusPayload = {
  status: DashboardSetupStatus;
  updatedAt: string | null;
  lastError: string | null;
  canPrompt: boolean;
  isRequired: boolean;
  pendingPrompt: AsoInteractivePrompt | null;
};

type StartSetupOptions = {
  forcePrompt?: boolean;
  initialError?: string;
};

function promptIdentity(prompt: AsoInteractivePrompt | null): string {
  if (!prompt) return "none";
  switch (prompt.kind) {
    case "primary_app_id":
      return `${prompt.kind}:${prompt.defaultValue ?? ""}:${prompt.placeholder ?? ""}:${
        prompt.errorMessage ?? ""
      }`;
    default:
      return prompt.kind;
  }
}

export function usePrimaryAppSetupFlow() {
  const [setupStatus, setSetupStatus] = useState<DashboardSetupStatus>("idle");
  const [setupStatusError, setSetupStatusError] = useState("");
  const [setupPendingPrompt, setSetupPendingPrompt] =
    useState<AsoInteractivePrompt | null>(null);
  const [isSetupRequired, setIsSetupRequired] = useState(false);
  const [isStartingSetup, setIsStartingSetup] = useState(false);
  const [isSubmittingSetupPromptRequest, setIsSubmittingSetupPromptRequest] =
    useState(false);
  const [isAwaitingSetupPromptAdvance, setIsAwaitingSetupPromptAdvance] =
    useState(false);
  const [submittedSetupPromptIdentity, setSubmittedSetupPromptIdentity] =
    useState<string | null>(null);
  const isSubmittingSetupPrompt =
    isSubmittingSetupPromptRequest || isAwaitingSetupPromptAdvance;

  const applySetupState = useCallback((data: DashboardSetupStatusPayload) => {
    setSetupStatus(data.status);
    setSetupPendingPrompt((current) =>
      data.pendingPrompt ?? (data.status === "in_progress" ? current : null)
    );
    setIsSetupRequired(Boolean(data.isRequired));
    if (data.status !== "in_progress") {
      setIsAwaitingSetupPromptAdvance(false);
      setSubmittedSetupPromptIdentity(null);
    } else if (data.pendingPrompt) {
      setIsAwaitingSetupPromptAdvance(false);
      setSubmittedSetupPromptIdentity(null);
    }
    if (data.status === "failed") {
      setSetupStatusError(data.lastError?.trim() || "Primary App ID setup failed.");
      return;
    }
    setSetupStatusError("");
  }, []);

  const startSetup = useCallback(async (options?: StartSetupOptions) => {
    const forcePrompt = options?.forcePrompt === true;
    const initialError = options?.initialError?.trim() ?? "";
    if (initialError) {
      setSetupStatusError(initialError);
    }
    try {
      setIsStartingSetup(true);
      const data = await apiWrite<DashboardSetupStatusPayload>(
        "POST",
        forcePrompt ? "/api/aso/setup/start?force=1" : "/api/aso/setup/start",
        {}
      );
      applySetupState(data);
      if (initialError) {
        setSetupStatusError(initialError);
      }
    } catch (error) {
      setSetupStatusError(
        toActionableErrorMessage(error, "Failed to start Primary App ID setup.")
      );
    } finally {
      setIsStartingSetup(false);
    }
  }, [applySetupState]);

  const submitSetupPromptResponse = useCallback(
    async (response: AsoInteractivePromptResponse) => {
      const currentPromptIdentity = promptIdentity(setupPendingPrompt);
      try {
        setIsSubmittingSetupPromptRequest(true);
        setIsAwaitingSetupPromptAdvance(false);
        setSubmittedSetupPromptIdentity(currentPromptIdentity);
        setSetupStatusError("");
        const data = await apiWrite<DashboardSetupStatusPayload>(
          "POST",
          "/api/aso/setup/respond",
          response
        );
        applySetupState(data);
        if (data.status === "in_progress" && data.pendingPrompt == null) {
          setIsAwaitingSetupPromptAdvance(true);
        } else {
          setIsAwaitingSetupPromptAdvance(false);
          setSubmittedSetupPromptIdentity(null);
        }
      } catch (error) {
        setIsAwaitingSetupPromptAdvance(false);
        setSubmittedSetupPromptIdentity(null);
        setSetupStatusError(
          toActionableErrorMessage(error, "Failed to submit Primary App ID.")
        );
      } finally {
        setIsSubmittingSetupPromptRequest(false);
      }
    },
    [applySetupState, setupPendingPrompt]
  );

  useEffect(() => {
    if (!isAwaitingSetupPromptAdvance) return;
    const currentPromptIdentity = promptIdentity(setupPendingPrompt);
    if (currentPromptIdentity === submittedSetupPromptIdentity) return;
    setIsAwaitingSetupPromptAdvance(false);
    setSubmittedSetupPromptIdentity(null);
  }, [
    isAwaitingSetupPromptAdvance,
    setupPendingPrompt,
    submittedSetupPromptIdentity,
  ]);

  const openSetupModalForPrimaryAppAccessError = useCallback(
    (error: unknown): boolean => {
      const errorCode = getDashboardApiErrorCode(error);
      if (!isPrimaryAppIdReconfigureErrorCode(errorCode)) return false;
      void startSetup({
        forcePrompt: true,
        initialError: toActionableErrorMessage(
          error,
          "Current Primary App ID is not accessible for this Apple Ads account."
        ),
      });
      return true;
    },
    [startSetup]
  );

  useEffect(() => {
    let isActive = true;
    const loadStatus = async () => {
      try {
        const data = await apiGet<DashboardSetupStatusPayload>(
          "/api/aso/setup/status"
        );
        if (!isActive) return;
        applySetupState(data);
      } catch {
        if (!isActive) return;
      }
    };

    void loadStatus();
    return () => {
      isActive = false;
    };
  }, [applySetupState]);

  useEffect(() => {
    if (!isSetupRequired) return;
    if (setupStatus !== "idle") return;
    if (isStartingSetup || isSubmittingSetupPrompt) return;
    void startSetup();
  }, [
    isSetupRequired,
    setupStatus,
    isStartingSetup,
    isSubmittingSetupPrompt,
    startSetup,
  ]);

  useEffect(() => {
    if (setupStatus !== "in_progress") return;
    let isActive = true;
    const pollStatus = async () => {
      try {
        const data = await apiGet<DashboardSetupStatusPayload>(
          "/api/aso/setup/status"
        );
        if (!isActive) return;
        applySetupState(data);
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
  }, [applySetupState, setupStatus]);

  const setupModalOpen = useMemo(
    () => isSetupRequired && (Boolean(setupPendingPrompt) || setupStatus === "failed"),
    [isSetupRequired, setupPendingPrompt, setupStatus]
  );

  return {
    setupStatus,
    setupStatusError,
    setupPendingPrompt,
    isSetupRequired,
    isStartingSetup,
    isSubmittingSetupPrompt,
    setupModalOpen,
    startSetup,
    submitSetupPromptResponse,
    openSetupModalForPrimaryAppAccessError,
  };
}
