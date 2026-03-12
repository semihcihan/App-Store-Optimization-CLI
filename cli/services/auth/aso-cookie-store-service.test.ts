import fs from "fs";
import path from "path";
import os from "os";
import { AsoCookieStoreService, type StoredCookie } from "./aso-cookie-store-service";

describe("AsoCookieStoreService", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("prunes expired cookies on save and load", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "aso-cookie-test-"));
    jest.spyOn(os, "homedir").mockReturnValue(tempHome);
    const service = new AsoCookieStoreService();
    const now = Math.floor(Date.now() / 1000);
    const cookies: StoredCookie[] = [
      {
        name: "valid",
        value: "1",
        domain: "app-ads.apple.com",
        path: "/",
        expires: now + 3600,
        httpOnly: true,
        secure: true,
      },
      {
        name: "expired",
        value: "2",
        domain: "app-ads.apple.com",
        path: "/",
        expires: now - 3600,
        httpOnly: true,
        secure: true,
      },
    ];

    service.saveCookies(cookies);
    const loaded = service.loadCookies();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe("valid");
  });
});
