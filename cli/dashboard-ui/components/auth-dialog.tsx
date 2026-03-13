import { Button } from "../ui-react";

type AuthDialogProps = {
  open: boolean;
  statusLabel: string;
  statusError: string;
  showReauthButton: boolean;
  canStartReauth: boolean;
  isStartingAuth: boolean;
  onStartReauthentication: () => void;
};

export function AuthDialog(props: AuthDialogProps) {
  if (!props.open) return null;

  return (
    <div className="dialog-backdrop auth-dialog-backdrop" role="presentation">
      <section
        className="dialog-card ui-card auth-dialog-card"
        role="dialog"
        aria-modal="true"
        aria-label="Apple reauthentication required"
      >
        <header className="dialog-header">
          <h2>Apple Reauthentication Required</h2>
        </header>
        <div className="dialog-content auth-dialog-content">
          {props.statusLabel ? <p className="dialog-message">{props.statusLabel}</p> : null}
          {props.statusError ? <p className="dialog-message error">{props.statusError}</p> : null}
          <div className="auth-dialog-actions">
            {props.showReauthButton ? (
              <Button
                type="button"
                className="auth-action-button"
                onClick={props.onStartReauthentication}
                disabled={!props.canStartReauth}
              >
                {props.isStartingAuth ? "Starting..." : "Reauthenticate"}
              </Button>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
