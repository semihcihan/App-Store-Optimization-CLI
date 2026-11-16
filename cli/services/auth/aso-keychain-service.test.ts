import { jest } from "@jest/globals";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import { AsoKeychainService } from "./aso-keychain-service";

jest.mock("child_process", () => ({
  execFileSync: jest.fn(),
}));

describe("AsoKeychainService", () => {
  const mockExecFileSync = jest.mocked(execFileSync);
  const service = new AsoKeychainService();

  beforeEach(() => {
    mockExecFileSync.mockReset();
    jest.spyOn(os, "platform").mockReturnValue("darwin");
    jest.spyOn(fs, "existsSync").mockReturnValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    { platform: "win32", hasSecurity: true },
    { platform: "linux", hasSecurity: true },
    { platform: "darwin", hasSecurity: false },
  ] as const)("skips Keychain on $platform with security present=$hasSecurity", ({
    platform,
    hasSecurity,
  }) => {
    jest.mocked(os.platform).mockReturnValue(platform);
    jest.mocked(fs.existsSync).mockReturnValue(hasSecurity);

    expect(service.isAvailable()).toBe(false);
    expect(service.loadCredentials()).toBeNull();
    service.saveCredentials({ appleId: "user@example.com", password: "pw" });
    service.clearCredentials();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("loads credentials from keychain when payload is valid", () => {
    mockExecFileSync.mockReturnValue(
      JSON.stringify({ appleId: "user@example.com", password: "pw" }) as any
    );

    const credentials = service.loadCredentials();

    expect(credentials).toEqual({
      appleId: "user@example.com",
      password: "pw",
    });
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-s",
        "aso.cli.apple",
        "-a",
        "default",
        "-w",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
  });

  it("returns null when payload is malformed or missing fields", () => {
    mockExecFileSync.mockReturnValue("{}" as any);
    expect(service.loadCredentials()).toBeNull();

    mockExecFileSync.mockReturnValue("not-json" as any);
    expect(service.loadCredentials()).toBeNull();
  });

  it("returns null when keychain lookup fails", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });

    expect(service.loadCredentials()).toBeNull();
  });

  it("saves credentials to keychain", () => {
    mockExecFileSync.mockReturnValue("" as any);

    service.saveCredentials({
      appleId: "user@example.com",
      password: "pw",
    });

    expect(mockExecFileSync).toHaveBeenCalledWith(
      "/usr/bin/security",
      [
        "add-generic-password",
        "-U",
        "-s",
        "aso.cli.apple",
        "-a",
        "default",
        "-w",
        JSON.stringify({ appleId: "user@example.com", password: "pw" }),
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
  });

  it("swallows clear errors", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("delete failed");
    });

    expect(() => service.clearCredentials()).not.toThrow();
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "/usr/bin/security",
      [
        "delete-generic-password",
        "-s",
        "aso.cli.apple",
        "-a",
        "default",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
  });
});
