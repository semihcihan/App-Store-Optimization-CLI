import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { PackageUpdateNotice } from "./package-update-notice";
import { apiGet, copyTextToClipboard } from "../app-helpers";

jest.mock("../app-helpers", () => ({
  apiGet: jest.fn(),
  copyTextToClipboard: jest.fn(),
}));

const updateStatus = {
  currentVersion: "0.19.0",
  latestVersion: "0.20.0",
  updateAvailable: true,
  updateCommand: "npm install -g aso-cli@latest",
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(apiGet).mockResolvedValue(updateStatus);
  jest.mocked(copyTextToClipboard).mockResolvedValue(undefined);
});

afterEach(() => jest.useRealTimers());

it("opens instructions, copies the update command, and restores focus on Escape", async () => {
  render(<PackageUpdateNotice />);
  const trigger = await screen.findByRole("button", { name: "How to update" });
  expect(
    screen.getByText(/You’re running 0.19.0. Version 0.20.0/)
  ).toBeVisible();
  fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog");
  const close = screen.getByRole("button", {
    name: "Close update instructions",
  });
  const copy = screen.getByRole("button", { name: "Copy command" });
  expect(close).toHaveFocus();
  fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
  expect(copy).toHaveFocus();
  fireEvent.keyDown(copy, { key: "Tab" });
  expect(close).toHaveFocus();
  fireEvent.click(copy);
  expect(await screen.findByText("Copied!")).toBeVisible();
  expect(copyTextToClipboard).toHaveBeenCalledWith(updateStatus.updateCommand);
  expect(screen.getByText(/After installation finishes/)).toHaveTextContent(
    /Ctrl\+C.*aso/
  );
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  expect(trigger).toBeVisible();
});

it("provides manual copying guidance when the clipboard is blocked", async () => {
  jest.mocked(copyTextToClipboard).mockRejectedValue(new Error("blocked"));
  render(<PackageUpdateNotice />);
  fireEvent.click(await screen.findByRole("button", { name: "How to update" }));
  fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
  expect(await screen.findByText(/Couldn’t copy/)).toBeVisible();
  expect(screen.getByText(updateStatus.updateCommand)).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Close update instructions" })
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it.each([false, true])(
  "stays hidden when no update is known (offline: %s)",
  async (offline) => {
    if (offline) jest.mocked(apiGet).mockRejectedValue(new Error("offline"));
    else
      jest
        .mocked(apiGet)
        .mockResolvedValue({ ...updateStatus, updateAvailable: false });
    const { container } = render(<PackageUpdateNotice />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  }
);

it("rechecks while open and clears its interval on unmount", async () => {
  jest.useFakeTimers();
  jest
    .mocked(apiGet)
    .mockResolvedValueOnce({ ...updateStatus, updateAvailable: false });
  const { unmount } = render(<PackageUpdateNotice />);
  await act(async () => {});
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  await act(async () => jest.advanceTimersByTime(60 * 60 * 1000));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "How to update" })).toBeVisible()
  );
  expect(apiGet).toHaveBeenCalledWith("/api/dashboard/version");
  unmount();
  expect(jest.getTimerCount()).toBe(0);
});
