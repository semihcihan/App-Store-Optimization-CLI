/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App";

type MockPayload = {
  status: number;
  body: unknown;
};

function jsonResponse(payload: MockPayload) {
  return {
    ok: payload.status >= 200 && payload.status < 300,
    status: payload.status,
    json: async () => payload.body,
  } as Response;
}

function setupMatchMediaMock(): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: jest.fn().mockImplementation(() => ({
      matches: false,
      media: "",
      onchange: null,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      addListener: jest.fn(),
      removeListener: jest.fn(),
      dispatchEvent: jest.fn(),
    })),
  });
}

describe("dashboard auth modal UI flow", () => {
  beforeEach(() => {
    setupMatchMediaMock();
    localStorage.clear();
  });

  it("auto-starts reauthentication after AUTH_REQUIRED without showing modal when no user input is needed", async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();

      if (method === "GET" && url === "/api/apps") {
        return jsonResponse({ status: 200, body: { success: true, data: [] } });
      }
      if (method === "GET" && url.startsWith("/api/aso/keywords?")) {
        return jsonResponse({ status: 200, body: { success: true, data: [] } });
      }
      if (method === "GET" && url === "/api/aso/refresh-status") {
        return jsonResponse({
          status: 200,
          body: {
            success: true,
            data: {
              status: "idle",
              startedAt: null,
              finishedAt: null,
              lastError: null,
              counters: {
                eligibleKeywordCount: 0,
                refreshedKeywordCount: 0,
                failedKeywordCount: 0,
                appListRefreshAttempted: false,
                appListRefreshSucceeded: false,
              },
            },
          },
        });
      }
      if (method === "POST" && url === "/api/aso/keywords") {
        return jsonResponse({
          status: 401,
          body: {
            success: false,
            errorCode: "AUTH_REQUIRED",
            error: "Auth required",
          },
        });
      }
      if (method === "POST" && url === "/api/aso/auth/start") {
        return jsonResponse({
          status: 202,
          body: {
            success: true,
            data: {
              status: "in_progress",
              updatedAt: "2026-03-07T00:00:00.000Z",
              lastError: null,
              requiresTerminalAction: false,
              canPrompt: true,
            },
          },
        });
      }
      if (method === "GET" && url === "/api/aso/auth/status") {
        return jsonResponse({
          status: 200,
          body: {
            success: true,
            data: {
              status: "in_progress",
              updatedAt: "2026-03-07T00:00:01.000Z",
              lastError: null,
              requiresTerminalAction: false,
              canPrompt: true,
            },
          },
        });
      }

      throw new Error(`Unhandled fetch: ${method} ${url}`);
    });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    const input = await screen.findByPlaceholderText("Add keywords (comma-separated)");
    fireEvent.change(input, { target: { value: "term" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Keywords" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/aso/auth/start",
        expect.objectContaining({
          method: "POST",
        })
      )
    );
    expect(
      screen.queryByRole("heading", { name: "Apple Reauthentication Required" })
    ).not.toBeInTheDocument();
  });

  it("auto-retries pending keyword add after auth status becomes succeeded", async () => {
    let keywordPostCount = 0;
    let authStatusCount = 0;
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();

      if (method === "GET" && url === "/api/apps") {
        return jsonResponse({ status: 200, body: { success: true, data: [] } });
      }
      if (method === "GET" && url.startsWith("/api/aso/keywords?")) {
        return jsonResponse({ status: 200, body: { success: true, data: [] } });
      }
      if (method === "GET" && url === "/api/aso/refresh-status") {
        return jsonResponse({
          status: 200,
          body: {
            success: true,
            data: {
              status: "idle",
              startedAt: null,
              finishedAt: null,
              lastError: null,
              counters: {
                eligibleKeywordCount: 0,
                refreshedKeywordCount: 0,
                failedKeywordCount: 0,
                appListRefreshAttempted: false,
                appListRefreshSucceeded: false,
              },
            },
          },
        });
      }
      if (method === "POST" && url === "/api/aso/keywords") {
        keywordPostCount += 1;
        if (keywordPostCount === 1) {
          return jsonResponse({
            status: 401,
            body: {
              success: false,
              errorCode: "AUTH_REQUIRED",
              error: "Auth required",
            },
          });
        }
        return jsonResponse({
          status: 201,
          body: {
            success: true,
            data: {
              cachedCount: 0,
              pendingCount: 1,
            },
          },
        });
      }
      if (method === "POST" && url === "/api/aso/auth/start") {
        return jsonResponse({
          status: 202,
          body: {
            success: true,
            data: {
              status: "in_progress",
              updatedAt: "2026-03-07T00:00:00.000Z",
              lastError: null,
              requiresTerminalAction: false,
              canPrompt: true,
            },
          },
        });
      }
      if (method === "GET" && url === "/api/aso/auth/status") {
        authStatusCount += 1;
        if (authStatusCount === 1) {
          return jsonResponse({
            status: 200,
            body: {
              success: true,
              data: {
                status: "succeeded",
                updatedAt: "2026-03-07T00:00:02.000Z",
                lastError: null,
                requiresTerminalAction: false,
                canPrompt: true,
              },
            },
          });
        }
        return jsonResponse({
          status: 200,
          body: {
            success: true,
            data: {
              status: "idle",
              updatedAt: "2026-03-07T00:00:03.000Z",
              lastError: null,
              requiresTerminalAction: false,
              canPrompt: true,
            },
          },
        });
      }

      throw new Error(`Unhandled fetch: ${method} ${url}`);
    });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    const input = await screen.findByPlaceholderText("Add keywords (comma-separated)");
    fireEvent.change(input, { target: { value: "term" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Keywords" }));

    await waitFor(() => expect(keywordPostCount).toBe(2));
  });

  it("shows modal only when reauthentication requires terminal input", async () => {
    let resolveAuthStart: (value: Response) => void = () => {};
    const authStartPromise = new Promise<Response>((resolve) => {
      resolveAuthStart = resolve;
    });

    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();

      if (method === "GET" && url === "/api/apps") {
        return jsonResponse({ status: 200, body: { success: true, data: [] } });
      }
      if (method === "GET" && url.startsWith("/api/aso/keywords?")) {
        return jsonResponse({ status: 200, body: { success: true, data: [] } });
      }
      if (method === "GET" && url === "/api/aso/refresh-status") {
        return jsonResponse({
          status: 200,
          body: {
            success: true,
            data: {
              status: "idle",
              startedAt: null,
              finishedAt: null,
              lastError: null,
              counters: {
                eligibleKeywordCount: 0,
                refreshedKeywordCount: 0,
                failedKeywordCount: 0,
                appListRefreshAttempted: false,
                appListRefreshSucceeded: false,
              },
            },
          },
        });
      }
      if (method === "POST" && url === "/api/aso/keywords") {
        return jsonResponse({
          status: 401,
          body: {
            success: false,
            errorCode: "AUTH_REQUIRED",
            error: "Auth required",
          },
        });
      }
      if (method === "POST" && url === "/api/aso/auth/start") {
        return authStartPromise;
      }
      if (method === "GET" && url === "/api/aso/auth/status") {
        return jsonResponse({
          status: 200,
          body: {
            success: true,
            data: {
              status: "in_progress",
              updatedAt: "2026-03-07T00:00:01.000Z",
              lastError: null,
              requiresTerminalAction: true,
              canPrompt: true,
            },
          },
        });
      }

      throw new Error(`Unhandled fetch: ${method} ${url}`);
    });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    const input = await screen.findByPlaceholderText("Add keywords (comma-separated)");
    fireEvent.change(input, { target: { value: "term" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Keywords" }));

    await screen.findByRole("heading", { name: "Apple Reauthentication Required" });
    expect(
      screen.getByText(
        "Complete reauthentication in the terminal that launched the dashboard."
      )
    ).toBeInTheDocument();

    resolveAuthStart(
      jsonResponse({
        status: 202,
        body: {
          success: true,
          data: {
            status: "in_progress",
            updatedAt: "2026-03-07T00:00:00.000Z",
            lastError: null,
            requiresTerminalAction: false,
            canPrompt: true,
          },
        },
      }) as Response
    );
  });

  it("shows primary app id access error message instead of generic authorization text", async () => {
    const primaryAppError =
      "Primary App ID 345345 is not accessible for this Apple Ads account. Set a Primary App ID you can access with 'aso --primary-app-id <id>' and retry. (messageCode=NO_USER_OWNED_APPS_FOUND_CODE)";

    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();

      if (method === "GET" && url === "/api/apps") {
        return jsonResponse({ status: 200, body: { success: true, data: [] } });
      }
      if (method === "GET" && url.startsWith("/api/aso/keywords?")) {
        return jsonResponse({ status: 200, body: { success: true, data: [] } });
      }
      if (method === "GET" && url === "/api/aso/refresh-status") {
        return jsonResponse({
          status: 200,
          body: {
            success: true,
            data: {
              status: "idle",
              startedAt: null,
              finishedAt: null,
              lastError: null,
              counters: {
                eligibleKeywordCount: 0,
                refreshedKeywordCount: 0,
                failedKeywordCount: 0,
                appListRefreshAttempted: false,
                appListRefreshSucceeded: false,
              },
            },
          },
        });
      }
      if (method === "POST" && url === "/api/aso/keywords") {
        return jsonResponse({
          status: 403,
          body: {
            success: false,
            errorCode: "AUTHORIZATION_FAILED",
            error: primaryAppError,
          },
        });
      }

      throw new Error(`Unhandled fetch: ${method} ${url}`);
    });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    const input = await screen.findByPlaceholderText("Add keywords (comma-separated)");
    fireEvent.change(input, { target: { value: "term" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Keywords" }));

    expect(await screen.findByText(primaryAppError)).toBeInTheDocument();
    expect(
      screen.queryByText(
        "Authorization failed. Verify your Apple account access and retry."
      )
    ).not.toBeInTheDocument();
  });
});
