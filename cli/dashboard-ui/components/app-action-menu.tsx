type AppActionMenuProps = {
  x: number;
  y: number;
  onDelete: () => void;
};

export function AppActionMenu(props: AppActionMenuProps) {
  return (
    <div
      className="keyword-action-menu app-action-menu"
      style={{ left: `${props.x}px`, top: `${props.y}px` }}
      role="menu"
      aria-label="App actions"
    >
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
