import { z } from "zod";
import { DEFAULT_LOG_LEVEL, logger, processNestedErrors } from "./logger";

describe("logger utilities", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    logger.setOutputModes([{ mode: "console", showErrorStack: false }]);
    logger.setLevel("info");
  });

  it("processes nested error trees and circular structures", () => {
    const inner = new Error("inner");
    const outer = new Error("outer");
    (outer as any).context = { nested: inner };

    const processed = processNestedErrors(outer, false);
    expect(processed).toMatchObject({
      message: "outer",
      context: {
        nested: { message: "inner" },
      },
    });
    expect(processed.stack).toBeUndefined();

    const circular: any = { name: "node" };
    circular.self = circular;
    expect(processNestedErrors(circular, false)).toEqual({
      name: "node",
      self: "[Circular]",
    });
  });

  it("formats zod errors with user-facing validation messages", () => {
    let zodError: unknown;
    try {
      z.object({ id: z.string() }).parse({ id: 123 });
    } catch (error) {
      zodError = error;
    }

    const processed = processNestedErrors(zodError, false);
    expect(processed.message.toLowerCase()).toContain("validation");
  });

  it("supports level updates and invalid-level fallback", () => {
    logger.setLevel("debug");
    expect(logger.getLevel()).toBe("debug");

    logger.setLevel("invalid-level" as any);
    expect(logger.getLevel()).toBe(DEFAULT_LOG_LEVEL);
  });

  it("updates output modes and keeps only valid values", () => {
    logger.setOutputModes([{ mode: "json", showErrorStack: true }]);
    expect(logger.getOutputModes()).toEqual([
      { mode: "json", showErrorStack: true },
    ]);

    logger.setOutputModes([{ mode: "invalid", showErrorStack: true } as any]);
    expect(logger.getOutputModes()).toEqual([]);
  });

  it("writes std output for strings and objects", () => {
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    logger.std("plain");
    logger.std({ ok: true });

    expect(logSpy).toHaveBeenNthCalledWith(1, "plain");
    expect(logSpy).toHaveBeenNthCalledWith(2, JSON.stringify({ ok: true }, null, 2));
  });
});
