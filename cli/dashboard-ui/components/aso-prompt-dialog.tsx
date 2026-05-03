import { useEffect, useMemo, useState } from "react";
import type {
  AsoInteractivePrompt,
  AsoInteractivePromptResponse,
} from "../../shared/aso-interactive-prompts";
import { Button, Input } from "../ui-react/primitives";

const STATUS_ERROR_VISIBILITY_MS = 4500;

type PromptAction = {
  label: string;
  disabled?: boolean;
  busyLabel?: string;
  onClick: () => void;
};

type AsoPromptDialogProps = {
  open: boolean;
  fallbackTitle: string;
  fallbackMessage: string;
  statusError: string;
  prompt: AsoInteractivePrompt | null;
  isSubmittingPrompt: boolean;
  onSubmitPrompt: (response: AsoInteractivePromptResponse) => void;
  actionButton?: PromptAction | null;
};

function defaultSubmitLabel(prompt: AsoInteractivePrompt): string {
  switch (prompt.kind) {
    case "primary_app_id":
      return "Save App ID";
    case "verification_code":
      return "Verify Code";
    default:
      return "Continue";
  }
}

function defaultBusyLabel(prompt: AsoInteractivePrompt): string {
  switch (prompt.kind) {
    case "primary_app_id":
      return "Saving...";
    case "apple_credentials":
      return "Signing In...";
    case "remember_credentials":
      return "Continuing...";
    case "two_factor_method":
      return "Continuing...";
    case "trusted_phone":
      return "Sending Code...";
    case "verification_code":
      return "Verifying...";
  }
}

