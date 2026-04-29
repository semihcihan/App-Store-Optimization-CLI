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

function emptyKeywordPagedPayload() {
  return {
    items: [],
    page: 1,
    pageSize: 100,
    totalCount: 0,
    totalPages: 1,
    hasPrevPage: false,
    hasNextPage: false,
    associatedCount: 0,
    failedCount: 0,
    pendingCount: 0,
  };
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
        return jsonResponse({
          status: 200,
          body: { success: true, data: emptyKeywordPagedPayload() },
        });
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

    expect(
      await screen.findByText("Checking Apple session for 1 keyword...")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Keywords" })).toBeDisabled();

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
        return jsonResponse({
          status: 200,
          body: { success: true, data: emptyKeywordPagedPayload() },
        });
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

  it("collects a missing Primary App ID through the dashboard setup flow", async () => {
    let submittedBody: string | null = null;
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();

      if (method === "GET" && url === "/api/apps") {
        return jsonResponse({ status: 200, body: { success: true, data: [] } });
      }
      if (method === "GET" && url.startsWith("/api/aso/keywords?")) {
        return jsonResponse({
          status: 200,
          body: { success: true, data: emptyKeywordPagedPayload() },
        });
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
              },
            },
          },
        });
      }
      if (method === "GET" && url === "/api/aso/setup/status") {
        return jsonResponse({
          status: 200,
          body: {
            success: true,
            data: {
              status: "in_progress",
              updatedAt: "2026-04-29T08:00:00.000Z",
              lastError: null,
              canPrompt: true,
              isRequired: true,
              pendingPrompt: {
                kind: "primary_app_id",
                title: "Primary App ID Required",
                message:
                  "Enter a Primary App ID that your Apple Search Ads account can access.",
                placeholder: "1234567890",
              },
            },
          },
        });
      }
      if (method === "POST" && url === "/api/aso/setup/respond") {
        submittedBody = String(init?.body ?? "");
        return jsonResponse({
          status: 202,
          body: {
            success: true,
            data: {
              status: "succeeded",
              updatedAt: "2026-04-29T08:00:05.000Z",
              lastError: null,
              canPrompt: true,
              isRequired: false,
              pendingPrompt: null,
            },
          },
        });
      }

      throw new Error(`Unhandled fetch: ${method} ${url}`);
    });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    await screen.findByRole("heading", { name: "Primary App ID Required" });
    fireEvent.change(screen.getByPlaceholderText("1234567890"), {
      target: { value: "1234567890" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save App ID" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/aso/setup/respond",
        expect.objectContaining({
          method: "POST",
        })
      )
    );
    expect(JSON.parse(submittedBody ?? "{}")).toEqual({
      kind: "primary_app_id",
      adamId: "1234567890",
    });
  });

  it("shows browser auth prompts when reauthentication needs user input", async () => {
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
        return jsonResponse({
          status: 200,
          body: { success: true, data: emptyKeywordPagedPayload() },
        });
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
              requiresTerminalAction: false,
              canPrompt: true,
              pendingPrompt: {
                kind: "apple_credentials",
                title: "Apple Sign In",
                message: "Enter your Apple ID and password to continue.",
              },
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

    await screen.findByRole("heading", { name: "Apple Sign In" });
    expect(
      screen.getByText("Enter your Apple ID and password to continue.")
    ).toBeInTheDocument();
    expect(screen.getByText("Apple ID")).toBeInTheDocument();
    expect(screen.getByText("Password")).toBeInTheDocument();

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

  it("keeps auth prompt submit errors visible while status polling continues", async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();

      if (method === "GET" && url === "/api/apps") {
        return jsonResponse({ status: 200, body: { success: true, data: [] } });
      }
      if (method === "GET" && url.startsWith("/api/aso/keywords?")) {
        return jsonResponse({
          status: 200,
          body: { success: true, data: emptyKeywordPagedPayload() },
        });
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
              pendingPrompt: {
                kind: "apple_credentials",
                title: "Apple Sign In",
                message: "Enter your Apple ID and password to continue.",
              },
            },
          },
        });
      }
      if (method === "POST" && url === "/api/aso/auth/respond") {
        return jsonResponse({
          status: 400,
          body: {
            success: false,
            errorCode: "INVALID_PROMPT_RESPONSE",
            error: "Password rejected.",
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

    await screen.findByRole("heading", { name: "Apple Sign In" });
    fireEvent.change(screen.getByLabelText("Apple ID"), {
      target: { value: "user@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "wrong-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      await screen.findByText("Failed to submit authentication step.")
    ).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(
      screen.getByText("Failed to submit authentication step.")
    ).toBeInTheDocument();
  });

  it("shows a loading label while submitting a verification code", async () => {
    let resolvePromptSubmit: ((value: Response) => void) | null = null;
    const promptSubmitPromise = new Promise<Response>((resolve) => {
      resolvePromptSubmit = resolve;
    });

    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();

      if (method === "GET" && url === "/api/apps") {
        return jsonResponse({ status: 200, body: { success: true, data: [] } });
      }
      if (method === "GET" && url.startsWith("/api/aso/keywords?")) {
        return jsonResponse({
          status: 200,
          body: { success: true, data: emptyKeywordPagedPayload() },
        });
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
              pendingPrompt: {
                kind: "verification_code",
                title: "Verification Code Required",
                message: "Enter the 6-digit code.",
                digits: 6,
              },
            },
          },
        });
      }
      if (method === "POST" && url === "/api/aso/auth/respond") {
        return promptSubmitPromise;
      }

      throw new Error(`Unhandled fetch: ${method} ${url}`);
    });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    const input = await screen.findByPlaceholderText("Add keywords (comma-separated)");
    fireEvent.change(input, { target: { value: "term" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Keywords" }));

    await screen.findByRole("heading", { name: "Verification Code Required" });
    fireEvent.change(screen.getByLabelText("Verification Code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify Code" }));

    expect(await screen.findByRole("button", { name: "Verifying..." })).toBeDisabled();

    const releasePromptSubmit = resolvePromptSubmit as
      | ((value: Response) => void)
      | null;
    if (releasePromptSubmit) {
      releasePromptSubmit(
        jsonResponse({
          status: 202,
          body: {
            success: true,
            data: {
              status: "in_progress",
              updatedAt: "2026-03-07T00:00:02.000Z",
              lastError: null,
              requiresTerminalAction: false,
              canPrompt: true,
              pendingPrompt: null,
            },
          },
        }) as Response
      );
    }
  });

  it("keeps async continue steps in loading state and blocks prompt interaction until the next auth step arrives", async () => {
    let authStatusCount = 0;
    let releaseAuthRespond: ((value: Response) => void) | null = null;
    const authRespondPromise = new Promise<Response>((resolve) => {
      releaseAuthRespond = resolve;
    });

    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();

      if (method === "GET" && url === "/api/apps") {
        return jsonResponse({ status: 200, body: { success: true, data: [] } });
      }
      if (method === "GET" && url.startsWith("/api/aso/keywords?")) {
        return jsonResponse({
          status: 200,
          body: { success: true, data: emptyKeywordPagedPayload() },
        });
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
        authStatusCount += 1;
        if (authStatusCount <= 2) {
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
                pendingPrompt: {
                  kind: "two_factor_method",
                  title: "Choose Verification Method",
                  message: "Select how to receive your code.",
                  choices: [
                    { value: "sms", label: "Text message" },
                    { value: "device", label: "Trusted device" },
                  ],
                },
              },
            },
          });
        }
        return jsonResponse({
          status: 200,
          body: {
            success: true,
            data: {
              status: "in_progress",
              updatedAt: "2026-03-07T00:00:03.000Z",
              lastError: null,
              requiresTerminalAction: false,
              canPrompt: true,
              pendingPrompt: {
                kind: "trusted_phone",
                title: "Choose Phone Number",
                message: "Select the phone number to receive the code.",
                choices: [{ value: "phone-1", label: "••• ••11" }],
              },
            },
          },
        });
      }
      if (method === "POST" && url === "/api/aso/auth/respond") {
        return authRespondPromise;
      }

      throw new Error(`Unhandled fetch: ${method} ${url}`);
    });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    const input = await screen.findByPlaceholderText("Add keywords (comma-separated)");
    fireEvent.change(input, { target: { value: "term" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Keywords" }));

    await screen.findByRole("heading", { name: "Choose Verification Method" });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const loadingButton = await screen.findByRole("button", {
      name: "Sending Code...",
    });
    expect(loadingButton).toBeDisabled();
    expect(document.querySelector(".aso-prompt-fieldset")).toBeDisabled();

    const resolveAuthRespond = releaseAuthRespond as ((value: Response) => void) | null;
    resolveAuthRespond?.(
      jsonResponse({
        status: 202,
        body: {
          success: true,
          data: {
            status: "in_progress",
            updatedAt: "2026-03-07T00:00:02.000Z",
            lastError: null,
            requiresTerminalAction: false,
            canPrompt: true,
            pendingPrompt: null,
          },
        },
      }) as Response
    );

    expect(await screen.findByRole("heading", { name: "Choose Phone Number" })).toBeInTheDocument();
  });

  it("surfaces startup refresh auth failures and resumes the refresh after reauthentication", async () => {
    let refreshStatusCount = 0;
    let refreshStartCount = 0;
    let authStartCount = 0;

    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();

      if (method === "GET" && url === "/api/apps") {
        return jsonResponse({ status: 200, body: { success: true, data: [] } });
      }
      if (method === "GET" && url.startsWith("/api/aso/keywords?")) {
        return jsonResponse({
          status: 200,
          body: { success: true, data: emptyKeywordPagedPayload() },
        });
      }
      if (method === "GET" && url === "/api/aso/refresh-status") {
        refreshStatusCount += 1;
        if (refreshStatusCount === 1) {
          return jsonResponse({
            status: 200,
            body: {
              success: true,
              data: {
                status: "failed",
                startedAt: "2026-03-07T00:00:00.000Z",
                finishedAt: "2026-03-07T00:00:10.000Z",
                lastError:
                  "Apple Search Ads session expired. Reauthentication is required.",
                requiresReauthentication: true,
                counters: {
                  eligibleKeywordCount: 1086,
                  refreshedKeywordCount: 0,
                  failedKeywordCount: 1086,
                },
              },
            },
          });
        }
        return jsonResponse({
          status: 200,
          body: {
            success: true,
            data: {
              status: "running",
              startedAt: "2026-03-07T00:00:20.000Z",
              finishedAt: null,
              lastError: null,
              requiresReauthentication: false,
              counters: {
                eligibleKeywordCount: 1086,
                refreshedKeywordCount: 0,
                failedKeywordCount: 0,
              },
            },
          },
        });
      }
      if (method === "POST" && url === "/api/aso/auth/start") {
        authStartCount += 1;
        return jsonResponse({
          status: 202,
          body: {
            success: true,
            data: {
              status: "in_progress",
              updatedAt: "2026-03-07T00:00:11.000Z",
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
              status: "succeeded",
              updatedAt: "2026-03-07T00:00:12.000Z",
              lastError: null,
              requiresTerminalAction: false,
              canPrompt: true,
            },
          },
        });
      }
      if (method === "POST" && url === "/api/aso/refresh/start") {
        refreshStartCount += 1;
        return jsonResponse({
          status: 202,
          body: {
            success: true,
            data: {
              status: "running",
              startedAt: "2026-03-07T00:00:20.000Z",
              finishedAt: null,
              lastError: null,
              requiresReauthentication: false,
              counters: {
                eligibleKeywordCount: 1086,
                refreshedKeywordCount: 0,
                failedKeywordCount: 0,
              },
            },
          },
        });
      }

      throw new Error(`Unhandled fetch: ${method} ${url}`);
    });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    expect(
      await screen.findByText(
        "Checking Apple session for background refresh after 0/1086 keywords..."
      )
    ).toBeInTheDocument();

    await waitFor(() => expect(authStartCount).toBe(1));
    await waitFor(() => expect(refreshStartCount).toBe(1));
    expect(
      await screen.findByText(
        "Refreshing local data in background (0/1086 keywords)..."
      )
    ).toBeInTheDocument();
  });

  it("auto-starts startup refresh reauthentication and shows browser auth prompts when input is required", async () => {
    let authStartCount = 0;

    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();

      if (method === "GET" && url === "/api/apps") {
        return jsonResponse({ status: 200, body: { success: true, data: [] } });
      }
      if (method === "GET" && url.startsWith("/api/aso/keywords?")) {
        return jsonResponse({
          status: 200,
          body: { success: true, data: emptyKeywordPagedPayload() },
        });
      }
      if (method === "GET" && url === "/api/aso/refresh-status") {
        return jsonResponse({
          status: 200,
          body: {
            success: true,
            data: {
              status: "failed",
              startedAt: "2026-03-07T00:00:00.000Z",
              finishedAt: "2026-03-07T00:00:10.000Z",
              lastError:
                "Apple Search Ads session expired. Reauthentication is required.",
              requiresReauthentication: true,
              counters: {
                eligibleKeywordCount: 1086,
                refreshedKeywordCount: 0,
                failedKeywordCount: 1086,
              },
            },
          },
        });
      }
      if (method === "POST" && url === "/api/aso/auth/start") {
        authStartCount += 1;
        return jsonResponse({
          status: 202,
          body: {
            success: true,
            data: {
              status: "in_progress",
              updatedAt: "2026-03-07T00:00:11.000Z",
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
              updatedAt: "2026-03-07T00:00:12.000Z",
              lastError: null,
              requiresTerminalAction: false,
              canPrompt: true,
              pendingPrompt: {
                kind: "apple_credentials",
                title: "Apple Sign In",
                message: "Enter your Apple ID and password to continue.",
              },
            },
          },
        });
      }

      throw new Error(`Unhandled fetch: ${method} ${url}`);
    });
    global.fetch = fetchMock as typeof fetch;

    render(<App />);

    await waitFor(() => expect(authStartCount).toBe(1));
    await screen.findByRole("heading", { name: "Apple Sign In" });
    expect(
      screen.getByText("Enter your Apple ID and password to continue.")
    ).toBeInTheDocument();
  });

  it("reopens Primary App ID setup when add-keywords fails because the current app id is inaccessible", async () => {
    const primaryAppError =
      "Current Primary App ID is not accessible for this Apple Ads account. Choose a different Primary App ID and retry.";
    let setupStartCount = 0;

    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();

      if (method === "GET" && url === "/api/apps") {
        return jsonResponse({ status: 200, body: { success: true, data: [] } });
      }
      if (method === "GET" && url.startsWith("/api/aso/keywords?")) {
        return jsonResponse({
          status: 200,
          body: { success: true, data: emptyKeywordPagedPayload() },
        });
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
      if (method === "GET" && url === "/api/aso/setup/status") {
        return jsonResponse({
          status: 200,
          body: {
            success: true,
            data: {
              status: setupStartCount > 0 ? "in_progress" : "idle",
              updatedAt: "2026-04-29T08:00:00.000Z",
              lastError: null,
              canPrompt: true,
              isRequired: setupStartCount > 0,
              pendingPrompt:
                setupStartCount > 0
                  ? {
                      kind: "primary_app_id",
                      title: "Primary App ID Required",
                      message:
                        "Enter a Primary App ID that your Apple Search Ads account can access.",
                      placeholder: "1234567890",
                    }
                  : null,
            },
          },
        });
      }
      if (method === "POST" && url === "/api/aso/keywords") {
        return jsonResponse({
          status: 403,
          body: {
            success: false,
            errorCode: "PRIMARY_APP_ID_RECONFIGURE_REQUIRED",
            error: primaryAppError,
          },
        });
      }
      if (method === "POST" && url === "/api/aso/setup/start?force=1") {
        setupStartCount += 1;
        return jsonResponse({
          status: 202,
          body: {
            success: true,
            data: {
              status: "in_progress",
              updatedAt: "2026-04-29T08:00:02.000Z",
              lastError: null,
              canPrompt: true,
              isRequired: true,
              pendingPrompt: {
                kind: "primary_app_id",
                title: "Primary App ID Required",
                message:
                  "Enter a Primary App ID that your Apple Search Ads account can access.",
                placeholder: "1234567890",
              },
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

    expect(
      await screen.findByRole("heading", { name: "Primary App ID Required" })
    ).toBeInTheDocument();
    expect(await screen.findByText(primaryAppError)).toBeInTheDocument();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/aso/setup/start?force=1",
        expect.objectContaining({
          method: "POST",
        })
      )
    );
  });

  it("shows reauthenticate button after auth status fails and allows restarting auth", async () => {
    let authStartCount = 0;
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();

      if (method === "GET" && url === "/api/apps") {
        return jsonResponse({ status: 200, body: { success: true, data: [] } });
      }
      if (method === "GET" && url.startsWith("/api/aso/keywords?")) {
        return jsonResponse({
          status: 200,
          body: { success: true, data: emptyKeywordPagedPayload() },
        });
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
        authStartCount += 1;
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
              status: "failed",
              updatedAt: "2026-03-07T00:00:01.000Z",
              lastError: "Apple rejected the session.",
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

    const reauthButton = await screen.findByRole("button", { name: "Reauthenticate" });
    fireEvent.click(reauthButton);

    await waitFor(() => expect(authStartCount).toBeGreaterThanOrEqual(2));
    expect(await screen.findByText("Apple rejected the session.")).toBeInTheDocument();
  });
});
