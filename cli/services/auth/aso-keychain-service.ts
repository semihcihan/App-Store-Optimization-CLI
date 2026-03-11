import { execFileSync } from "child_process";

const SERVICE_NAME = "aso.cli.apple";
const ACCOUNT_NAME = "default";

export interface AppleLoginCredentials {
  appleId: string;
  password: string;
}

function runSecurityCommand(args: string[]): string {
  return execFileSync("security", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export class AsoKeychainService {
  loadCredentials(): AppleLoginCredentials | null {
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
  }

  clearCredentials(): void {
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
