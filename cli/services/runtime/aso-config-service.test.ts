import fs from "fs";
import os from "os";
import path from "path";
import { readAsoConfig, writeAsoConfig } from "./aso-config-service";

describe("aso config service", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    jest.restoreAllMocks();
    for (const dirPath of tempDirs) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  function createTempConfigPath(): string {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aso-config-test-"));
    tempDirs.push(tempDir);
    return path.join(tempDir, ".aso", "config.json");
  }

  it("returns empty config when file does not exist", () => {
    const configPath = createTempConfigPath();

    expect(readAsoConfig(configPath)).toEqual({});
  });

  it("writes and reads config values", () => {
    const configPath = createTempConfigPath();

    writeAsoConfig(
      {
        userId: "user-1",
        featureFlag: true,
      },
      configPath
    );

    expect(readAsoConfig(configPath)).toEqual({
      userId: "user-1",
      featureFlag: true,
    });
  });

  it("returns empty config for invalid json", () => {
    const configPath = createTempConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "{ invalid", "utf8");

    expect(readAsoConfig(configPath)).toEqual({});
  });

  it("serves repeated reads from in-memory cache", () => {
    const configPath = createTempConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ userId: "first-user" }), "utf8");
    const readSpy = jest.spyOn(fs, "readFileSync");

    const firstRead = readAsoConfig(configPath);
    fs.writeFileSync(configPath, JSON.stringify({ userId: "second-user" }), "utf8");
    const secondRead = readAsoConfig(configPath);

    expect(firstRead).toEqual({ userId: "first-user" });
    expect(secondRead).toEqual({ userId: "first-user" });
    expect(readSpy).toHaveBeenCalledTimes(1);
  });

  it("updates cache on write and protects cached state from caller mutation", () => {
    const configPath = createTempConfigPath();
    const readSpy = jest.spyOn(fs, "readFileSync");

    writeAsoConfig({ userId: "cached-user" }, configPath);
    const firstRead = readAsoConfig(configPath);
    firstRead.userId = "mutated-by-caller";
    const secondRead = readAsoConfig(configPath);

    expect(readSpy).not.toHaveBeenCalled();
    expect(secondRead).toEqual({ userId: "cached-user" });
  });
});
