import { logger } from "../utils/logger";

export type DashboardAuthStatus = "idle" | "in_progress" | "failed" | "succeeded";

export type DashboardAuthState = {
  status: DashboardAuthStatus;
  updatedAt: string | null;
  lastError: string | null;
  requiresTerminalAction: boolean;
  canPrompt: boolean;
};

type CreateDashboardAuthStateParams = {
  reAuthenticate: (options?: { onUserActionRequired?: () => void }) => Promise<unknown>;
  onError: (error: unknown) => void;
};

function nowIsoString(): string {
  return new Date().toISOString();
}

function hasInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export function createDashboardAuthStateManager(
  params: CreateDashboardAuthStateParams
) {
  const state: Omit<DashboardAuthState, "canPrompt"> = {
    status: "idle",
    updatedAt: null,
    lastError: null,
    requiresTerminalAction: false,
  };

  let inFlight: Promise<void> | null = null;

  const setState = (
    status: DashboardAuthStatus,
    lastError: string | null = null
  ): void => {
    state.status = status;
    state.updatedAt = nowIsoString();
    state.lastError = lastError;
    state.requiresTerminalAction = false;
  };

  const markNeedsTerminalAction = (): void => {
    if (state.status !== "in_progress") return;
    state.requiresTerminalAction = true;
    state.updatedAt = nowIsoString();
  };

  return {
    getState(): DashboardAuthState {
      return {
        status: state.status,
        updatedAt: state.updatedAt,
        lastError: state.lastError,
        requiresTerminalAction: state.requiresTerminalAction,
        canPrompt: hasInteractiveTerminal(),
      };
    },

    isInProgress(): boolean {
      return inFlight != null;
    },

    canPrompt(): boolean {
      return hasInteractiveTerminal();
    },

    start(): boolean {
      if (inFlight) return false;

      setState("in_progress", null);
      inFlight = params
        .reAuthenticate({
          onUserActionRequired: () => {
            markNeedsTerminalAction();
          },
        })
        .then(() => {
          setState("succeeded", null);
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          setState("failed", message || "Authentication failed.");
          params.onError(error);
          logger.error(`ASO dashboard reauthentication failed: ${message}`);
        })
        .finally(() => {
          inFlight = null;
        });

      return true;
    },
  };
}
