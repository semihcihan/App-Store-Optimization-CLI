import type { FormEvent, MutableRefObject } from "react";
import { getIconUrl } from "../app-helpers";
import type { AddCandidate } from "../hooks/use-add-app-search";
import { Button, Input } from "../ui-react";

type AddAppDialogProps = {
  open: boolean;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
  searchTerm: string;
  onSearchTermChange: (value: string) => void;
  inputRef: MutableRefObject<HTMLInputElement | null>;
  candidates: AddCandidate[];
  selectedCandidates: Record<string, AddCandidate>;
  onToggleCandidateSelection: (candidate: AddCandidate) => void;
  selectedCount: number;
  isSearching: boolean;
  searchError: string;
  searchWarning: string;
  trimmedSearchTerm: string;
  isBusy: boolean;
  isColdStart: boolean;
  isOwnedAppId: (appId: string) => boolean;
};

export function AddAppDialog(props: AddAppDialogProps) {
  if (!props.open) return null;

  return (
    <div className="dialog-backdrop" onClick={props.onClose} role="presentation">
      <section
        className="dialog-card ui-card add-app-dialog-card"
        role="dialog"
        aria-modal="true"
        aria-label="Add app"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="dialog-header">
          <h2>Add Apps</h2>
          <button
            type="button"
            className="dialog-close"
            aria-label="Close"
            onClick={props.onClose}
          >
            ×
          </button>
        </header>
        <div className="dialog-content">
          <form className="add-app-popup-form" onSubmit={props.onSubmit}>
            <Input
              id="add-app-input"
              ref={props.inputRef}
              type="text"
              placeholder="Search apps, app IDs, or developer names."
              value={props.searchTerm}
              disabled={props.isBusy || props.isColdStart}
              onChange={(event) => props.onSearchTermChange(event.target.value)}
            />
            <div className="add-app-search-list" role="list" aria-label="App search results">
              {props.trimmedSearchTerm ? (
                props.candidates.map((candidate) => {
                  const isSelected = Boolean(props.selectedCandidates[candidate.key]);
                  const alreadyAdded =
                    candidate.type === "app" &&
                    typeof candidate.appId === "string" &&
                    props.isOwnedAppId(candidate.appId);
                  const iconUrl =
                    candidate.type === "app"
                      ? getIconUrl({
                          appId: candidate.appId ?? "",
                          name: candidate.label,
                          icon: candidate.icon,
                          iconArtwork: candidate.iconArtwork,
                        })
                      : null;
                  const secondaryLabel =
                    candidate.type === "app"
                      ? (candidate.appId ?? "")
                      : "Research workspace";
                  return (
                    <button
                      key={candidate.key}
                      type="button"
                      className={`add-app-search-item ${isSelected ? "selected" : ""}`}
                      aria-pressed={isSelected}
                      disabled={alreadyAdded || props.isBusy || props.isColdStart}
                      onClick={() => props.onToggleCandidateSelection(candidate)}
                    >
                      <span className="add-app-search-check" aria-hidden="true">
                        {isSelected ? "✓" : ""}
                      </span>
                      {candidate.type === "app" ? (
                        iconUrl ? (
                          <img
                            src={iconUrl}
                            alt=""
                            loading="lazy"
                            className="add-app-search-icon"
                          />
                        ) : (
                          <span className="add-app-search-icon-fallback">
                            {(candidate.label.charAt(0) || "?").toUpperCase()}
                          </span>
                        )
                      ) : (
                        <span className="add-app-search-research" aria-hidden="true">
                          ✦
                        </span>
                      )}
                      <span className="add-app-search-content">
                        <span className="add-app-search-title">{candidate.label}</span>
                        <span className="add-app-search-meta">
                          {alreadyAdded ? "Already added" : secondaryLabel}
                        </span>
                      </span>
                    </button>
                  );
                })
              ) : null}
              {props.trimmedSearchTerm && props.isSearching ? (
                <p className="dialog-message">Searching Apple...</p>
              ) : null}
              {props.trimmedSearchTerm && !props.isSearching && props.searchError ? (
                <p className="dialog-message error">{props.searchError}</p>
              ) : null}
              {props.trimmedSearchTerm &&
              !props.isSearching &&
              !props.searchError &&
              props.searchWarning ? (
                <p className="dialog-message">{props.searchWarning}</p>
              ) : null}
              {props.trimmedSearchTerm &&
              !props.isSearching &&
              !props.searchError &&
              !props.searchWarning &&
              props.candidates.length === 1 ? (
                <p className="dialog-message">
                  No app results found. You can still add this research name.
                </p>
              ) : null}
            </div>
            <div className="add-app-actions">
              {props.selectedCount > 0 ? (
                <p className="add-app-selection-summary">Selected: {props.selectedCount}</p>
              ) : props.trimmedSearchTerm ? (
                <p className="add-app-selection-summary">
                  Select one or more entries to add.
                </p>
              ) : null}
              <Button
                id="add-app-submit"
                type="submit"
                disabled={props.isBusy || props.isColdStart || props.selectedCount === 0}
              >
                {props.isBusy
                  ? "Adding..."
                  : `Add Selected (${props.selectedCount})`}
              </Button>
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}
