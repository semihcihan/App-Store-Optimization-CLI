import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PackageUpdateStatus } from "../../shared/package-update";
import { apiGet, copyTextToClipboard } from "../app-helpers";
import { Button } from "../ui-react";

const VERSION_POLL_INTERVAL_MS = 60 * 60 * 1000;

export function PackageUpdateNotice() {
  const [status, setStatus] = useState<PackageUpdateStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle"
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const nextStatus = await apiGet<PackageUpdateStatus>(
          "/api/dashboard/version"
        );
        if (active) setStatus(nextStatus);
      } catch {}
    };
    void check();
    const interval = window.setInterval(
      () => void check(),
      VERSION_POLL_INTERVAL_MS
    );
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    return () => triggerRef.current?.focus();
  }, [open]);

  if (!status?.updateAvailable) return null;

  const copyCommand = async () => {
    try {
      await copyTextToClipboard(status.updateCommand);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <>
      <section
        className="package-update-banner"
        aria-label="Package update available"
      >
        <div role="status">
          <strong>A newer version of ASO CLI is available</strong>
          <span>
            You’re running {status.currentVersion}. Version{" "}
            {status.latestVersion} is ready.
          </span>
        </div>
        <Button
          ref={triggerRef}
          type="button"
          className="package-update-action"
          onClick={() => {
            setCopyState("idle");
            setOpen(true);
          }}
        >
          How to update
        </Button>
      </section>
      {open
        ? createPortal(
            <div
              className="dialog-backdrop"
              role="presentation"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setOpen(false);
              }}
            >
              <section
                ref={dialogRef}
                className="dialog-card ui-card package-update-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="package-update-title"
                aria-describedby="package-update-instructions"
                onCopy={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setOpen(false);
                  }
                  if (event.key !== "Tab") return;
                  const controls =
                    dialogRef.current?.querySelectorAll<HTMLButtonElement>(
                      "button"
                    );
                  const first = controls?.[0];
                  const last = controls?.[controls.length - 1];
                  if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last?.focus();
                  } else if (
                    !event.shiftKey &&
                    document.activeElement === last
                  ) {
                    event.preventDefault();
                    first?.focus();
                  }
                }}
              >
                <header className="dialog-header">
                  <h2 id="package-update-title">
                    Update ASO CLI to {status.latestVersion}
                  </h2>
                  <button
                    ref={closeRef}
                    type="button"
                    className="dialog-close"
                    aria-label="Close update instructions"
                    onClick={() => setOpen(false)}
                  >
                    ×
                  </button>
                </header>
                <div
                  className="dialog-content package-update-content"
                  id="package-update-instructions"
                >
                  <p>
                    Run this command in a terminal on the computer running ASO
                    CLI:
                  </p>
                  <div className="package-update-command">
                    <code>{status.updateCommand}</code>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void copyCommand()}
                    >
                      {copyState === "copied" ? "Copied!" : "Copy command"}
                    </Button>
                  </div>
                  <p>
                    After installation finishes, stop the running ASO CLI with
                    Ctrl+C, then run <code>aso</code> again to open the updated
                    dashboard.
                  </p>
                  <p className="package-update-feedback" role="status">
                    {copyState === "failed"
                      ? "Couldn’t copy. Select the command above and copy it manually."
                      : copyState === "copied"
                        ? "Command copied to clipboard."
                        : ""}
                  </p>
                </div>
              </section>
            </div>,
            document.body
          )
        : null}
    </>
  );
}