export function AsoPromptDialog(props: AsoPromptDialogProps) {
  const [primaryAppId, setPrimaryAppId] = useState("");
  const [appleId, setAppleId] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [selectedValue, setSelectedValue] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [stickyStatusError, setStickyStatusError] = useState("");

  const promptResetKey = useMemo(() => {
    if (!props.prompt) return "none";
    switch (props.prompt.kind) {
      case "primary_app_id":
        return `${props.prompt.kind}:${props.prompt.defaultValue ?? ""}:${
          props.prompt.placeholder ?? ""
        }`;
      case "apple_credentials":
        return `${props.prompt.kind}:${props.prompt.defaultAppleId ?? ""}`;
      case "remember_credentials":
        return `${props.prompt.kind}:${props.prompt.defaultValue ? "1" : "0"}`;
      case "two_factor_method":
      case "trusted_phone":
        return `${props.prompt.kind}:${props.prompt.choices
          .map((choice) => `${choice.value}:${choice.label}`)
          .join("|")}`;
      case "verification_code":
        return `${props.prompt.kind}:${props.prompt.digits}:${props.prompt.message}`;
    }
  }, [props.prompt]);

  useEffect(() => {
    if (!props.prompt) return;
    switch (props.prompt.kind) {
      case "primary_app_id":
        setPrimaryAppId(props.prompt.defaultValue ?? "");
        break;
      case "apple_credentials":
        setAppleId(props.prompt.defaultAppleId ?? "");
        setPassword("");
        break;
      case "remember_credentials":
        setRemember(props.prompt.defaultValue);
        break;
      case "two_factor_method":
      case "trusted_phone":
        setSelectedValue(props.prompt.choices[0]?.value ?? "");
        break;
      case "verification_code":
        setVerificationCode("");
        break;
    }
  }, [promptResetKey]);

  useEffect(() => {
    const trimmedStatusError = props.statusError.trim();
    if (trimmedStatusError) {
      setStickyStatusError(trimmedStatusError);
      return;
    }
    if (!stickyStatusError) return;
    const timeoutId = window.setTimeout(() => {
      setStickyStatusError("");
    }, STATUS_ERROR_VISIBILITY_MS);
    return () => window.clearTimeout(timeoutId);
  }, [props.statusError, stickyStatusError]);

  useEffect(() => {
    if (props.open) return;
    setStickyStatusError("");
  }, [props.open]);

  const activePrompt = props.prompt;
  const promptError =
    activePrompt && "errorMessage" in activePrompt
      ? activePrompt.errorMessage?.trim() ?? ""
      : "";
  const displayError = promptError || stickyStatusError;
  const title = activePrompt?.title ?? props.fallbackTitle;
  const message = activePrompt?.message ?? props.fallbackMessage;
  const submitLabel = useMemo(
    () => (activePrompt ? defaultSubmitLabel(activePrompt) : ""),
    [activePrompt]
  );
  const submitBusyLabel = useMemo(
    () => (activePrompt ? defaultBusyLabel(activePrompt) : "Submitting..."),
    [activePrompt]
  );

  if (!props.open) return null;

  return (
    <div className="dialog-backdrop auth-dialog-backdrop" role="presentation">
      <section
        className="dialog-card ui-card auth-dialog-card"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="dialog-header">
          <h2>{title}</h2>
        </header>
        <div className="dialog-content auth-dialog-content">
          {message ? <p className="dialog-message">{message}</p> : null}
          {displayError ? <p className="dialog-message error">{displayError}</p> : null}

          {activePrompt ? (
            <form
              className="aso-prompt-form"
              autoComplete="on"
              onSubmit={(event) => {
                event.preventDefault();
                switch (activePrompt.kind) {
                  case "primary_app_id":
                    props.onSubmitPrompt({
                      kind: "primary_app_id",
                      adamId: primaryAppId.trim(),
                    });
                    return;
                  case "apple_credentials":
                    props.onSubmitPrompt({
                      kind: "apple_credentials",
                      appleId: appleId.trim(),
                      password,
                    });
                    return;
                  case "remember_credentials":
                    props.onSubmitPrompt({
                      kind: "remember_credentials",
                      remember,
                    });
                    return;
                  case "two_factor_method":
                  case "trusted_phone":
                    props.onSubmitPrompt({
                      kind: activePrompt.kind,
                      value: selectedValue,
                    });
                    return;
                  case "verification_code":
                    props.onSubmitPrompt({
                      kind: "verification_code",
                      code: verificationCode.trim(),
                    });
                    return;
                }
              }}
            >
              <fieldset
                className="aso-prompt-fieldset"
                disabled={props.isSubmittingPrompt}
              >
                {activePrompt.kind === "primary_app_id" ? (
                  <label className="aso-prompt-field">
                    <span>Primary App ID</span>
                    <Input
                      autoFocus
                      inputMode="numeric"
                      pattern="[0-9]*"
                      placeholder={activePrompt.placeholder ?? "1234567890"}
                      value={primaryAppId}
                      onChange={(event) => {
                        setPrimaryAppId(event.target.value);
                      }}
                    />
                  </label>
                ) : null}

                {activePrompt.kind === "apple_credentials" ? (
                  <>
                    <label className="aso-prompt-field">
                      <span>Apple ID</span>
                      <Input
                        autoFocus
                        type="email"
                        name="username"
                        autoComplete="username email"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        value={appleId}
                        onChange={(event) => {
                          setAppleId(event.target.value);
                        }}
                      />
                    </label>
                    <label className="aso-prompt-field">
                      <span>Password</span>
                      <Input
                        type="password"
                        name="current-password"
                        autoComplete="current-password"
                        value={password}
                        onChange={(event) => {
                          setPassword(event.target.value);
                        }}
                      />
                    </label>
                  </>
                ) : null}

                {activePrompt.kind === "remember_credentials" ? (
                  <label className="aso-prompt-checkbox">
                    <input
                      type="checkbox"
                      checked={remember}
                      onChange={(event) => {
                        setRemember(event.target.checked);
                      }}
                    />
                    <span>Save credentials in macOS Keychain</span>
                  </label>
                ) : null}

                {activePrompt.kind === "two_factor_method" ||
                activePrompt.kind === "trusted_phone" ? (
                  <div className="aso-prompt-choice-list" role="radiogroup">
                    {activePrompt.choices.map((choice) => (
                      <label key={choice.value} className="aso-prompt-choice">
                        <input
                          type="radio"
                          name={activePrompt.kind}
                          value={choice.value}
                          checked={selectedValue === choice.value}
                          onChange={(event) => {
                            setSelectedValue(event.target.value);
                          }}
                        />
                        <span>{choice.label}</span>
                      </label>
                    ))}
                  </div>
                ) : null}

                {activePrompt.kind === "verification_code" ? (
                  <label className="aso-prompt-field">
                    <span>Verification Code</span>
                    <Input
                      autoFocus
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={verificationCode}
                      onChange={(event) => {
                        setVerificationCode(event.target.value);
                      }}
                    />
                  </label>
                ) : null}
              </fieldset>

              <div className="auth-dialog-actions">
                <Button
                  type="submit"
                  className={`auth-action-button ${
                    props.isSubmittingPrompt ? "is-loading" : ""
                  }`}
                  disabled={props.isSubmittingPrompt}
                  aria-busy={props.isSubmittingPrompt}
                  aria-label={props.isSubmittingPrompt ? submitBusyLabel : submitLabel}
                >
                  <span
                    className={`auth-action-button-label ${
                      props.isSubmittingPrompt ? "is-hidden" : ""
                    }`}
                  >
                    {submitLabel}
                  </span>
                  <span
                    className={`auth-action-button-spinner ${
                      props.isSubmittingPrompt ? "visible" : ""
                    }`}
                    aria-hidden="true"
                  />
                </Button>
              </div>
            </form>
          ) : null}

          {!props.prompt && props.actionButton ? (
            <div className="auth-dialog-actions">
              <Button
                type="button"
                className="auth-action-button"
                onClick={props.actionButton.onClick}
                disabled={props.actionButton.disabled}
              >
                {props.actionButton.disabled && props.actionButton.busyLabel
                  ? props.actionButton.busyLabel
                  : props.actionButton.label}
              </Button>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
