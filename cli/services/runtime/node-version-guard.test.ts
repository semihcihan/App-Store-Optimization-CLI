import { assertSupportedNodeVersion } from "./node-version-guard";

describe("assertSupportedNodeVersion", () => {
  it("does not throw for supported versions", () => {
    expect(() => assertSupportedNodeVersion("v18.0.0")).not.toThrow();
    expect(() => assertSupportedNodeVersion("v20.19.5")).not.toThrow();
    expect(() => assertSupportedNodeVersion("v22.12.0")).not.toThrow();
  });

  it("throws for versions below the minimum", () => {
    expect(() => assertSupportedNodeVersion("v14.17.0")).toThrow(
      /requires Node\.js >= 18\.0\.0/i
    );
    expect(() => assertSupportedNodeVersion("v16.20.2")).toThrow(
      /requires Node\.js >= 18\.0\.0/i
    );
  });
});
