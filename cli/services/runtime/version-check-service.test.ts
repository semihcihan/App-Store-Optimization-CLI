import { jest } from "@jest/globals";
import axios from "axios";
import fs from "fs";
import path from "path";
import os from "os";
import { checkVersionUpdateSync } from "./version-check-service";

jest.mock("axios");
jest.mock("fs");
jest.mock("path");
jest.mock("os");
jest.mock("../../../package.json", () => ({
  version: "0.0.19",
  name: "app-store-optimization-cli",
}));

const mockAxios = jest.mocked(axios);
const mockFs = jest.mocked(fs);
const mockPath = jest.mocked(path);
const mockOs = jest.mocked(os);

const mockCacheDir = "/home/user/.aso";
const mockCacheFile = "/home/user/.aso/version-cache.json";

describe("version-check-service", () => {
  let originalConsoleLog: typeof console.log;

  beforeEach(() => {
    jest.clearAllMocks();
    originalConsoleLog = console.log;
    console.log = jest.fn();

    mockOs.homedir.mockReturnValue("/home/user");
    mockPath.join.mockImplementation((...args) => {
      if (args.includes("version-cache.json")) {
        return mockCacheFile;
      }
      return args.join("/");
    });
    mockPath.dirname.mockReturnValue(mockCacheDir);
  });

  afterEach(() => {
    console.log = originalConsoleLog;
  });

  describe("checkVersionUpdateSync", () => {
    it("should not display message when cache is empty", () => {
      mockFs.existsSync.mockReturnValue(false);

      checkVersionUpdateSync();

      expect(console.log).not.toHaveBeenCalled();
    });

    it("should display message when newer version is available in cache", () => {
      const cache = {
        latestVersion: "0.0.20",
        lastCheckDate: new Date().toISOString(),
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(cache));

      checkVersionUpdateSync();

      expect(console.log).toHaveBeenCalled();
      const message = (console.log as jest.Mock).mock.calls[0][0];
      expect(message).toContain("0.0.19");
      expect(message).toContain("0.0.20");
      expect(message).toContain("Update available");
    });

    it("should not display message when current version is up to date", () => {
      const cache = {
        latestVersion: "0.0.19",
        lastCheckDate: new Date().toISOString(),
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(cache));

      checkVersionUpdateSync();

      expect(console.log).not.toHaveBeenCalled();
    });

    it("should not display message when cache indicates newer version but CLI was already updated to that version", () => {
      const cache = {
        latestVersion: "0.0.19",
        lastCheckDate: new Date().toISOString(),
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(cache));

      checkVersionUpdateSync();

      expect(console.log).not.toHaveBeenCalled();
    });

    it("should not display message when current version is newer than cached", () => {
      const cache = {
        latestVersion: "0.0.18",
        lastCheckDate: new Date().toISOString(),
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(cache));

      checkVersionUpdateSync();

      expect(console.log).not.toHaveBeenCalled();
    });

    it("should handle invalid cache file gracefully", () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue("invalid json");

      expect(() => checkVersionUpdateSync()).not.toThrow();
    });
  });

  describe("checkVersionUpdateSync - async behavior", () => {
    it("should trigger async update when cache is invalid", async () => {
      const oldCache = {
        latestVersion: "0.0.20",
        lastCheckDate: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(oldCache));

      mockAxios.get.mockResolvedValue({
        data: { version: "0.0.21" },
      });

      checkVersionUpdateSync();

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockAxios.get).toHaveBeenCalledWith(
        "https://registry.npmjs.org/app-store-optimization-cli/latest",
        { timeout: 3000 }
      );
    });

    it("should not fetch when cache is valid", async () => {
      const cache = {
        latestVersion: "0.0.20",
        lastCheckDate: new Date().toISOString(),
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(cache));

      checkVersionUpdateSync();

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockAxios.get).not.toHaveBeenCalled();
    });

    it("should fetch and save when cache is null", async () => {
      mockFs.existsSync.mockReturnValue(false);

      mockAxios.get.mockResolvedValue({
        data: { version: "0.0.21" },
      });

      checkVersionUpdateSync();

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockAxios.get).toHaveBeenCalled();
      expect(mockFs.writeFileSync).toHaveBeenCalled();
    });

    it("should handle fetch errors gracefully", async () => {
      mockFs.existsSync.mockReturnValue(false);
      mockAxios.get.mockRejectedValue(new Error("Network error"));

      expect(() => checkVersionUpdateSync()).not.toThrow();

      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    it("should handle missing version in response", async () => {
      mockFs.existsSync.mockReturnValue(false);
      mockAxios.get.mockResolvedValue({
        data: {},
      });

      checkVersionUpdateSync();

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockFs.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe("version comparison", () => {
    it("should correctly identify newer versions", () => {
      const cache = {
        latestVersion: "0.0.20",
        lastCheckDate: new Date().toISOString(),
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(cache));

      checkVersionUpdateSync();

      expect(console.log).toHaveBeenCalled();
    });

    it("should handle patch version updates", () => {
      const cache = {
        latestVersion: "0.0.20",
        lastCheckDate: new Date().toISOString(),
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(cache));

      checkVersionUpdateSync();

      expect(console.log).toHaveBeenCalled();
    });

    it("should handle minor version updates", () => {
      const cache = {
        latestVersion: "0.1.0",
        lastCheckDate: new Date().toISOString(),
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(cache));

      checkVersionUpdateSync();

      expect(console.log).toHaveBeenCalled();
    });

    it("should handle major version updates", () => {
      const cache = {
        latestVersion: "1.0.0",
        lastCheckDate: new Date().toISOString(),
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(cache));

      checkVersionUpdateSync();

      expect(console.log).toHaveBeenCalled();
    });
  });

  describe("cache validation", () => {
    it("should consider cache valid if less than 24 hours old", async () => {
      const cache = {
        latestVersion: "0.0.20",
        lastCheckDate: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(cache));

      checkVersionUpdateSync();

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockAxios.get).not.toHaveBeenCalled();
    });

    it("should consider cache invalid if more than 24 hours old", async () => {
      const cache = {
        latestVersion: "0.0.20",
        lastCheckDate: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(cache));

      mockAxios.get.mockResolvedValue({
        data: { version: "0.0.21" },
      });

      checkVersionUpdateSync();

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockAxios.get).toHaveBeenCalled();
    });

    it("should handle invalid date in cache", async () => {
      const cache = {
        latestVersion: "0.0.20",
        lastCheckDate: "invalid-date",
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(cache));

      mockAxios.get.mockResolvedValue({
        data: { version: "0.0.21" },
      });

      checkVersionUpdateSync();

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockAxios.get).toHaveBeenCalled();
    });
  });
});
