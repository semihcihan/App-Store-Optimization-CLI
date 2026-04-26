import fs from "fs";
import os from "os";
import path from "path";
import { version } from "../../../package.json";

jest.mock("../../shared/telemetry/posthog-shared", () => ({
  getPostHogClient: jest.fn(),
}));

import { getPostHogClient } from "../../shared/telemetry/posthog-shared";
import {
  getOrCreatePostHogUserId,
  shutdownPostHog,
  trackCliStarted,
} from "./posthog-usage-tracking";

describe("posthog usage tracking", () => {
  const mockedGetPostHogClient = jest.mocked(getPostHogClient);
  const tempDirs: string[] = [];

  afterEach(() => {
    mockedGetPostHogClient.mockReset();
    for (const dirPath of tempDirs) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  function createTempConfigPath(): string {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aso-posthog-test-"));
    tempDirs.push(tempDir);
    return path.join(tempDir, ".aso", "config.json");
  }

  it("creates and persists a stable user id when config is missing", () => {
    const configPath = createTempConfigPath();

    const userId = getOrCreatePostHogUserId(configPath);

    expect(userId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    const payload = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      userId: string;
    };
    expect(payload.userId).toBe(userId);
  });

  it("reuses the persisted user id from config", () => {
    const configPath = createTempConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ userId: "existing-user-id", other: "value" }),
      "utf8"
    );

    const userId = getOrCreatePostHogUserId(configPath);

    expect(userId).toBe("existing-user-id");
    const payload = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      userId: string;
      other: string;
    };
    expect(payload).toEqual({
      userId: "existing-user-id",
      other: "value",
    });
  });

  it("tracks cli_started with identify and first/last seen properties", () => {
    const identify = jest.fn();
    const capture = jest.fn();
    mockedGetPostHogClient.mockReturnValue({
      identify,
      capture,
    } as any);

    trackCliStarted({
      distinctId: "test-user-id",
      command: "keywords",
      now: new Date("2026-04-26T08:00:00.000Z"),
    });

    expect(identify).toHaveBeenCalledWith({
      distinctId: "test-user-id",
      properties: {
        cli_version: version,
        node_version: process.version,
        command: "keywords",
      },
    });
    expect(capture).toHaveBeenCalledWith({
      distinctId: "test-user-id",
      event: "cli_started",
      properties: {
        $set_once: {
          first_seen_at: "2026-04-26T08:00:00.000Z",
        },
        $set: {
          last_seen_at: "2026-04-26T08:00:00.000Z",
          cli_version: version,
          node_version: process.version,
          command: "keywords",
        },
      },
    });
  });

  it("shuts down posthog before process exit", async () => {
    const shutdown = jest.fn().mockResolvedValue(undefined);
    mockedGetPostHogClient.mockReturnValue({
      shutdown,
    } as any);

    await shutdownPostHog(1234);

    expect(shutdown).toHaveBeenCalledWith(1234);
  });

  it("ignores posthog shutdown errors", async () => {
    const shutdown = jest.fn(() => {
      throw new Error("shutdown failed");
    });
    mockedGetPostHogClient.mockReturnValue({
      shutdown,
    } as any);

    await expect(shutdownPostHog()).resolves.toBeUndefined();
  });
});
