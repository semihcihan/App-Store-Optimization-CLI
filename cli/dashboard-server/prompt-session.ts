import type {
  AsoInteractivePrompt,
  AsoInteractivePromptResponse,
} from "../shared/aso-interactive-prompts";
import type { AsoPromptHandler } from "../services/prompts/aso-prompt-handler";

export type DashboardPromptSession = {
  createPromptHandler: () => AsoPromptHandler;
  getPendingPrompt: () => AsoInteractivePrompt | null;
  submitPromptResponse: (response: AsoInteractivePromptResponse) => boolean;
  failPendingPrompt: (error: unknown) => void;
  reset: () => void;
};

export function createDashboardPromptSession(): DashboardPromptSession {
  let pending:
    | {
        prompt: AsoInteractivePrompt;
        resolve: (response: AsoInteractivePromptResponse) => void;
        reject: (error: Error) => void;
      }
    | null = null;

  const clearPending = () => {
    pending = null;
  };

  return {
    createPromptHandler: () => ({
      prompt: (prompt) =>
        new Promise<AsoInteractivePromptResponse>((resolve, reject) => {
          if (pending) {
            reject(
              new Error("Another interactive prompt is already pending.")
            );
            return;
          }
          pending = {
            prompt,
            resolve,
            reject: (error) => reject(error),
          };
        }),
    }),
    getPendingPrompt: () => pending?.prompt ?? null,
    submitPromptResponse: (response) => {
      if (!pending) return false;
      const current = pending;
      clearPending();
      current.resolve(response);
      return true;
    },
    failPendingPrompt: (error) => {
      if (!pending) return;
      const current = pending;
      clearPending();
      current.reject(
        error instanceof Error
          ? error
          : new Error(String(error ?? "Interactive prompt failed."))
      );
    },
    reset: () => {
      clearPending();
    },
  };
}
