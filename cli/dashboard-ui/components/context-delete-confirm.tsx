import { createPortal } from "react-dom";

type ContextDeleteConfirmProps = {
  x: number;
  y: number;
  title: string;
  message: string;
  onCancel: () => void;
  onConfirm: () => void;
};

export function ContextDeleteConfirm(props: ContextDeleteConfirmProps) {
  const dialog = (
    <div
      className="context-confirm-menu"
      style={{ left: `${props.x}px`, top: `${props.y}px` }}
      role="dialog"
      aria-label={props.title}
    >
      <p className="context-confirm-title">{props.title}</p>
      <p className="context-confirm-message">{props.message}</p>
      <div className="context-confirm-actions">
        <button
          type="button"
          className="keyword-action-item"
          onClick={props.onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="keyword-action-item danger"
          onClick={props.onConfirm}
        >
          Delete
        </button>
      </div>
    </div>
  );
  return createPortal(dialog, document.body);
}
