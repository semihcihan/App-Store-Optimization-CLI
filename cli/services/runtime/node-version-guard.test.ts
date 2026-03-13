import { assertSupportedNodeVersion } from "./node-version-guard";

describe("assertSupportedNodeVersion", () => {
  it("does not throw for supported versions", () => {
    expect(() => assertSupportedNodeVersion("v20.18.1")).not.toThrow();
    expect(() => assertSupportedNodeVersion("v20.19.5")).not.toThrow();
    expect(() => assertSupportedNodeVersion("v22.12.0")).not.toThrow();
  });

  it("throws for versions below the minimum", () => {
    expect(() => assertSupportedNodeVersion("v18.17.0")).toThrow(
      /requires Node\.js >= 20\.18\.1/i
    );
    expect(() => assertSupportedNodeVersion("v20.18.0")).toThrow(
      /requires Node\.js >= 20\.18\.1/i
    );
  });
});
