import inquirer from "inquirer";
import type { Ora } from "ora";
import type {
  AsoInteractivePrompt,
  AsoInteractivePromptResponse,
} from "../../shared/aso-interactive-prompts";

export type AsoPromptHandler = {
  prompt: (
    prompt: AsoInteractivePrompt
  ) => Promise<AsoInteractivePromptResponse>;
};

function withSpinnerPause<T>(
  spinner: Ora | undefined,
  operation: () => Promise<T>
): Promise<T> {
  const wasSpinning = spinner?.isSpinning === true;
  if (wasSpinning) spinner.stop();
  return operation().finally(() => {
    if (wasSpinning) spinner?.start();
  });
}

export async function promptWithCliAsoPrompt(
  prompt: AsoInteractivePrompt,
  options?: { spinner?: Ora }
): Promise<AsoInteractivePromptResponse> {
  return withSpinnerPause(options?.spinner, async () => {
    switch (prompt.kind) {
      case "primary_app_id": {
        const { adamId } = await inquirer.prompt([
          {
            type: "input",
            name: "adamId",
            message: prompt.message,
            default: prompt.defaultValue ?? "",
            validate: (input: string) =>
              /^\d+$/.test(input.trim())
                ? true
                : "Please enter a numeric Primary App ID, e.g. 1234567890.",
          },
        ]);
        return {
          kind: "primary_app_id",
          adamId: String(adamId ?? "").trim(),
        };
      }
      case "apple_credentials": {
        const answers = await inquirer.prompt([
          {
            type: "input",
            name: "appleId",
            message: "Apple ID (email):",
            default: prompt.defaultAppleId ?? "",
            validate: (value: string) =>
              value.trim() ? true : "Apple ID is required",
          },
          {
            type: "password",
            name: "password",
            message: "Password:",
            mask: "*",
            validate: (value: string) =>
              value.trim() ? true : "Password is required",
          },
        ]);

        return {
          kind: "apple_credentials",
          appleId: String(answers.appleId ?? "").trim(),
          password: String(answers.password ?? ""),
        };
      }
      case "remember_credentials": {
        const { remember } = await inquirer.prompt([
          {
            type: "confirm",
            name: "remember",
            default: prompt.defaultValue,
            message: prompt.message,
          },
        ]);
        return {
          kind: "remember_credentials",
          remember: Boolean(remember),
        };
      }
      case "two_factor_method":
      case "trusted_phone": {
        const { value } = await inquirer.prompt([
          {
            type: "list",
            name: "value",
            message: prompt.message,
            choices: prompt.choices.map((choice) => ({
              name: choice.label,
              value: choice.value,
            })),
          },
        ]);
        return {
          kind: prompt.kind,
          value: String(value),
        };
      }
      case "verification_code": {
        const regex = new RegExp(`^\\d{${prompt.digits}}$`);
        const { code } = await inquirer.prompt([
          {
            type: "input",
            name: "code",
            message: prompt.message,
            validate: (value: string) =>
              regex.test(value.trim())
                ? true
                : `Please enter exactly ${prompt.digits} digits`,
          },
        ]);
        return {
          kind: "verification_code",
          code: String(code ?? "").trim(),
        };
      }
    }
  });
}
