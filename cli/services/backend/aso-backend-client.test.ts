import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { jest } from "@jest/globals";
import axios from "axios";
import { AsoBackendClient } from "./aso-backend-client";

jest.mock("axios");

describe("aso-backend-client", () => {
  const defaultBackendUrl =
    "https://aso-difficulty-api.umitsemihcihan.workers.dev";
  const mockedAxios = jest.mocked(axios);
  const originalEnv = process.env;
  const testHome = path.join(
    os.tmpdir(),
    `aso-backend-home-${process.pid}-${Date.now()}`
  );

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.ASO_HOME_DIR = testHome;
    delete process.env.ASO_BACKEND_BASE_URL;
    delete process.env.ASO_CLIENT_ID;
  });

  afterEach(() => {
    process.env = originalEnv;
    fs.rmSync(testHome, { recursive: true, force: true });
  });

  it("returns allow-all default context when backend base url is not configured", async () => {
    const service = new AsoBackendClient();
    const context = await service.getContext();

    expect(context.entitlements.difficultyView).toBe(true);
    expect(context.entitlements.topApps).toBe(true);
  });

  it("uses default backend when backend url env is not configured", async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        difficultyScore: 37,
      },
    } as any);

    const service = new AsoBackendClient();
    const score = await service.scoreDifficulty({
      keyword: "term",
      country: "US",
      popularity: 50,
      appCount: 100,
      orderedAppIds: ["1", "2", "3"],
      appDocs: [],
    });

    expect(score).toEqual({
      difficultyScore: 37,
      difficultyState: "ready",
    });
    expect(mockedAxios.post).toHaveBeenCalledWith(
      `${defaultBackendUrl}/v1/aso/difficulty/score`,
      expect.any(Object),
      expect.any(Object)
    );
  });

  it("maps backend plan-required errors to paywalled result", async () => {
    process.env.ASO_BACKEND_BASE_URL = "https://paywall.example";
    mockedAxios.post.mockRejectedValueOnce({
      isAxiosError: true,
      response: {
        status: 403,
        data: {
          errorCode: "PLAN_REQUIRED",
          error: "Upgrade required.",
          upgradeUrl: "https://paywall.example/upgrade",
        },
      },
    } as any);

    const service = new AsoBackendClient();
    const result = await service.scoreDifficulty({
      keyword: "term",
      country: "US",
      popularity: 50,
      appCount: 100,
      orderedAppIds: ["1", "2", "3"],
      appDocs: [],
    });

    expect(result).toEqual(
      expect.objectContaining({
        difficultyScore: null,
        difficultyState: "paywalled",
        code: "PLAN_REQUIRED",
      })
    );
  });

  it("requires explicit errorCode for backend paywall mapping", async () => {
    process.env.ASO_BACKEND_BASE_URL = "https://paywall.example";
    const backendError = {
      isAxiosError: true,
      response: {
        status: 403,
        data: {
          message: "Upgrade required.",
        },
      },
    } as any;
    mockedAxios.post.mockRejectedValueOnce(backendError);

    const service = new AsoBackendClient();
    await expect(
      service.scoreDifficulty({
        keyword: "term",
        country: "US",
        popularity: 50,
        appCount: 100,
        orderedAppIds: ["1", "2", "3"],
        appDocs: [],
      })
    ).rejects.toEqual(backendError);
  });

  it("ignores nested legacy error objects without top-level errorCode", async () => {
    process.env.ASO_BACKEND_BASE_URL = "https://paywall.example";
    const backendError = {
      isAxiosError: true,
      response: {
        status: 403,
        data: {
          error: {
            code: "PLAN_REQUIRED",
            message: "Upgrade required.",
          },
        },
      },
    } as any;
    mockedAxios.post.mockRejectedValueOnce(backendError);

    const service = new AsoBackendClient();
    await expect(
      service.scoreDifficulty({
        keyword: "term",
        country: "US",
        popularity: 50,
        appCount: 100,
        orderedAppIds: ["1", "2", "3"],
        appDocs: [],
      })
    ).rejects.toEqual(backendError);
  });

  it("accepts only canonical score fields from backend response", async () => {
    process.env.ASO_BACKEND_BASE_URL = "https://paywall.example";
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        difficulty: 22,
        minDifficulty: 10,
        data: {
          difficultyScore: 44,
        },
      },
    } as any);

    const service = new AsoBackendClient();
    const result = await service.scoreDifficulty({
      keyword: "term",
      country: "US",
      popularity: 50,
      appCount: 100,
      orderedAppIds: ["1", "2", "3"],
      appDocs: [],
    });

    expect(result).toEqual(
      expect.objectContaining({
        difficultyScore: null,
        difficultyState: "paywalled",
        code: "ENTITLEMENT_UNAVAILABLE",
      })
    );
  });

  it("accepts only canonical entitlement keys from context response", async () => {
    process.env.ASO_BACKEND_BASE_URL = "https://paywall.example";
    mockedAxios.get.mockResolvedValueOnce({
      status: 200,
      data: {
        entitlements: {
          difficulty_view: true,
          top_apps: true,
        },
        features: {
          difficulty: true,
          top_apps: true,
        },
      },
    } as any);

    const service = new AsoBackendClient();
    const context = await service.getContext({ forceRefresh: true });

    expect(context.entitlements).toEqual({
      difficultyView: false,
      topApps: false,
    });
  });

  it("sends anonymous client id header without user action", async () => {
    process.env.ASO_BACKEND_BASE_URL = "https://paywall.example";
    process.env.ASO_CLIENT_ID = "client-123";
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        difficultyScore: 42,
      },
    } as any);

    const service = new AsoBackendClient();
    await service.scoreDifficulty({
      keyword: "term",
      country: "US",
      popularity: 50,
      appCount: 100,
      orderedAppIds: ["1", "2", "3"],
      appDocs: [],
    });

    expect(mockedAxios.post).toHaveBeenCalledWith(
      "https://paywall.example/v1/aso/difficulty/score",
      expect.any(Object),
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-aso-client-id": "client-123",
        }),
      })
    );
  });
});
