import fs from "fs";
import os from "os";
import path from "path";

const ASO_CONFIG_PATH = path.join(os.homedir(), ".aso", "config.json");
const configCache = new Map<string, AsoConfig>();

export type AsoConfig = Record<string, unknown>;

function normalizeConfigPath(configPath: string): string {
  return path.resolve(configPath);
}

function cloneConfig(config: AsoConfig): AsoConfig {
  return { ...config };
}

export function readAsoConfig(configPath = ASO_CONFIG_PATH): AsoConfig {
  const resolvedPath = normalizeConfigPath(configPath);
  const cached = configCache.get(resolvedPath);
  if (cached) {
    return cloneConfig(cached);
  }

  let loadedConfig: AsoConfig = {};

  try {
    if (fs.existsSync(resolvedPath)) {
      const raw = fs.readFileSync(resolvedPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        loadedConfig = parsed as AsoConfig;
      }
    }
  } catch {
    loadedConfig = {};
  }

  configCache.set(resolvedPath, cloneConfig(loadedConfig));
  return cloneConfig(loadedConfig);
}

export function writeAsoConfig(
  config: AsoConfig,
  configPath = ASO_CONFIG_PATH
): void {
  const resolvedPath = normalizeConfigPath(configPath);
  const dirPath = path.dirname(resolvedPath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }

  const tempPath = `${resolvedPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(config, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tempPath, resolvedPath);
  configCache.set(resolvedPath, cloneConfig(config));
}
