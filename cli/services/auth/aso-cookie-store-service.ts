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
      return payload.cookies;
    } catch {
      return [];
    }
  }

  saveCookies(cookies: StoredCookie[]): void {
    const dir = path.dirname(this.cookiePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const payload: CookieStorePayload = {
      cookies,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(this.cookiePath, JSON.stringify(payload, null, 2), "utf8");
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
