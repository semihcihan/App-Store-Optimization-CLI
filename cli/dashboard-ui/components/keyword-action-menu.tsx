import { createPortal } from "react-dom";

type KeywordActionMenuProps = {
  x: number;
  y: number;
  onForceRefresh: () => void;
  onCopy: () => void;
  onDelete: () => void;
};

export function KeywordActionMenu(props: KeywordActionMenuProps) {
  const menu = (
    <div
      className="keyword-action-menu"
      style={{ left: `${props.x}px`, top: `${props.y}px` }}
      role="menu"
      aria-label="Keyword actions"
    >
      <button
        type="button"
        className="keyword-action-item"
        role="menuitem"
        onClick={props.onForceRefresh}
      >
        Force Refresh
      </button>
      <button
        type="button"
        className="keyword-action-item"
        role="menuitem"
        onClick={props.onCopy}
      >
        Copy
      </button>
      <button
        type="button"
        className="keyword-action-item danger"
        role="menuitem"
        onClick={props.onDelete}
      >
        Delete
      </button>
    </div>
  );
  return createPortal(menu, document.body);
}
