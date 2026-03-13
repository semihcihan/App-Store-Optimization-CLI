type StatusBannersProps = {
  showLoading: boolean;
  loadingText: string;
  showError: boolean;
  errorText: string;
  showSuccess: boolean;
  successText: string;
};

export function StatusBanners(props: StatusBannersProps) {
  return (
    <div className="status-slot" aria-live="polite">
      <p id="loading-text" className={`loading-text ${props.showLoading ? "visible" : ""}`}>
        {props.loadingText}
      </p>
      <p id="add-error" className={`error ${props.showError ? "visible" : ""}`}>
        {props.errorText}
      </p>
      <p id="add-success" className={`success ${props.showSuccess ? "visible" : ""}`}>
        {props.successText}
      </p>
    </div>
  );
}
