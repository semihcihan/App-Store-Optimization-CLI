import { notifyBugsnagError } from "../../shared/telemetry/bugsnag-shared";
import { getErrorBugsnagMetadata } from "./bugsnag-metadata";
import { reportBugsnagError } from "./error-reporter";

jest.mock("../../shared/telemetry/bugsnag-shared", () => ({
  notifyBugsnagError: jest.fn(),
  initializeBugsnag: jest.fn(),
}));

jest.mock("./bugsnag-metadata", () => ({
  getErrorBugsnagMetadata: jest.fn(),
}));

describe("reportBugsnagError", () => {
  const mockNotifyBugsnagError = jest.mocked(notifyBugsnagError);
  const mockGetErrorBugsnagMetadata = jest.mocked(getErrorBugsnagMetadata);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("merges caller metadata with error metadata", () => {
    const error = new Error("boom");
    mockGetErrorBugsnagMetadata.mockReturnValue({
      requestId: "req-1",
      phase: "error",
    });

    reportBugsnagError(error, { phase: "caller", command: "aso keywords" });

    expect(mockNotifyBugsnagError).toHaveBeenCalledWith(error, {
      phase: "error",
      command: "aso keywords",
      requestId: "req-1",
    });
  });

  it("handles missing error metadata", () => {
    const error = new Error("boom");
    mockGetErrorBugsnagMetadata.mockReturnValue(undefined);

    reportBugsnagError(error, { command: "aso auth" });

    expect(mockNotifyBugsnagError).toHaveBeenCalledWith(error, {
      command: "aso auth",
    });
  });
});
