import type {
  AsoInteractivePrompt,
  AsoInteractivePromptResponse,
} from "../shared/aso-interactive-prompts";
import type { AsoPromptHandler } from "../services/prompts/aso-prompt-handler";
import { logger } from "../utils/logger";
import { createDashboardPromptSession } from "./prompt-session";

export type DashboardSetupStatus =
  | "idle"
  | "in_progress"
  | "failed"
  | "succeeded";

export type DashboardSetupState = {
  status: DashboardSetupStatus;
  updatedAt: string | null;
  lastError: string | null;
  canPrompt: boolean;
  isRequired: boolean;
  pendingPrompt: AsoInteractivePrompt | null;
};

type CreateDashboardSetupStateParams = {
  isSetupRequired: () => boolean;
  resolvePrimaryAppId: (options?: {
    forcePrompt?: boolean;
    promptHandler?: AsoPromptHandler;
  }) => Promise<string>;
  onResolved?: (adamId: string) => void;
  onError: (error: unknown) => void;
};

function nowIsoString(): string {
  return new Date().toISOString();
}

export function createDashboardSetupStateManager(
  params: CreateDashboardSetupStateParams
) {
  const promptSession = createDashboardPromptSession();
  const state: Omit<DashboardSetupState, "canPrompt" | "isRequired" | "pendingPrompt"> = {
    status: "idle",
    updatedAt: null,
    lastError: null,
  };

  let inFlight: Promise<void> | null = null;
  let forcePromptActive = false;

  const setState = (
    status: DashboardSetupStatus,
    lastError: string | null = null
  ) => {
    state.status = status;
    state.updatedAt = nowIsoString();
    state.lastError = lastError;
  };

  return {
    getState(): DashboardSetupState {
      return {
        status: state.status,
        updatedAt: state.updatedAt,
        lastError: state.lastError,
        canPrompt: true,
        isRequired:
          (params.isSetupRequired() || forcePromptActive) &&
          state.status !== "succeeded",
        pendingPrompt: promptSession.getPendingPrompt(),
      };
    },

    isInProgress(): boolean {
      return inFlight != null;
    },

    submitPromptResponse(response: AsoInteractivePromptResponse): boolean {
      if (state.status !== "in_progress") return false;
      const accepted = promptSession.submitPromptResponse(response);
      if (accepted) {
        state.updatedAt = nowIsoString();
      }
      return accepted;
    },

    start(options?: { forcePrompt?: boolean }): boolean {
      const requestedForcePrompt = options?.forcePrompt === true;
      const effectiveForcePrompt = requestedForcePrompt || forcePromptActive;
      if ((!params.isSetupRequired() && !effectiveForcePrompt) || inFlight) {
        return false;
      }

      forcePromptActive = effectiveForcePrompt;
      setState("in_progress", null);
      promptSession.reset();
      inFlight = params
        .resolvePrimaryAppId({
          forcePrompt: effectiveForcePrompt,
          promptHandler: promptSession.createPromptHandler(),
        })
        .then((adamId) => {
          promptSession.reset();
          forcePromptActive = false;
          setState("succeeded", null);
          params.onResolved?.(adamId);
        })
        .catch((error) => {
          promptSession.failPendingPrompt(error);
          const message = error instanceof Error ? error.message : String(error);
          setState("failed", message || "Primary App ID setup failed.");
          params.onError(error);
          logger.error(`ASO dashboard setup failed: ${message}`);
        })
        .finally(() => {
          inFlight = null;
        });

      return true;
    },
  };
}
