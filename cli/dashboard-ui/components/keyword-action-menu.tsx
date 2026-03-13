type KeywordActionMenuProps = {
  x: number;
  y: number;
  onCopy: () => void;
  onDelete: () => void;
};

export function KeywordActionMenu(props: KeywordActionMenuProps) {
  return (
    <div
      className="keyword-action-menu"
      style={{ left: `${props.x}px`, top: `${props.y}px` }}
      role="menu"
      aria-label="Keyword actions"
    >
      <button type="button" className="keyword-action-item" role="menuitem" onClick={props.onCopy}>
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
}
