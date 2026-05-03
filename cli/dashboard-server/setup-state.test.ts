import { jest } from "@jest/globals";
import { createDashboardSetupStateManager } from "./setup-state";

describe("dashboard setup state manager", () => {
  it("supports forced setup even when setup is not otherwise required", async () => {
    let receivedForcePrompt: boolean | undefined;

    const manager = createDashboardSetupStateManager({
      isSetupRequired: () => false,
      resolvePrimaryAppId: async (options) => {
        receivedForcePrompt = options?.forcePrompt;
        return "1234567890";
      },
      onError: jest.fn(),
    });

    expect(manager.start()).toBe(false);
    expect(manager.start({ forcePrompt: true })).toBe(true);
    expect(manager.getState()).toEqual(
      expect.objectContaining({
        status: "in_progress",
        isRequired: true,
      })
    );

    await new Promise((resolve) => setImmediate(resolve));

    expect(receivedForcePrompt).toBe(true);
    expect(manager.getState()).toEqual(
      expect.objectContaining({
        status: "succeeded",
        isRequired: false,
      })
    );
  });

  it("retries failed forced setup without losing forced prompt mode", async () => {
    const receivedForcePrompts: Array<boolean | undefined> = [];
    let attempts = 0;

    const manager = createDashboardSetupStateManager({
      isSetupRequired: () => false,
      resolvePrimaryAppId: async (options) => {
        receivedForcePrompts.push(options?.forcePrompt);
        attempts += 1;
        if (attempts === 1) {
          throw new Error("Primary App ID is not accessible.");
        }
        return "1234567890";
      },
      onError: jest.fn(),
    });

    expect(manager.start({ forcePrompt: true })).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));

    expect(manager.getState()).toEqual(
      expect.objectContaining({
        status: "failed",
        isRequired: true,
        lastError: "Primary App ID is not accessible.",
      })
    );

    expect(manager.start()).toBe(true);
    expect(manager.getState()).toEqual(
      expect.objectContaining({
        status: "in_progress",
        isRequired: true,
      })
    );

    await new Promise((resolve) => setImmediate(resolve));

    expect(receivedForcePrompts).toEqual([true, true]);
    expect(manager.getState()).toEqual(
      expect.objectContaining({
        status: "succeeded",
        isRequired: false,
      })
    );
  });
});
