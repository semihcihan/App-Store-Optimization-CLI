import fs from "fs";
import os from "os";
import path from "path";

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

interface CookieStorePayload {
  cookies: StoredCookie[];
  updatedAt: string;
}

function isExpiredCookie(cookie: StoredCookie, nowSeconds: number): boolean {
  return cookie.expires > 0 && cookie.expires < nowSeconds;
}

function pruneExpiredCookies(cookies: StoredCookie[]): StoredCookie[] {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return cookies.filter((cookie) => !isExpiredCookie(cookie, nowSeconds));
}

export class AsoCookieStoreService {
  private readonly cookiePath = path.join(
    os.homedir(),
    ".aso",
    "aso-cookies.json"
  );

  loadCookies(): StoredCookie[] {
    try {
      if (!fs.existsSync(this.cookiePath)) {
        return [];
      }
      const payload = JSON.parse(
        fs.readFileSync(this.cookiePath, "utf8")
      ) as CookieStorePayload;
      if (!Array.isArray(payload.cookies)) {
        return [];
      }
      return pruneExpiredCookies(payload.cookies);
    } catch {
      return [];
    }
  }

  saveCookies(cookies: StoredCookie[]): void {
    const dir = path.dirname(this.cookiePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const sanitizedCookies = pruneExpiredCookies(cookies);
    const payload: CookieStorePayload = {
      cookies: sanitizedCookies,
      updatedAt: new Date().toISOString(),
    };
    const tempPath = `${this.cookiePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tempPath, this.cookiePath);
  }

  clearCookies(): void {
    try {
      if (fs.existsSync(this.cookiePath)) {
        fs.unlinkSync(this.cookiePath);
      }
    } catch {
      return;
    }
  }
}

export const asoCookieStoreService = new AsoCookieStoreService();
