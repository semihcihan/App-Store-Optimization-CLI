import axios from "axios";
import fs from "fs";
import path from "path";
import os from "os";
import packageJson from "../../../package.json";
import { boxifyMessage } from "./format-helper";
import { compareVersions } from "../../utils/version";

const NPM_REGISTRY_URL = "https://registry.npmjs.org";
const CHECK_TIMEOUT = 3000;
const CACHE_FILE = path.join(
  os.homedir(),
  ".aso",
  "version-cache.json"
);
const ONE_DAY_MS = 24 * 60 * 60 * 1000; // during beta testing, we will check every day

interface VersionCache {
  latestVersion: string;
  lastCheckDate: string;
}

function loadCache(): VersionCache | null {
  try {
    if (!fs.existsSync(CACHE_FILE)) {
      return null;
    }

    const content = fs.readFileSync(CACHE_FILE, "utf8");
    return JSON.parse(content) as VersionCache;
  } catch (error) {
    return null;
  }
}

function saveCache(cache: VersionCache): void {
  try {
    const cacheDir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
  } catch (error) {
    // Silently fail
  }
}

function isCacheValid(cache: VersionCache | null): boolean {
  if (!cache) {
    return false;
  }

  try {
    const lastCheckDate = new Date(cache.lastCheckDate);
    const now = new Date();
    const diffMs = now.getTime() - lastCheckDate.getTime();

    return diffMs < ONE_DAY_MS;
  } catch (error) {
    return false;
  }
}

function shouldShowUpdateMessage(
  currentVersion: string,
  latestVersion: string
): boolean {
  return compareVersions(currentVersion, latestVersion) < 0;
}

function displayUpdateMessage(
  packageName: string,
  currentVersion: string,
  latestVersion: string
): void {
  const lightGray = "\x1b[90m";
  const green = "\x1b[32m";
  const reset = "\x1b[0m";

  const lines = [
    `Update available ${lightGray}${currentVersion}${reset} -> ${green}${latestVersion}${reset}`,
    `Run ${green}npm install -g ${packageName}@latest${reset} to update`,
  ];

  const message = boxifyMessage(lines);
  console.log(message);
}

async function fetchLatestVersion(packageName: string): Promise<string | null> {
  try {
    const response = await axios.get(
      `${NPM_REGISTRY_URL}/${packageName}/latest`,
      {
        timeout: CHECK_TIMEOUT,
      }
    );
    return response.data.version || null;
  } catch (error) {
    return null;
  }
}

export function checkVersionUpdateSync(): void {
  const currentVersion = packageJson.version;
  const packageName = packageJson.name;

  const cache = loadCache();

  if (cache && shouldShowUpdateMessage(currentVersion, cache.latestVersion)) {
    displayUpdateMessage(packageName, currentVersion, cache.latestVersion);
  }

  checkVersionUpdateAsync(cache);
}

async function checkVersionUpdateAsync(
  cache: VersionCache | null
): Promise<void> {
  if (cache && isCacheValid(cache)) {
    return;
  }

  try {
    const packageName = packageJson.name;
    const latestVersion = await fetchLatestVersion(packageName);

    if (!latestVersion) {
      return;
    }

    const cacheToSave: VersionCache = {
      latestVersion,
      lastCheckDate: new Date().toISOString(),
    };

    saveCache(cacheToSave);
  } catch (error) {
    // Silently fail - don't interrupt the user's workflow
  }
}
