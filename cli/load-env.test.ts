jest.mock("dotenv", () => ({
  config: jest.fn(),
}));

describe("load-env", () => {
  const originalSilent = process.env.DOTENV_CONFIG_SILENT;

  afterEach(() => {
    process.env.DOTENV_CONFIG_SILENT = originalSilent;
    jest.resetModules();
    jest.clearAllMocks();
  });

  it("enables silent dotenv mode and loads default + root env files", async () => {
    const dotenv = await import("dotenv");

    await import("./load-env");

    expect(process.env.DOTENV_CONFIG_SILENT).toBe("true");
    expect(dotenv.config).toHaveBeenCalledTimes(2);
    expect(dotenv.config).toHaveBeenNthCalledWith(1);
    expect(dotenv.config).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        path: expect.stringContaining(".env"),
      })
    );
  });
});
