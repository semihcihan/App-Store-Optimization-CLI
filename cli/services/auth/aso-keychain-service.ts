import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { platform } from "os";
import { logger } from "../../utils/logger";

const SECURITY_PATH = "/usr/bin/security";
const SERVICE_NAME = "aso.cli.apple";
const ACCOUNT_NAME = "default";

export interface AppleLoginCredentials {
  appleId: string;
  password: string;
}

function runSecurityCommand(args: string[]): string {
  return execFileSync(SECURITY_PATH, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export class AsoKeychainService {
  isAvailable(): boolean {
    return platform() === "darwin" && existsSync(SECURITY_PATH);
  }

  loadCredentials(): AppleLoginCredentials | null {
    if (!this.isAvailable()) return null;
    try {
      const raw = runSecurityCommand([
        "find-generic-password",
        "-s",
        SERVICE_NAME,
        "-a",
        ACCOUNT_NAME,
        "-w",
      ]);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as AppleLoginCredentials;
      if (!parsed.appleId || !parsed.password) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  saveCredentials(credentials: AppleLoginCredentials): void {
    try {
      if (!this.isAvailable()) return;
      runSecurityCommand([
        "add-generic-password",
        "-U",
        "-s",
        SERVICE_NAME,
        "-a",
        ACCOUNT_NAME,
        "-w",
        JSON.stringify(credentials),
      ]);
    } catch {
      logger.warn("Could not save Apple credentials to macOS Keychain.");
    }
  }

  clearCredentials(): void {
    if (!this.isAvailable()) return;
    try {
      runSecurityCommand([
        "delete-generic-password",
        "-s",
        SERVICE_NAME,
        "-a",
        ACCOUNT_NAME,
      ]);
    } catch {
      return;
    }
  }
}

export const asoKeychainService = new AsoKeychainService();
