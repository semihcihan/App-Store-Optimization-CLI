import { useEffect, useRef, useState } from "react";
import {
  apiWrite,
  DEFAULT_ASO_COUNTRY,
  toActionableErrorMessage,
} from "../app-helpers";
import { Button } from "../ui-react";

export type KeywordNotesTarget = {
  appId: string;
  appName: string;
  keyword: string;
  notes: string;
};

type KeywordNotesDialogProps = {
  target: KeywordNotesTarget;
  onClose: () => void;
  onSaved: (notes: string) => void;
};

export function KeywordNotesDialog({
  target,
  onClose,
  onSaved,
}: KeywordNotesDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [notes, setNotes] = useState(target.notes);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const trigger = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.showModal();
    textareaRef.current?.focus();
    textareaRef.current?.setSelectionRange(0, 0);
    return () => {
      dialog?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);

  const save = async () => {
    if (isSaving || notes === target.notes) return;
    setIsSaving(true);
    setError("");
    try {
      await apiWrite("PATCH", "/api/aso/keywords/notes", {
        appId: target.appId,
        country: DEFAULT_ASO_COUNTRY,
        keyword: target.keyword,
        notes,
      });
      onSaved(notes);
    } catch (error) {
      setError(toActionableErrorMessage(error, "Failed to save notes"));
      setIsSaving(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="dialog-card ui-card keyword-notes-dialog-card"
      aria-labelledby="keyword-notes-title"
      aria-describedby="keyword-notes-context"
      onCancel={(event) => {
        event.preventDefault();
        if (!isSaving) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !isSaving) onClose();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          void save();
        }
      }}
    >
      <header className="dialog-header">
        <h2 id="keyword-notes-title">Keyword notes</h2>
        <button
          type="button"
          className="dialog-close"
          aria-label="Close notes"
          disabled={isSaving}
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <form
        className="dialog-content keyword-notes-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p id="keyword-notes-context" className="keyword-notes-context">
          <strong>{target.keyword}</strong>
          <span>{target.appName}</span>
        </p>
        <label htmlFor="keyword-notes-input">Notes</label>
        <textarea
          id="keyword-notes-input"
          ref={textareaRef}
          className="ui-input keyword-notes-input"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Write your notes about this keyword…"
          readOnly={isSaving}
          rows={12}
        />
        {error ? (
          <p className="dialog-message error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="keyword-notes-actions">
          <Button
            type="button"
            variant="outline"
            disabled={isSaving}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={isSaving || notes === target.notes}>
            {isSaving ? "Saving…" : "Save notes"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
