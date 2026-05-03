export type AsoPromptChoice = {
  value: string;
  label: string;
};

export type AsoInteractivePrompt =
  | {
      kind: "primary_app_id";
      title: string;
      message: string;
      errorMessage?: string;
      defaultValue?: string;
      placeholder?: string;
    }
  | {
      kind: "apple_credentials";
      title: string;
      message: string;
      errorMessage?: string;
      defaultAppleId?: string;
    }
  | {
      kind: "remember_credentials";
      title: string;
      message: string;
      defaultValue: boolean;
    }
  | {
      kind: "two_factor_method";
      title: string;
      message: string;
      choices: AsoPromptChoice[];
    }
  | {
      kind: "trusted_phone";
      title: string;
      message: string;
      choices: AsoPromptChoice[];
    }
  | {
      kind: "verification_code";
      title: string;
      message: string;
      digits: number;
      errorMessage?: string;
    };

export type AsoInteractivePromptResponse =
  | {
      kind: "primary_app_id";
      adamId: string;
    }
  | {
      kind: "apple_credentials";
      appleId: string;
      password: string;
    }
  | {
      kind: "remember_credentials";
      remember: boolean;
    }
  | {
      kind: "two_factor_method";
      value: string;
    }
  | {
      kind: "trusted_phone";
      value: string;
    }
  | {
      kind: "verification_code";
      code: string;
    };
