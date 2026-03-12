/** @jest-environment jsdom */

import {
  APP_STORE_ICON_IMAGE_URL,
  DashboardApiError,
  apiGet,
  apiWrite,
  authFlowErrorMessage,
  buildAppStoreUrl,
  buildTopAppRows,
  copyTextToClipboard,
  formatCalendarDate,
  formatCount,
  formatDate,
  formatRatingValue,
  formatSignedNumber,
  getBrowserLocale,
  getChange,
  getDashboardApiErrorCode,
  getIconUrl,
  getNumberDelta,
  isAuthFlowErrorCode,
  roundTo,
  toActionableErrorMessage,
} from "./app-helpers";
import { notifyDashboardError } from "./bugsnag";

jest.mock("./bugsnag", () => ({
  notifyDashboardError: jest.fn(),
}));

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("app-helpers", () => {
  const mockNotifyDashboardError = jest.mocked(notifyDashboardError);
  const originalDateNow = Date.now;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    Date.now = originalDateNow;
    jest.restoreAllMocks();
  });

  it("classifies auth flow errors", () => {
    const authRequired = new DashboardApiError("auth", 401, "AUTH_REQUIRED");
    expect(getDashboardApiErrorCode(authRequired)).toBe("AUTH_REQUIRED");
    expect(getDashboardApiErrorCode(new Error("x"))).toBeNull();

    expect(isAuthFlowErrorCode("AUTH_REQUIRED")).toBe(true);
    expect(isAuthFlowErrorCode("AUTH_IN_PROGRESS")).toBe(true);
    expect(isAuthFlowErrorCode("TTY_REQUIRED")).toBe(true);
    expect(isAuthFlowErrorCode("NETWORK_ERROR")).toBe(false);

    expect(authFlowErrorMessage("AUTH_IN_PROGRESS")).toContain("already in progress");
    expect(authFlowErrorMessage("TTY_REQUIRED")).toContain("interactive terminal");
    expect(authFlowErrorMessage("AUTH_REQUIRED")).toContain("session expired");
  });

  it("maps actionable errors with explicit codes and status fallbacks", () => {
    expect(
      toActionableErrorMessage(
        new DashboardApiError("x", 400, "MISSING_APPLE_CREDENTIALS"),
        "fallback"
      )
    ).toContain("Run 'aso auth'");
    expect(
      toActionableErrorMessage(
        new DashboardApiError("x", 400, "RATE_LIMITED"),
        "fallback"
      )
    ).toContain("Rate limited");
    expect(
      toActionableErrorMessage(
        new DashboardApiError("x", 401),
        "fallback"
      )
    ).toContain("Authorization failed");
    expect(
      toActionableErrorMessage(
        new Error("Primary App ID 123 is not accessible"),
        "fallback"
      )
    ).toContain("Primary App ID");
    expect(
      toActionableErrorMessage(new Error("Unknown error"), "fallback")
    ).toBe("fallback");
  });

  it("handles API requests and reports failures", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as typeof fetch;
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { success: true, data: { ok: true } })
    );

    await expect(apiGet<{ ok: boolean }>("/ok")).resolves.toEqual({ ok: true });

    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, {
        success: false,
        error: "Unauthorized",
        errorCode: "AUTH_REQUIRED",
      })
    );
    await expect(apiWrite("POST", "/bad", {})).rejects.toMatchObject({
      name: "DashboardApiError",
      status: 401,
      errorCode: "AUTH_REQUIRED",
    });
    expect(mockNotifyDashboardError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        method: "POST",
        path: "/bad",
      })
    );
  });

  it("copies text via clipboard API and textarea fallback", async () => {
    const writeText = jest.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    await copyTextToClipboard("hello");
    expect(writeText).toHaveBeenCalledWith("hello");

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: jest.fn(() => true),
    });
    const execSpy = document.execCommand as jest.Mock;
    await copyTextToClipboard("fallback");
    expect(execSpy).toHaveBeenCalledWith("copy");

    execSpy.mockImplementation(() => false);
    await expect(copyTextToClipboard("blocked")).rejects.toThrow(
      "Copy action was blocked by the browser."
    );
  });

  it("resolves icon URLs and App Store URLs", () => {
    expect(APP_STORE_ICON_IMAGE_URL).toContain("appstore-icon");
    expect(
      getIconUrl({
        appId: "1",
        name: "n",
        icon: { template: "https://x/{w}x{h}.{f}" },
      })
    ).toBe("https://x/100x100.jpg");
    expect(
      getIconUrl({
        appId: "1",
        name: "n",
        icon: { template: "https://x/Placeholder.mill/{w}x{h}.{f}" },
      })
    ).toBe("https://x/Placeholder.mill/100x100.jpeg");
    expect(
      getIconUrl({
        appId: "1",
        name: "n",
        icon: { srcSet: [{ src: "https://x/{w}.{f}" }] },
      })
    ).toBe("https://x/100.jpg");
    expect(getIconUrl(undefined)).toBeNull();

    expect(buildAppStoreUrl(" 123 ", "US")).toContain("/us/app/id123");
    expect(buildAppStoreUrl("a b", "TR")).toContain("a%20b");
  });

  it("formats locale and metric helpers", () => {
    Object.defineProperty(navigator, "languages", {
      configurable: true,
      value: ["tr-TR"],
    });
    expect(getBrowserLocale()).toBe("tr-TR");

    Date.now = () => Date.parse("2026-03-12T12:00:00.000Z");
    expect(formatDate("2026-03-12T11:50:00.000Z", "en-US")).toContain("min ago");
    expect(formatDate("2026-03-12T09:00:00.000Z", "en-US")).toContain("hr ago");
    expect(formatDate("2026-03-10T12:00:00.000Z", "en-US")).toContain("d ago");
    expect(formatDate("bad-date", "en-US")).toBe("-");
    expect(formatDate(undefined, "en-US")).toBe("-");

    expect(formatCalendarDate("2026-03-10", "en-US")).not.toBe("");
    expect(formatCalendarDate("bad", "en-US")).toBe("");
    expect(formatCount(1200, "en-US")).toBe("1,200");
    expect(formatRatingValue(4.25, "en-US")).toBe("4.3");

    expect(getChange({
      keyword: "k",
      popularity: 1,
      difficultyScore: 1,
      appCount: 1,
      previousPosition: 10,
      currentPosition: 8,
    })).toBe(-2);
    expect(getNumberDelta(20, 10)).toBe(10);
    expect(getNumberDelta(null, 10)).toBeNull();
    expect(formatSignedNumber(5, "en-US")).toBe("+5");
    expect(formatSignedNumber(-5, "en-US")).toBe("-5");
    expect(roundTo(4.256, 2)).toBe(4.26);
  });

  it("builds top app rows with rank ordering", () => {
    const rows = buildTopAppRows({
      keyword: "term",
      appDocs: [
        { appId: "a1", name: "A1" },
        { appId: "a2", name: "A2" },
      ],
    });
    expect(rows).toEqual([
      { rank: 1, appId: "a1", name: "A1" },
      { rank: 2, appId: "a2", name: "A2" },
    ]);
  });
});
